import { AppConfig, Region, translationReasoningParams } from '../types';
import { compressImageToTargetSize, releaseObjectURL, urlToBase64 } from './imageUtils';
import { globalRateLimitGate, isRateLimitError, parseRetryAfter } from './rateLimitGate';
import { recordPayload, PayloadTransform } from './payloadLog';
import { buildFontChoicePrompt, resolveFontIdFromAi } from './fontService';
import { PageTerm } from './glossaryBook';
import { t } from './translations';

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
 * 编辑器翻译提示词的**内置默认模板**（用户没自定义时用它）。
 *
 * 与「翻译模式」那条纯文本提示词不同，这里是模板：区域清单、字体识别规则、
 * 规则编号、输出格式示例都是运行时才算得出来的，所以用占位符标出插值位置 ——
 *   {{regions}}      区域清单（编号 + 像素框 + 类别）
 *   {{fontRule}}     字体识别规则（「字体自动识别」关闭时为空串）
 *   {{nJson}}        「只输出 JSON」那条的规则编号
 *   {{nEvery}}       「每个编号都出现且只出现一次」那条的规则编号
 *   {{outputFormat}} 输出格式示例（含 font 字段与否随开关变化）
 * 模板里没写哪个占位符，对应那一段就不会出现（用户的自由）。
 * 设置面板会把这几个占位符写在使用说明里。
 */
export const EDITOR_TRANSLATION_PROMPT_TEMPLATE = `你是一名漫画翻译。图片中已用红框标出编号区域，每个编号对应一段需要翻译的漫画文字（对白/旁白/音效字等）。

区域清单（编号: [x, y, 宽, 高] (类别)，像素坐标；类别 text_bubble=气泡内文字，text_free=气泡外自由文字，manual=手动框选）：
{{regions}}

任务：对每个编号区域，识别其中的原文并翻译成简体中文。

规则：
1. source 填识别出的原文（保留原语言，不要翻译）。
2. zh 填简体中文译文：口语化、符合漫画语境、保留语气；注意结合整张图的上下文（前后气泡的对话是连贯的）。所有含文字的区域都必须给出译文，包括拟声词。
   需要省略号时一律用「…」（一个省略号，三个点），不要用「……」（两个省略号，六个点），也不要用英文 "..." 或 "。。。"。
3. vertical 填布尔值：根据该框内【原文】的排版方向判断——原文竖排（文字从上到下、列从右到左）填 true，横排填 false。
   竖排区域（vertical=true）的 zh 尽量少换行，最好整句不换行：漫画气泡空间有限，换行很浪费地方，只要不影响表达就写成一整句（句子长没关系，嵌字时会自动折行）。需要分割句子的意群时，用逗号或句号，不要用换行。横排区域（vertical=false）不受此限制，需要时可以用 \\n 换行分段。
4. color 填字符串：原文文字的主色——接近黑色填 "black"，接近白色填 "white"；彩色文字按明暗取更接近的一方。嵌字译文会沿用这个颜色。
5. freeze 填布尔值：以下情况填 true（译文照常给出，但不会嵌入图片，留待后续 AI 修图处理）：
   - 拟声词/音效字（如 ドン、ゴゴゴ、ザワ…），一般不替换；
   - 艺术字/装饰性文字（特效字体、手写花字、与画面融为一体的标题字），普通排版字体无法还原；
   - text_free 且文字直接压在复杂背景上（渐变、网点、图案、人物、景物），抹掉原文会破坏画面。
   普通气泡内文字、干净纯色背景上的文字填 false。
6. 若框内完全没有文字（误检），source 和 zh 填空字符串，freeze 填 false，color 填 "black"。
7. terms 填数组：本页出现的作品专有名词（人名/地名/组织/招式名/固定称谓），用来汇总全作术语表。source 填原文术语（取自你识别出的原文，越短越好，只要名字本身）；target 填你在 zh 译文里**实际使用**的那个译名。
   - 敬语 / 称呼后缀不要写进术语：くん / ちゃん / さん / 様 / 殿 / 氏 / 先生 / 先輩 / 君 / 大人 / ちゃん付け / 呼び捨て 之类一律去掉，只填名字本身（タナカくん → タナカ，タナカさん → タナカ）。target 同理，只填译名本身，不要带上「小/君/酱/桑/先生」这类称呼（译文若写成「田中君」，target 填「田中」）。
   - 因此同一个人物带不带敬语只算**同一条**术语：タナカくん 和 タナカ 都填 source「タナカ」，不要拆成两条，也不要让它们的 target 不一致。
   - 下面的「タナカ → 田中」只是示范写法（假名姓氏对应的汉字是唯一的），不是本作的术语；本作专名一律按你在 zh 里的实际译法填。
   - 普通词汇、拟声词不要收；拿不准是不是专有名词的不要收；没有就填 []。{{fontRule}}
{{nJson}}. 只输出 JSON，不要输出任何其他文字、解释或 markdown 代码块。
{{nEvery}}. 清单中的每个编号都必须出现且只出现一次。

输出格式：
{{outputFormat}}`;

