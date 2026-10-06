import { AppConfig, Region } from '../types';
import { compressImageToTargetSize, releaseObjectURL, urlToBase64 } from './imageUtils';
import { globalRateLimitGate, isRateLimitError, parseRetryAfter } from './rateLimitGate';
import { recordPayload, PayloadTransform } from './payloadLog';
import { buildFontChoicePrompt, resolveFontIdFromAi } from './fontService';

/**
 * Editor auto-translation (whole-image, one vision-AI call).
 *
 * The full image is annotated with numbered boxes — one per editable editor
 * region (contextOnly bubbles excluded) — and sent to the configured
 * OpenAI-compatible vision endpoint together with a JSON skeleton. The model
 * returns per-region source text (the recognized original) + Simplified
 * Chinese translation for EVERY text-bearing region; regions flagged freeze (sfx /
 * stylized lettering / text over complex backgrounds) get their translation
 * stored as frozen text instead of being typeset into the image.
 */

export interface RegionTranslation {
  /** Recognized original text. */
  source?: string;
  /** Simplified Chinese translation. */
  zh?: string;
  /** True = translation is held back from the image (翻译冻结): sfx /
   *  stylized lettering / text over complex backgrounds that plain
   *  typesetting cannot reproduce — left for AI redraw. zh is still given. */
  freeze?: boolean;
  /** Dominant colour of the ORIGINAL text: near-black → 'black', near-white
   *  → 'white' (coloured text maps to whichever side its luminance is closer
   *  to). The typeset replacement matches it; the outline is auto-derived as
   *  the opposite colour.
   *
   *  这只是模型看图给的粗判（只有黑白两档）。开着「自动取色」时，擦除阶段量到的
   *  实测墨色会覆盖它（写回时标记 colorSource 'auto'）；用户手动选过的字色标
   *  'manual'，两者都不会动。 */
  color?: 'black' | 'white';
  /** Original text direction: true = vertical typesetting, false = horizontal. */
  vertical?: boolean;
  /**
   * 字体自动识别：区域原文的字体风格最接近内置字体库里的哪一个。
   * 返回字体 id；SYSTEM_FONT_ID（空串）=「常规印刷体」，调用方不覆盖该区域的
   * 字体（继续跟随全局「编辑器字体」）。字段缺失 = 没识别 / 开关关闭。
   */
  font?: string;
}

/**
 * `fontAutoDetect` 打开时才给模型加 `font` 字段和要求——关着的时候不多花
 * token，也不让模型有机会干扰嵌字字体。
 */
const buildPrompt = (skeleton: string, fontAutoDetect: boolean): string => {
  // 字体那条规则插在 freeze 之后，后面两条的编号要跟着顺延，所以统一算出来。
  const fontRule = fontAutoDetect
    ? `
7. font 填字符串：看【原文】的字形风格，从下面选一个最接近的（译文会用它来嵌字）。只填引号里的字符串，不要写别的：
${buildFontChoicePrompt()}
注意：普通对话文字基本都是常规印刷体；拿不准、看不清、或者风格没有明显特征时，一律填 "default"。`
    : '';
  const nJson = fontAutoDetect ? 8 : 7;
  const nEvery = fontAutoDetect ? 9 : 8;

  return `你是一名漫画翻译。图片中已用红框标出编号区域，每个编号对应一段需要翻译的漫画文字（对白/旁白/音效字等）。

区域清单（编号: [x, y, 宽, 高] (类别)，像素坐标；类别 text_bubble=气泡内文字，text_free=气泡外自由文字，manual=手动框选）：
${skeleton}

任务：对每个编号区域，识别其中的原文并翻译成简体中文。

规则：
1. source 填识别出的原文（保留原语言，不要翻译）。
2. zh 填简体中文译文：口语化、符合漫画语境、保留语气；注意结合整张图的上下文（前后气泡的对话是连贯的）。所有含文字的区域都必须给出译文，包括拟声词。
3. vertical 填布尔值：根据该框内【原文】的排版方向判断——原文竖排（文字从上到下、列从右到左）填 true，横排填 false。
4. color 填字符串：原文文字的主色——接近黑色填 "black"，接近白色填 "white"；彩色文字按明暗取更接近的一方。嵌字译文会沿用这个颜色。
5. freeze 填布尔值：以下情况填 true（译文照常给出，但不会嵌入图片，留待后续 AI 修图处理）：
   - 拟声词/音效字（如 ドン、ゴゴゴ、ザワ…），一般不替换；
   - 艺术字/装饰性文字（特效字体、手写花字、与画面融为一体的标题字），普通排版字体无法还原；
   - text_free 且文字直接压在复杂背景上（渐变、网点、图案、人物、景物），抹掉原文会破坏画面。
   普通气泡内文字、干净纯色背景上的文字填 false。
6. 若框内完全没有文字（误检），source 和 zh 填空字符串，freeze 填 false，color 填 "black"。${fontRule}
${nJson}. 只输出 JSON，不要输出任何其他文字、解释或 markdown 代码块。
${nEvery}. 清单中的每个编号都必须出现且只出现一次。

输出格式：
{"regions":[{"id":1,"source":"原文","zh":"译文","vertical":true,"color":"black","freeze":false${fontAutoDetect ? ',"font":"default"' : ''}}]}`;
};

