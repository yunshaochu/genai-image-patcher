import { AppConfig, Region } from '../types';
import { compressImageToTargetSize, releaseObjectURL, urlToBase64 } from './imageUtils';
import { globalRateLimitGate, isRateLimitError, parseRetryAfter } from './rateLimitGate';

/**
 * Editor auto-translation (whole-image, one vision-AI call).
 *
 * The full image is annotated with numbered boxes — one per editable editor
 * region (contextOnly bubbles excluded) — and sent to the configured
 * OpenAI-compatible vision endpoint together with a JSON skeleton. The model
 * returns per-region source text (doubles as OCR) + Simplified Chinese
 * translation for EVERY text-bearing region; regions flagged freeze (sfx /
 * stylized lettering / text over complex backgrounds) get their translation
 * stored as frozen text instead of being typeset into the image.
 */

export interface RegionTranslation {
  /** Recognized original text (used as OCR). */
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
   *  the opposite colour. */
  color?: 'black' | 'white';
  /** Original text direction: true = vertical typesetting, false = horizontal. */
  vertical?: boolean;
}

const buildPrompt = (skeleton: string): string => `你是一名漫画翻译。图片中已用红框标出编号区域，每个编号对应一段需要翻译的漫画文字（对白/旁白/音效字等）。

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
6. 若框内完全没有文字（误检），source 和 zh 填空字符串，freeze 填 false，color 填 "black"。
7. 只输出 JSON，不要输出任何其他文字、解释或 markdown 代码块。
8. 清单中的每个编号都必须出现且只出现一次。

输出格式：
{"regions":[{"id":1,"source":"原文","zh":"译文","vertical":true,"color":"black","freeze":false}]}`;

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
    ctx.strokeRect(rx, ry, rw, rh);

    const textW = ctx.measureText(label).width;
    const pad = Math.round(fontSize / 4);
    const boxW = textW + pad * 2;
    const boxH = fontSize + pad * 2;
    // Label sits above the box, or inside the top edge when near the top.
    const labelY = ry - boxH >= 0 ? ry - boxH : ry;
    ctx.fillStyle = '#e11d48';
    ctx.fillRect(rx, labelY, boxW, boxH);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, rx + pad, labelY + pad);
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
 * Translate all given regions of one image with a single vision-AI call.
 * Returns a Map keyed by Region.id. Regions the model found empty
 * (misdetections) come back with blank source/zh and are ignored by the
 * caller.
 *
 * `signal` lets the caller abort the request (editor stop button).
 *
 * Retry policy mirrors aiService.executeWithRetry: only 429 / rate-limit
 * signals retry inline (back off coordinated through the global gate so
 * parallel calls don't thundering-herd the endpoint); timeouts, 5xx and
 * network errors throw immediately.
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

    let cleanBaseUrl = translationBaseUrl.replace(/\/+$/, '');
    if (!cleanBaseUrl.endsWith('/v1')) cleanBaseUrl += '/v1';

    // 429 inline retries are capped — the gate handles the wait, so we just
    // loop and let `await wait()` block before each attempt.
    const MAX_429_RETRIES = 5;
    let content = '';
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      // Honour the global cool-down gate (no-op when not tripped).
      await globalRateLimitGate.wait(signal);

      // Per-attempt controller: the timeout and the caller's stop signal
      // both cancel the underlying fetch, not just the wrapper promise.
      const ctrl = new AbortController();
      const onOuterAbort = () => ctrl.abort();
      if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), config.apiTimeout || 60000);
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
                { type: 'text', text: buildPrompt(skeleton) },
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
        content = data.choices?.[0]?.message?.content || '';
        break;
      } catch (e: any) {
        // Caller-cancel: never retry, propagate the abort.
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        // 429: trip the global gate and retry inline.
        if (isRateLimitError(e) && attempt < MAX_429_RETRIES) {
          const waitMs = globalRateLimitGate.trip(parseRetryAfter(e.retryAfter));
          console.warn(
            `翻译 API 被限流 (429)，退避 ${Math.round(waitMs)}ms 后重试 ` +
            `(第 ${attempt + 2}/${MAX_429_RETRIES + 1} 次尝试)。`
          );
          continue;
        }
        // Non-429 (or retries exhausted): bail.
        throw e;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onOuterAbort);
      }
    }

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
      });
    }
    return results;
  } finally {
    if (compressedUrl) releaseObjectURL(compressedUrl);
  }
};