/**
 * 把动态片段插进模板。用函数式替换（不是 `$1` 那种）—— 区域清单 / 用户提示词里
 * 出现 `$` 时不会被当成替换模式解析。
 */
const renderPromptTemplate = (
  template: string,
  skeleton: string,
  fontAutoDetect: boolean
): string => {
  // 字体那条规则插在 terms 之后，后面两条的编号要跟着顺延，所以统一算出来。
  const fontRule = fontAutoDetect
    ? `
8. font 填字符串：看【原文】的字形风格，从下面选一个最接近的（译文会用它来嵌字）。只填引号里的字符串，不要写别的：
${buildFontChoicePrompt()}
注意：普通对话文字基本都是常规印刷体；拿不准、看不清、或者风格没有明显特征时，一律填 "default"。`
    : '';
  const nJson = fontAutoDetect ? '9' : '8';
  const nEvery = fontAutoDetect ? '10' : '9';
  const outputFormat = `{"regions":[{"id":1,"source":"原文","zh":"译文","vertical":true,"color":"black","freeze":false${fontAutoDetect ? ',"font":"default"' : ''}}],"terms":[{"source":"タナカ","target":"田中"}]}（terms 里的名字不带敬语后缀，此处只是格式示范）`;

  return template
    .replace(/\{\{regions\}\}/g, () => skeleton)
    .replace(/\{\{fontRule\}\}/g, () => fontRule)
    .replace(/\{\{nJson\}\}/g, () => nJson)
    .replace(/\{\{nEvery\}\}/g, () => nEvery)
    .replace(/\{\{outputFormat\}\}/g, () => outputFormat);
};

/**
 * `fontAutoDetect` 打开时才给模型加 `font` 字段和要求——关着的时候不多花
 * token，也不让模型有机会干扰嵌字字体。
 * `customTemplate` 非空 = 用户在设置里改过，用它渲染；否则用内置默认模板。
 */
const buildPrompt = (skeleton: string, fontAutoDetect: boolean, customTemplate?: string): string =>
  renderPromptTemplate(
    customTemplate?.trim() ? customTemplate : EDITOR_TRANSLATION_PROMPT_TEMPLATE,
    skeleton,
    fontAutoDetect
  );