/** Draw the image with numbered boxes for each region; returns a data URL. */
const buildAnnotatedImage = (imageEl: HTMLImageElement, regions: Region[], maskOutside: boolean): string => {
  const w = imageEl.naturalWidth;
  const h = imageEl.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  if (maskOutside) {
    // 「发送遮罩全图作上下文」: this annotated page IS the payload, so honouring
    // the switch means the artwork outside the numbered regions never leaves the
    // machine — white page first, then only the regions' own pixels (same
    // semantics as imageUtils.createMultiMaskedFullImage, kept inline to avoid a
    // blob round-trip just to re-decode it here).
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
    regions.forEach(r => {
      const rx = (r.x / 100) * w;
      const ry = (r.y / 100) * h;
      const rw = (r.width / 100) * w;
      const rh = (r.height / 100) * h;
      if (rw > 0 && rh > 0) ctx.drawImage(imageEl, rx, ry, rw, rh, rx, ry, rw, rh);
    });
  } else {
    ctx.drawImage(imageEl, 0, 0);
  }

  const lineWidth = Math.max(2, Math.round(w / 500));
  const fontSize = Math.max(14, Math.round(w / 45));
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = 'top';

  regions.forEach((r, i) => {
    // Region geometry is stored as percentages (0-100) of the image size.
    const rx = (r.x / 100) * w;
    const ry = (r.y / 100) * h;
    const rw = (r.width / 100) * w;
    const rh = (r.height / 100) * h;
    const label = String(i + 1);
    ctx.strokeStyle = '#e11d48';
    ctx.lineWidth = lineWidth;
    // Inflated by half the stroke width so the frame lies entirely OUTSIDE the
    // region — a centred stroke would eat into the first/last characters of a
    // narrow box.
    const inset = lineWidth / 2;
    ctx.strokeRect(rx - inset, ry - inset, rw + lineWidth, rh + lineWidth);

    const textW = ctx.measureText(label).width;
    const pad = Math.round(fontSize / 4);
    const boxW = textW + pad * 2;
    const boxH = fontSize + pad * 2;
    // The badge must never cover the text the model has to read, so it goes
    // OUTSIDE the region whenever there is room for it. (Previously a box
    // touching the top edge got the label inside its own corner — on a narrow
    // vertical text box that hides a whole column of the original.) Tried in
    // order: above → below → right → left; inside the corner only when the
    // region spans the whole image.
    const candidates = [
      { x: rx, y: ry - boxH, fits: ry - boxH >= 0 },            // above
      { x: rx, y: ry + rh, fits: ry + rh + boxH <= h },         // below
      { x: rx + rw, y: ry, fits: rx + rw + boxW <= w },         // right
      { x: rx - boxW, y: ry, fits: rx - boxW >= 0 },            // left
      { x: rx, y: ry, fits: true },                             // last resort
    ];
    const badge = candidates.find(c => c.fits) ?? candidates[candidates.length - 1];
    ctx.fillStyle = '#e11d48';
    ctx.fillRect(badge.x, badge.y, boxW, boxH);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, badge.x + pad, badge.y + pad);
  });

  return canvas.toDataURL('image/png');
};

/** Extract the first top-level JSON object from a model response. */
const extractJson = (text: string): any => {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI 响应中没有找到 JSON');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
};

/**
 * Inline retry budgets for one editor-translate call.
 *
 * - 429 / rate-limit signals use their own, larger budget and back off through
 *   the shared global gate (coordinated across all in-flight calls so parallel
 *   requests don't thundering-herd the endpoint).
 * - Every other transient failure — timeout, 5xx, network drop, or an
 *   unparseable / truncated model response — gets a small budget with a
 *   simple exponential back-off: a single hiccup must not lose a whole page.
 *
 * Deterministic 4xx client errors (bad key, malformed request) are NOT
 * retried — waiting cannot fix them, only delay the error the user needs.
 */
const MAX_429_RETRIES = 5;
const MAX_ERROR_RETRIES = 3;
const ERROR_BACKOFF_BASE_MS = 1_500;
const ERROR_BACKOFF_MAX_MS = 15_000;

/** Exponential back-off for the Nth general retry (N starts at 1). */
const errorBackoffMs = (retry: number): number =>
  Math.min(ERROR_BACKOFF_MAX_MS, ERROR_BACKOFF_BASE_MS * 2 ** (retry - 1));

/** True when a failed attempt is worth repeating. Abort is handled before this
 *  is consulted; 4xx (except 408 timeout / 429 rate-limit) never retry. */
const isRetryableTranslateError = (err: any): boolean => {
  const status = err?.status ?? err?.code;
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return false;
  }
  return true;
};

/** Abortable sleep — the caller's stop button must interrupt a back-off wait. */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const done = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

/**
 * Parse a model response into per-region results. Throws on an empty /
 * unparseable body so the caller can retry the call — a truncated or
 * malformed JSON response is exactly the transient model failure this
 * budget exists for, not a reason to fail the whole page.
 */
const parseTranslationResponse = (
  content: string,
  regions: Region[],
  fontAutoDetect: boolean
): Map<string, RegionTranslation> => {
  if (!content.trim()) throw new Error('AI 返回了空响应');
  const parsed = extractJson(content);
  const list: any[] = Array.isArray(parsed?.regions) ? parsed.regions : [];
  const results = new Map<string, RegionTranslation>();
  for (const item of list) {
    const idx = Number(item?.id);
    if (!Number.isInteger(idx) || idx < 1 || idx > regions.length) continue;
    results.set(regions[idx - 1].id, {
      source: typeof item.source === 'string' ? item.source : undefined,
      zh: typeof item.zh === 'string' ? item.zh : undefined,
      freeze: item.freeze === true,
      color: item.color === 'white' ? 'white' : item.color === 'black' ? 'black' : undefined,
      vertical: typeof item.vertical === 'boolean' ? item.vertical : undefined,
      // 只在开关打开时采信：关掉后即使模型自己回了一个 font 也不生效。
      font: fontAutoDetect ? resolveFontIdFromAi(item.font) : undefined,
    });
  }
  // We always send ≥1 region and the prompt demands every id back, so a valid
  // JSON body with no usable entries is a bad response (wrong key, truncated
  // list) — treat it like a parse failure so the caller retries.
  if (results.size === 0) throw new Error('AI 响应中没有可用的区域数据');
  return results;
};

/**
 * Translate all given regions of one image with a single vision-AI call.
 * Returns a Map keyed by Region.id. Regions the model found empty
 * (misdetections) come back with blank source/zh and are ignored by the
 * caller.
 *
 * `signal` lets the caller abort the request (editor stop button).
 *
 * Retry policy: 429 / rate-limit signals retry inline through the global gate
 * (see the constants above); other transient failures (timeout, 5xx, network
 * error, unparseable / empty model response) retry inline a few times with
 * exponential back-off. Only deterministic client errors (4xx) abort
 * immediately.
 */