/**
 * 「擦除判定」的附加说明 —— 只有第二张（擦除对照）图真的发出去时才追加。
 *
 * 刻意**不进 `{{...}}` 占位符体系**，两个原因：
 *  1. 判定要并进现有那条 freeze 规则、而不是新增一条 —— 新增就要重排编号，
 *     `{{nJson}}` / `{{nEvery}}` 得跟着顺延，用户的自由模板也会被打乱；
 *  2. 用户自定义过模板时未必会补上新占位符，那样功能会静默失效；追加到渲染结果
 *     末尾则内置模板和自定义模板都生效，也不动编号。
 *
 * 结论复用既有的 `freeze` 字段（与原有文字类型规则取或）—— 不新增任何字段。
 *
 * `sfxFollowsErase` = 子开关 AppConfig.enableEraseJudgedFreezeForSfx：打开时把拟声词
 * 那一类从「一律冻结」里摘出来、改看擦除效果；关闭时保持原样（本段就只是多给 freeze
 * 一个判断依据，原有规则一条不动）。
 */
const eraseCheckPrompt = (sfxFollowsErase: boolean): string => `

【本次附加了第二张图：擦除对照】
图 1 = 原图 + 编号红框（照旧）。
图 2 = 同一批编号红框，但框内原文已被算法擦除，编号与图 1 一一对应。
对每个编号，请对照两张图判断这个框的擦除效果：
- 框内还留有残留笔画、黑边、脏点、或者一片模糊涂抹的痕迹 → 擦除效果差；
- 框内干净、底色与图案连续自然（看不出被抹过） → 擦除效果好。

freeze 怎么填（并进上面那条规则，其余规则不变）：
- 擦除效果差、或者你拿不准 → freeze 填 true（译文照常给出，只是不嵌进图片）。
- 擦除效果好 → 按上面的规则继续判断。
${sfxFollowsErase
    ? `- 拟声词 / 音效字 / 语气词（ドン、ゴゴゴ、ザワ、あっ、うん…）本次**不再因为是这类字而冻结**，
  只看擦除效果：擦得干净就填 false（和普通对白一样嵌字），有残留笔画、糊痕才填 true。
  即使上面的规则里写了「拟声词/音效字一般不替换」，本次以这一条为准。`
    : '- 拟声词 / 音效字 / 语气词仍然一律冻结（freeze 填 true），不受擦除效果影响。'}
- 艺术字 / 装饰性文字，以及压在复杂背景上、擦掉会破坏画面的文字：照旧 freeze 填 true，
  这一条不受擦除效果影响。

（本段只是给 freeze 多加一个判断依据，输出格式完全不变 —— 照旧只输出 JSON，不要输出
任何其他文字、解释或 markdown 代码块。）`;

/**
 * Draw the image with numbered boxes for each region; returns the data URL plus
 * the size it was actually drawn at.
 *
 * `source` may be the page image or an already-erased page canvas — the
 * erase-check flow (AppConfig.enableEraseJudgedFreeze) draws the SAME boxes on
 * both, so the two numbered pages line up box for box.
 *
 * `maxDimension`（长边上限）把画布直接建在缩放后的尺寸上，而不是先按原分辨率画完
 * 再重编码缩小 —— 两个好处：编号框与编号是**按最终分辨率画出来**的（不是被重采样
 * 糊下去的），而且那张原分辨率的画布压根不会存在（6000×8000 就是 ~190MB canvas
 * 外加一个 ~40MB 的 PNG data URL，而擦除判定要发两张整页）。
 *
 * 几何不受影响：框是百分比存的，线宽与编号字号都按画布宽度算，跟着一起缩。
 */