export const translateEditorRegions = async (
  imageEl: HTMLImageElement,
  regions: Region[],
  config: AppConfig,
  signal?: AbortSignal
): Promise<Map<string, RegionTranslation>> => {
  const { translationBaseUrl, translationApiKey, translationModel } = config;
  if (!translationApiKey || !translationBaseUrl) {
    throw new Error('请先在全局设置中配置翻译模型的 Base URL 和 API Key');
  }
  if (regions.length === 0) return new Map();

  // 「发送遮罩全图作上下文」also covers this path: here the annotated page IS the
  // payload, so honouring the switch means nothing outside the circled regions
  // is uploaded at all (privacy) — not merely an extra context image on top of
  // an unmasked page.
  const annotatedUrl = buildAnnotatedImage(imageEl, regions, !!config.sendMaskedContextForTranslation);
  let payloadUrl = annotatedUrl;
  let compressedUrl: string | null = null;
  try {
    if (config.enableAiPayloadCompression) {
      compressedUrl = await compressImageToTargetSize(annotatedUrl, {
        targetSizeKB: config.aiPayloadTranslationTargetKB,
      });
      payloadUrl = compressedUrl;
    }
    const imageBase64 = await urlToBase64(payloadUrl);

    // Region geometry is stored as percentages (0-100) — convert to pixels.
    const iw = imageEl.naturalWidth;
    const ih = imageEl.naturalHeight;
    const skeleton = regions
      .map((r, i) => `${i + 1}: [${Math.round((r.x / 100) * iw)}, ${Math.round((r.y / 100) * ih)}, ${Math.round((r.width / 100) * iw)}, ${Math.round((r.height / 100) * ih)}] (${r.detectedClass ?? 'manual'})`)
      .join('\n');
    const fontAutoDetect = !!config.enableFontAutoDetect;
    const prompt = buildPrompt(skeleton, fontAutoDetect);

    // Record the annotated page — in this flow the payload IS a drawing of the
    // image (numbered boxes, optionally masked outside), which the canvas never
    // shows. Placed after `skeleton` so the prompt text can be captured too.
    const payloadTransforms: PayloadTransform[] = ['annotate', 'full-page'];
    if (config.sendMaskedContextForTranslation) payloadTransforms.push('mask');
    if (config.enableAiPayloadCompression) payloadTransforms.push('compress');
    recordPayload({
      config,
      phase: 'editorTranslate',
      regionIds: regions.map(r => r.id),
      transforms: payloadTransforms,
      prompt,
      sentUrl: payloadUrl,
    });

    let cleanBaseUrl = translationBaseUrl.replace(/\/+$/, '');
    if (!cleanBaseUrl.endsWith('/v1')) cleanBaseUrl += '/v1';

    const timeoutMs = config.apiTimeout || 60000;

    /**
     * One HTTP attempt: honour the global gate, run under the per-request
     * timeout AND the caller's stop signal (both cancel the underlying fetch,
     * not just the wrapper promise), and return the raw assistant message.
     * Throws on any failure — the retry loop below decides what to do.
     */
    const requestOnce = async (): Promise<string> => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      // Honour the global cool-down gate (no-op when not tripped). A 429 from
      // a previous attempt blocks here, so no local sleep is needed for it.
      await globalRateLimitGate.wait(signal);

      const ctrl = new AbortController();
      let timedOut = false;
      const onOuterAbort = () => ctrl.abort();
      if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
      try {
        const response = await fetch(`${cleanBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${translationApiKey}`,
          },
          body: JSON.stringify({
            model: translationModel,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageBase64 } },
              ],
            }],
            max_tokens: 4096,
          }),
          signal: ctrl.signal,
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          const e: any = new Error(`翻译 API 错误: ${err.error?.message || response.statusText} (${response.status})`);
          // Preserve status / Retry-After so the 429 handling below can
          // detect rate-limit signals and honour the server's wait hint.
          e.status = response.status;
          e.retryAfter = response.headers.get('Retry-After');
          throw e;
        }
        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
      } catch (e: any) {
        // Caller-cancel: never retry, propagate the abort.
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        // Normalise our own timeout so it is retried as a transient failure
        // instead of surfacing as a bare AbortError.
        if (timedOut) throw new Error(`翻译请求超时（${timeoutMs}ms）`);
        throw e;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onOuterAbort);
      }
    };

    let rateLimitRetries = 0;
    let errorRetries = 0;
    for (;;) {
      let content: string;
      try {
        content = await requestOnce();
      } catch (e: any) {
        if (signal?.aborted || e?.name === 'AbortError') {
          throw new DOMException('Aborted', 'AbortError');
        }
        // 429 / rate-limit: trip the global gate and retry inline (the next
        // attempt's `await wait()` honours the cool-down).
        if (isRateLimitError(e)) {
          if (rateLimitRetries >= MAX_429_RETRIES) throw e;
          rateLimitRetries++;
          const waitMs = globalRateLimitGate.trip(parseRetryAfter(e.retryAfter));
          console.warn(
            `翻译 API 被限流 (429)，退避 ${Math.round(waitMs)}ms 后重试 ` +
            `(第 ${rateLimitRetries}/${MAX_429_RETRIES} 次重试)。`
          );
          continue;
        }
        // Other transient failures (timeout / 5xx / network): retry a few
        // times before giving up.
        if (isRetryableTranslateError(e) && errorRetries < MAX_ERROR_RETRIES) {
          errorRetries++;
          const waitMs = errorBackoffMs(errorRetries);
          console.warn(
            `翻译 API 请求失败（${e?.message || e}），${Math.round(waitMs)}ms 后重试 ` +
            `(第 ${errorRetries}/${MAX_ERROR_RETRIES} 次重试)。`
          );
          await sleep(waitMs, signal);
          continue;
        }
        throw e;
      }

      // Request succeeded — parse it. An empty / truncated / malformed body is
      // retried too: it is a transient model failure, not a reason to fail the
      // whole page.
      try {
        return parseTranslationResponse(content, regions, fontAutoDetect);
      } catch (e: any) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (errorRetries >= MAX_ERROR_RETRIES) throw e;
        errorRetries++;
        const waitMs = errorBackoffMs(errorRetries);
        console.warn(
          `翻译响应无法解析（${e?.message || e}），${Math.round(waitMs)}ms 后重试 ` +
          `(第 ${errorRetries}/${MAX_ERROR_RETRIES} 次重试)。`
        );
        await sleep(waitMs, signal);
        continue;
      }
    }
  } finally {
    if (compressedUrl) releaseObjectURL(compressedUrl);
  }
};