const buildAnnotatedImage = (
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  regions: Region[],
  maskOutside: boolean,
  maxDimension?: number
): { url: string; width: number; height: number } => {
  const scale = maxDimension && maxDimension > 0
    ? Math.min(1, maxDimension / Math.max(sourceW, sourceH))
    : 1;
  const w = Math.max(1, Math.round(sourceW * scale));
  const h = Math.max(1, Math.round(sourceH * scale));
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
    // 源矩形用**源图**像素，目标矩形用画布像素 —— 两者只在 scale === 1 时重合。
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);
    regions.forEach(r => {
      const sx = (r.x / 100) * sourceW;
      const sy = (r.y / 100) * sourceH;
      const sw = (r.width / 100) * sourceW;
      const sh = (r.height / 100) * sourceH;
      if (sw > 0 && sh > 0) {
        ctx.drawImage(source, sx, sy, sw, sh, sx * scale, sy * scale, sw * scale, sh * scale);
      }
    });
  } else {
    ctx.drawImage(source, 0, 0, w, h);
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

  return { url: canvas.toDataURL('image/png'), width: w, height: h };
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

/** 一次整页翻译的完整产出：逐框结果 + 本页术语（喂给术语表 v2）。 */
export interface EditorTranslateOutcome {
  results: Map<string, RegionTranslation>;
  /** 本页出现的作品专有名词（{source: 原文, target: 本页实际译名}）。解析
   *  失败/模型没给时为 []——术语是附属产物，绝不因为它的格式问题让整页
   *  翻译重试。source / target 都不带敬语称呼后缀，见 PageTerm。 */
  terms: PageTerm[];
}

/** 从已解析的 JSON 里捞术语数组。宽容：任何一条不合格就跳过那一条。 */
const parsePageTerms = (parsed: any): PageTerm[] => {
  const list: any[] = Array.isArray(parsed?.terms) ? parsed.terms : [];
  const terms: PageTerm[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const source = typeof item.source === 'string' ? item.source.trim() : '';
    const target = typeof item.target === 'string' ? item.target.trim() : '';
    if (!source || !target) continue;
    terms.push({ source, target });
  }
  return terms;
};

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
): EditorTranslateOutcome => {
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
  return { results, terms: parsePageTerms(parsed) };
};

/**
 * Translate all given regions of one image with a single vision-AI call.
 * Returns per-region results keyed by Region.id plus the page's term list
 * (proper nouns the model actually used, feeding the glossary). Regions the
 * model found empty (misdetections) come back with blank source/zh and are
 * ignored by the caller.
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
  signal?: AbortSignal,
  /** 预擦除后的整页 canvas（开关打开时由调用方生成）：作为第二张「擦除对照」图
   *  一起发送，让模型顺手判断每框擦得干不干净。见 AppConfig.enableEraseJudgedFreeze。 */
  erasedPage?: HTMLCanvasElement
): Promise<EditorTranslateOutcome> => {
  const { translationBaseUrl, translationApiKey, translationModel } = config;
  if (!translationApiKey || !translationBaseUrl) {
    throw new Error('请先在全局设置中配置翻译模型的 Base URL 和 API Key');
  }
  if (regions.length === 0) return { results: new Map(), terms: [] };

  // 长边上限：token 只看像素尺寸。两张图按**同一个**上限画 —— 同分辨率才好逐框对照
  // 「擦之前 / 擦之后」，而擦除图也不需要更高（它只判有没有残留笔画、有没有糊）。
  const maxDimension = config.aiPayloadTranslationMaxPx || undefined;
  // 「发送遮罩全图作上下文」also covers this path: here the annotated page IS the
  // payload, so honouring the switch means nothing outside the circled regions
  // is uploaded at all (privacy) — not merely an extra context image on top of
  // an unmasked page. 第二张图遵守同一个开关：否则一张泄露画面、一张不泄露，
  // 这个隐私开关就形同虚设。
  const maskOutside = !!config.sendMaskedContextForTranslation;
  const annotated = buildAnnotatedImage(
    imageEl, imageEl.naturalWidth, imageEl.naturalHeight, regions, maskOutside, maxDimension
  );
  // 第二张：同一批编号框，画在预擦除后的整页上。
  const erasedAnnotated = erasedPage
    ? buildAnnotatedImage(erasedPage, erasedPage.width, erasedPage.height, regions, maskOutside, maxDimension)
    : null;

  let compressedUrl: string | null = null;
  let erasedCompressedUrl: string | null = null;
  try {
    let payloadUrl = annotated.url;
    let erasedPayloadUrl = erasedAnnotated?.url ?? null;
    if (config.enableAiPayloadCompression) {
      compressedUrl = await compressImageToTargetSize(annotated.url, {
        targetSizeKB: config.aiPayloadTranslationTargetKB,
        maxDimension,
      });
      payloadUrl = compressedUrl;
      if (erasedPayloadUrl) {
        erasedCompressedUrl = await compressImageToTargetSize(erasedPayloadUrl, {
          targetSizeKB: config.aiPayloadTranslationTargetKB,
          maxDimension,
        });
        erasedPayloadUrl = erasedCompressedUrl;
      }
    }
    const imageBase64 = await urlToBase64(payloadUrl);
    const erasedBase64 = erasedPayloadUrl ? await urlToBase64(erasedPayloadUrl) : null;

    // Region geometry is stored as percentages (0-100) — convert to pixels. The
    // prompt's coordinates must describe the image the model ACTUALLY sees, so
    // they come straight from the annotated canvas' own size: 标注与缩放都在
    // buildAnnotatedImage 里做完，这里没有任何比例需要再推一遍。
    const skeleton = regions
      .map((r, i) => `${i + 1}: [${Math.round((r.x / 100) * annotated.width)}, ${Math.round((r.y / 100) * annotated.height)}, ${Math.round((r.width / 100) * annotated.width)}, ${Math.round((r.height / 100) * annotated.height)}] (${r.detectedClass ?? 'manual'})`)
      .join('\n');
    const fontAutoDetect = !!config.enableFontAutoDetect;
    // 用户在设置里改过编辑器提示词就用他的模板，否则用内置默认模板。
    const basePrompt = buildPrompt(skeleton, fontAutoDetect, config.editorTranslationPrompt);
    // 擦除判定那段只在第二张图真的发出去时才追加 —— 说了「见图 2」却没图会把模型带偏。
    // 子开关（拟声词是否也看擦除效果）只改那一段的措辞，不改图片；它的值不随主开关
    // 清空，所以这里必须自己带上主开关 —— 生效与否是两者的与，不是子开关单独说了算。
    const sfxFreedFromFreeze = !!config.enableEraseJudgedFreeze && !!config.enableEraseJudgedFreezeForSfx;
    const prompt = erasedBase64
      ? basePrompt + eraseCheckPrompt(sfxFreedFromFreeze)
      : basePrompt;

    // Record the annotated page — in this flow the payload IS a drawing of the
    // image (numbered boxes, optionally masked outside), which the canvas never
    // shows. Placed after `skeleton` so the prompt text can be captured too.
    const payloadTransforms: PayloadTransform[] = ['annotate', 'full-page'];
    if (config.sendMaskedContextForTranslation) payloadTransforms.push('mask');
    if (config.enableAiPayloadCompression) payloadTransforms.push('compress');
    if (erasedPayloadUrl) payloadTransforms.push('erase-check');
    recordPayload({
      config,
      phase: 'editorTranslate',
      regionIds: regions.map(r => r.id),
      transforms: payloadTransforms,
      prompt,
      sentUrl: payloadUrl,
      extra: erasedPayloadUrl ? { url: erasedPayloadUrl, label: t(config.language, 'payloadExtraErasedPage') } : null,
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
                // 图 2：擦除对照（同编号、框内原文已擦）。没有它就不发，
                // 提示词里那段擦除判定也随之不出现。
                ...(erasedBase64 ? [{ type: 'image_url', image_url: { url: erasedBase64 } }] : []),
              ],
            }],
            max_tokens: 4096,
            // 思考强度（reasoning_effort）：'none' = 不思考。整页翻译是轻任务，
            // 关掉思考能明显缩短等待（尤其对带思考链的模型）。
            ...translationReasoningParams(config.translationReasoningEffort),
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
    if (erasedCompressedUrl) releaseObjectURL(erasedCompressedUrl);
  }
};
