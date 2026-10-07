
export interface RestoreBox {
  id: string;
  x: number;       // Percentage 0-100 relative to the region (not the full image)
  y: number;
  width: number;
  height: number;
  inverse: boolean; // true = keep AI result inside box, restore outside
}

/**
 * Detection classes returned by the comic-detector API (docs/API_RTDTR.md).
 *
 * NOTE: a `bubble` outline is an OUTER/grouping box. When it fully encloses a
 * `text_bubble` (its text), the detection pass drops it as a redundant outer
 * box (services/detectionService.ts → dropEnclosingBoxes). Only bubbles that
 * enclose nothing survive, and those stay context-only (see Region.contextOnly)
 * — a `bubble` is never an AI-redraw unit.
 */
export type DetectedClass = 'bubble' | 'text_bubble' | 'text_free';

/**
 * 自动检测气泡在**一页**上最后一次的结果（见 UploadedImage.detectionStatus）。
 *
 * 'done' = 这次请求跑成功了 —— 哪怕一个框都没检出（封面、插图、无字跨页）。
 * 'failed' = 请求失败（后端不在线 / 超时 / 5xx），这页还没拿到结果。
 * undefined = 还没跑过检测。
 *
 * 为什么要记：检测结果本身（region 框）只在检出东西时才留下痕迹，所以「跑过但没结果」
 * 和「从没跑过」在数据上完全一样。没有这个标记，零框页面会被每一次整批检测反复重跑；
 * 有了它，跨重启也能看出「这页上次没跑成」，下次整批会把它挑回来补跑。
 */
export type DetectionStatus = 'done' | 'failed';

/**
 * Decides whether a region enters the AI redraw pipeline (masked + painted)
 * and is shown as a working box in the AI-generation canvas. Editor-mode
 * visibility is NOT governed by this — the editor always works on text
 * regions (see contextOnly).
 *
 * Only text regions (text_bubble + text_free) and manual regions paint.
 * `bubble` outlines are context-only markers, never painted — and a bubble
 * that encloses text was already dropped by detection before it could become a
 * region (services/detectionService.ts → dropEnclosingBoxes).
 */
export const isRegionPaintable = (
  r: Pick<Region, 'source' | 'detectedClass' | 'contextOnly'>
): boolean => {
  if (r.source === 'auto' && r.detectedClass) {
    return r.detectedClass === 'text_bubble' || r.detectedClass === 'text_free';
  }
  // Manual / legacy regions keep the historical contextOnly semantics.
  return !r.contextOnly;
};

/**
 * 「这一页还要不要跑自动检测」—— 自动检测据此跳过已经处理过的页面，整批重跑不再
 * 把整个图库重新过一遍检测接口（见 hooks/useImageProcessor.ts → handleAutoDetect）。
 *
 * 判定顺序（先命中先返回）：
 * 1. 已经有文字区（text_bubble / text_free）→ 跳过：这些框就是上一次检测的产物，
 *    重跑只会得到同一批框，而且会整批撞在 regionOverlapsExisting 的去重上，白等
 *    一轮网络往返。
 * 2. 只剩下人工标注（手画框、以及没有 detectedClass 的历史遗留框 —— 统一按
 *    `source !== 'auto'` 判）→ **完全由 `skipManualOnlyPages` 说了算**，记忆不参与：
 *    开着 = 用户手框过就是处理过了，跳过；关着 = 这类页面一直参与检测（开关的语义
 *    就是「反复检测这类页也没关系」）。
 * 3. 一个框都没有 → 只看记忆：`detectionStatus === 'done'`（跑过一次，哪怕一个框都
 *    没检出）→ 跳过。没有这条，封面 / 插图 / 无字页会被每一轮整批检测反复重跑。
 * 4. 其余（从没跑过、或上次跑失败 'failed'）→ 检测 —— 失败页跨重启也会被挑回来补跑。
 *
 * 标记由检测流程写回（成功 = 'done'，请求失败 = 'failed'），随会话 / 工作状态包持久化。
 *
 * 因此升级后第一次整批检测会把所有「没有记忆」的页面（包括老项目里那些以前检出 0 个
 * 框的页面）重跑一遍并记下结果，之后不再重复 —— 老项目不需要额外的开关来补跑。
 *
 * 用户想强制重跑某一页时用「当前图片」范围：那条路径不受这里的任何一条影响。
 */
export const shouldSkipBubbleDetection = (
  page: Pick<UploadedImage, 'regions' | 'detectionStatus'>,
  skipManualOnlyPages: boolean
): boolean => {
  if (page.regions.some((r) => r.detectedClass === 'text_bubble' || r.detectedClass === 'text_free')) {
    return true;
  }
  if (page.regions.some((r) => r.source !== 'auto')) return skipManualOnlyPages;
  return page.detectionStatus === 'done';
};

/**
 * Per-region text style used by the in-place manga text editor.
 * color/outline are written by the AI colour module (translation) and the
 * dock 字色 toggle; fontFamily is the dock 字体 override (see
 * services/fontService.ts); rotation is the dock 旋转 control (degrees, CW).
 */
export interface EditorTextStyle {
  fontSize?: number;      // px; undefined = auto-fit to the region box
  isVertical?: boolean;   // undefined = auto heuristic (tall box / global default)
  color?: string;         // set by the AI colour module / dock 字色 toggle / 吸管; default '#000000'
  /** 字色从哪来：'manual' = 用户手动钉住（dock 黑字/白字、原图吸管），
   *  'auto' = 机器选的（AI 颜色模块，或擦除时量到的原文墨色）。只在
   *  editorAutoTextColor 打开时，合成器才会用实测墨色覆盖非 manual 的值，
   *  所以手动选过的颜色永远不会被悄悄换掉。 */
  colorSource?: 'manual' | 'auto';
  /** 描边色。不显式指定时按字色推：白字黑边，其余（黑字/彩字/灰字）白边。 */
  outlineColor?: string;
  outlineWidth?: number;  // default: auto (fontSize×0.12) when color is explicit, else 0
  isBold?: boolean;       // reserved, default true
  fontFamily?: string;    // this region's font stack; undefined = AppConfig.editorFontFamily (global default)
  /** 整块文字的旋转角度（度，顺时针为正）。0/undefined = 不旋转。
   *  非 0 时文字块以框中心为轴旋转，并改为在框内双向居中（横排平时是靠左的），
   *  这样旋转后溢出是对称的，合成器的对称留白（见 compositeRegionPatch）才成立。 */
  rotation?: number;
}

/**
 * 这一格 AI 重绘的意图（提示词模块的 tab）。它决定：
 *  - 选区提示词用哪个槽（见 Region.customPrompt / customPromptErase / customPromptFree）；
 *  - 译文是否作为上下文拼进重绘 payload（只有 'translate' 拼）；
 *  - AI 结果在编辑器里怎么显示（翻译→已冻结 / 擦除→已擦除 / 自定义→AI 独占只读）。
 * `undefined` = 用户还没表态，运行时沿用提示词模块记忆的 tab。
 */
export type RedrawIntent = 'translate' | 'erase' | 'custom';

/**
 * 当前开关下可用的重绘场景。翻译 / 擦除本质上属于漫画汉化功能（气泡译文、
 * 擦字重绘），所以漫画模块关闭后只剩「自定义」—— UI 用它来决定显示哪几个
 * 场景按钮，管线的实际判定也走同一个来源，两边不会各说各话。
 */
export const availableRedrawIntents = (enableMangaMode: boolean): readonly RedrawIntent[] =>
    enableMangaMode ? ['translate', 'erase', 'custom'] : ['custom'];

/**
 * 把一个场景规整到当前开关可用的范围：漫画模块关闭 → 一律「自定义」，
 * 哪怕 config / region 里存着历史遗留的 'translate' / 'erase'。
 */
export const clampRedrawIntent = (
    intent: RedrawIntent | undefined,
    enableMangaMode: boolean,
    fallback: RedrawIntent = 'translate'
): RedrawIntent => (!enableMangaMode ? 'custom' : intent ?? fallback);

/**
 * 有效重绘意图：本框自己的覆盖 ?? 兜底（一般是全局「默认场景」）。
 *
 * 关键点：**已完成的框不再跟随兜底**。
 * 绝大多数框的标记都是「跟随默认」（redrawIntent 为 undefined），如果它们完成
 * 之后还继续读"当前默认场景"，那么用户改一次默认场景，所有已画好的成品的语义
 * （编辑器显示态、用哪套提示词槽、要不要译文…）都会跟着变 —— 这是错的：完成时
 * 跑的是哪个场景，这个框就永远是哪个场景。
 *
 * 管线在产出结果时会把当时的场景**落库**（见 useImageProcessor 的
 * `redrawIntent: <跑了哪个场景>`），所以正常路径下这里直接读到覆盖值。
 * 老会话的已完成框没有落库值，就从产物形态反推：
 *  - aiErasedBase（AI「擦除」产出的干净底图）→ 一定是 'erase'；
 *  - editorFrozenText（AI「翻译」hold back 的译文）→ 一定是 'translate'。
 */
export const effectiveIntentOf = (
    v: {
        redrawIntent?: RedrawIntent;
        status?: Region['status'];
        aiErasedBase?: boolean;
        editorFrozenText?: string;
    },
    fallback: RedrawIntent = 'translate',
    /** 漫画模块关闭 → 只剩「自定义」：翻译 / 擦除这些漫画场景一律规整回去。 */
    enableMangaMode: boolean = true
): RedrawIntent => {
    if (!enableMangaMode) return 'custom';
    if (v.redrawIntent) return v.redrawIntent;
    if (v.status === 'completed') {
        if (v.aiErasedBase) return 'erase';
        if (v.editorFrozenText?.trim()) return 'translate';
    }
    return fallback ?? 'translate';
};

/**
 * 「AI 判定这一格没有文字」的占位标记 —— 往 editorText 里写一个空格。
 *
 * 整页翻译时模型会对误检出来的空框回 `source:"" / zh:""`，这是一个**合法的
 * 终结答案**，但译文为空 = 没有任何字段能表明「这一格已经处理过」，于是翻译
 * 按钮永远可按、每次都会把整页重新发一遍。写入一个空格就把这个状态落了库。
 *
 * 空格是刻意选的：它不会被排版（textLayout 对纯空白返回 null）、不会产生贴图
 * （regionNeedsComposite 同样 trim 后判断）、也不会被当成「已嵌字」而改变状态；
 * 只有「这一格是否已处理」的判断认它（见 isTranslationHandled）。
 * 用户想强制重翻，把框里的文字清空即可（用户清空写入的是 ''，算未处理）。
 */
export const EMPTY_TEXT_MARK = ' ';

/**
 * 这一格是否已经「处理过」—— 翻译目标选择据此过滤，已处理的框不再重复请求。
 *
 * 这里必须用**存在性**而不是 trim 后的内容：空框的标记就是一个空格，trim 之后
 * 是空串，用 trim 判断永远认不出来（翻译按钮会一直可按）。用户手动清空输入框
 * 写入的是 ''（假值）→ 仍算未处理，可以重新翻译。
 */
export const isTranslationHandled = (
  r: Pick<Region, 'editorText' | 'editorFrozenText' | 'customTranslation'>
): boolean =>
  !!r.editorText || !!r.editorFrozenText?.trim() || !!r.customTranslation?.trim();

export interface Region {
  id: string;
  x: number; // Percentage 0-100 relative to image
  y: number; // Percentage 0-100 relative to image
  width: number; // Percentage 0-100
  height: number; // Percentage 0-100
  type: 'rect'; // Extensible for future shapes
  status: 'pending' | 'processing' | 'completed' | 'failed';
  processedImageUrl?: string; // Object URL of the API-generated patch
  /** The region dimensions at the time processedImageUrl was generated (percentages). Used for display/stitch alignment when the green frame is resized. */
  anchorX?: number;
  anchorY?: number;
  anchorWidth?: number;
  anchorHeight?: number;
  source?: 'manual' | 'auto'; // To distinguish manually drawn vs AI detected regions
  /** Class reported by the detection API. 'bubble' boxes are kept as
   *  context-only markers (reserved for later use); text_bubble / text_free
   *  are the editable text areas in editor mode. */
  detectedClass?: DetectedClass;
  /** 「翻译」tab 的选区提示词（历史上也承载过译文缓存块，已迁出到
   *  customTranslation）。仅当 redrawIntent='translate' 时作为该框的提示词生效。 */
  customPrompt?: string; // Image-specific prompt overrides global prompt
  /** 「擦除」tab 的选区提示词。与 customPrompt 并存、互不覆盖；永不携带译文块。 */
  customPromptErase?: string;
  /** 「自定义」tab 的选区提示词（无默认值）。 */
  customPromptFree?: string;
  /** 这一格的 AI 重绘意图。undefined = 未表态，运行时沿用记忆的 tab。 */
  redrawIntent?: RedrawIntent;
  /** 译文（独立字段，不再塞进提示词里的 marker 块）。翻译阶段写入；
   *  仅当 redrawIntent='translate' 时作为上下文拼进重绘 payload。 */
  customTranslation?: string;
  /** 整页 AI 翻译一并识别出的原文（保留原语言）。仅供展示参考 / 复制，
   *  永不参与排版，也不进重绘 payload。 */
  sourceText?: string;
  /** Visible context only — not translated or painted. Set for `bubble`
   *  outlines: a bubble is the redundant OUTER box around a `text_bubble` and
   *  is dropped by detection whenever it encloses text (see DetectedClass), so
   *  only empty bubbles reach here. */
  contextOnly?: boolean;
  restoreBoxes?: RestoreBox[]; // Box-based restore regions (框选还原)
  restoreMaskUrl?: string; // Brush-based restore mask Object URL (涂抹还原), alpha=1=processed, 0=original

  // --- In-place manga text editor (editor workflow mode) ---
  editorText?: string;        // Edited/typeset text
  editorErased?: boolean;     // Original text inside the region has been flood-fill erased
  editorStyle?: EditorTextStyle; // Typeset style overrides
  editorBrushUrl?: string;    // Transparent brush-stroke layer Object URL (region-crop sized)
  editorComposited?: boolean; // processedImageUrl was produced by the editor compositor
  /** AI translation held back from the image (翻译冻结): the editor keeps the
   *  translated text here without typesetting it — used for sfx / stylized
   *  lettering / text_free on complex backgrounds that are left for AI redraw.
   *  Field present (non-empty) = region is frozen; unfreezing moves it into
   *  editorText and typesets it. */
  editorFrozenText?: string;
  /** Brute-force whiteout: the compositor fills the whole crop white (after
   *  erasure, before text) — the crude "先让我看一眼译文" preview for frozen
   *  boxes sitting on complex backgrounds the editor can't erase. Only ever
   *  set by the batch 「临时预览译文」action, which is what makes its reverse
   *  (「结束预览」) able to recognise its own output. */
  editorWhitedOut?: boolean;
  /** LEGACY: set when a completed AI-redrawn bubble fully contains this text
   *  region (the bubble's patch already wiped the original text, so the
   *  region's base is clean). Bubble-outline redraw has been removed, so no
   *  new region gets this flag — kept only so old persisted sessions still
   *  composite correctly. Effects:
   *  - editor composites text ON TOP of the AI bubble patch (not the
   *    original crop) and skips erasure;
   *  - batch erase skips it; batch translation still runs but holds the
   *    result frozen (editorFrozenText) until the user reveals it. */
  aiBubbleBase?: boolean;
  /** Set when an AI-redraw completed this box under the 「擦除」intent: the box's
   *  own patch is already a text-free base. Effects:
   *  - the editor composites text ON TOP of this AI patch and never erases
   *    (the base is clean) — any editor erasure this box already had is
   *    INVALIDATED when the AI result lands (see useMangaEditor's cleanup
   *    effect): AI 产物绝对优先，编辑器的擦除结果一律让位；
   *  - the box stays editable (NOT AI-owned) so the user can typeset into it. */
  aiErasedBase?: boolean;
  /** AI「擦除」产物本体（干净底图，Object URL，独立所有）。
   *  必须和 processedImageUrl 分开存：合成器一旦跑过，processedImageUrl 就是
   *  「底图 + 文字」的成品，再拿它当底图会把上一版文字烤进去（改字/拖框重影）；
   *  而"没有东西可渲染"时 processedImageUrl 会被连带清掉，底图也会一起消失
   *  （于是退回原图、原文又露出来）。编辑器每次都从这一份底图重建贴图。 */
  aiEraseBaseUrl?: string;
  /** Editor patch overflow margin beyond the anchor box, as % of the full image
   *  width/height (patch extends this far past the crop on each side so
   *  overflowing text stays visible). 0/undefined = crop-sized patch. */
  patchMarginX?: number;
  patchMarginY?: number;

  // Retry diagnostics. retryCount counts failed attempts in the current run
  // (cleared when the user manually triggers a fresh processing pass on this
  // region). errorHistory keeps short error messages for the same attempts —
  // surfaced in UI only when AppConfig.showRetryDiagnostics is on.
  retryCount?: number;
  errorHistory?: string[];
}

export interface ImageHistoryState {
  previewUrl: string;
  regions: Region[];
  finalResultUrl?: string;
  width: number;
  height: number;
  fullAiResultUrl?: string; // Added to history
  /** True when this snapshot is a committed 应用为原图 result (see UploadedImage). */
  appliedAsOriginal?: boolean;
}

export interface UploadedImage {
  id: string;
  file: File;
  previewUrl: string;       // Display URL (may be compressed in balanced mode)
  originalUrl: string;      // Untouched source file, full resolution (never compressed). API crops must go through baseImageUrl(), not this directly.
  /**
   * Set once 应用为原图 commits the current result: previewUrl now IS the picture
   * the canvas shows, while originalUrl still holds the pre-apply source file
   * (kept at full resolution for API crops). Export resolvers must therefore
   * read previewUrl instead of falling back to originalUrl. Cleared by
   * undo/redo when the state is rolled back before the apply.
   */
  appliedAsOriginal?: boolean;
  thumbnailUrl: string;     // Small thumbnail for gallery
  originalWidth: number;
  originalHeight: number;
  regions: Region[];
  finalResultUrl?: string; // The stitched final image
  fullAiResultUrl?: string; // The raw full-size output from the AI (before any cropping)
  isSkipped?: boolean; // If true, excluded from batch processing (still exportable, as its result view)
  customPrompt?: string; // Full image specific prompt
  /** 自动检测气泡的「记忆」：这页最后一次检测的结果，随会话 / 工作状态包持久化。
   *  跳过判定用它（见 shouldSkipBubbleDetection），所以整批检测不会反复重跑已经跑过
   *  的页面 —— 哪怕是「一个框都没检出」的空结果页。'应用为原图' 会把内容换掉，那时
   *  标记随之清空（旧记忆描述的是旧画面）。 */
  detectionStatus?: DetectionStatus;
  /** 全图遮罩模式下的「图片级意图 / 三套 tab 提示词 / 图片级译文」。语义同 Region。 */
  redrawIntent?: RedrawIntent;
  customPromptErase?: string;
  customPromptFree?: string;
  customTranslation?: string;
  
  // History for Undo/Redo of "Apply as Original"
  history: ImageHistoryState[];
  historyIndex: number;
}

/**
 * The picture the canvas currently shows as its base — the correct source for
 * AI crops, masks and payloads.
 *
 * Normally that is the untouched full-resolution original (the preview may be a
 * downscaled copy in balanced mode). After 应用为原图 the preview IS the
 * committed picture while originalUrl still holds the pre-apply file, so
 * reading the original would send the AI the OLD image and misalign every
 * region box (which the user drew on the new one).
 */
export const baseImageUrl = (
  img: Pick<UploadedImage, 'appliedAsOriginal' | 'originalUrl' | 'previewUrl'>
): string => (img.appliedAsOriginal ? img.previewUrl : (img.originalUrl || img.previewUrl));

export type AiProvider = 'openai' | 'gemini';

/**
 * OpenAI 兼容链路上用哪种图片接口（连接设置里可切）：
 * - 'chat'：POST /v1/chat/completions，把切片塞进 messages 的多模态对话式生图
 *           （历史默认，兼容面最广）；
 * - 'edit'：POST /v1/images/edits，图像专用「图生图」接口
 *           （multipart/form-data 上传原图 + prompt）。
 *
 * 没有接 /v1/images/generations：那是纯文生图，不接受输入原图，接进来只会
 * 丢掉我们裁好的切片，与图生图管线天然不兼容。
 */
export type OpenAIImageEndpointMode = 'chat' | 'edit';

export type ThemeType = 'light' | 'dark' | 'ocean' | 'rose' | 'forest';

export type Language = 'zh' | 'en';

export type ProcessingMode = 'api' | 'manual' | 'editor';

/**
 * 画布标签页。
 *
 * 分成两类：
 *  - **查看页**：`original` 准备 = 只看原图；`result` 已完成 = 只看结果图。
 *    两处都不画框（准备页以前也画框、也能框选，现在统一收到工作页里）。
 *  - **工作页**：`edit` 编辑（编辑器）/ `redraw` 重绘（AI 重绘）/ `patch` 修补
 *    （手动修补工坊）。三者等价：框可见可交互（选中/移动/缩放/画新框）+ 框内
 *    贴图实时预览，所以能一边改一边看结果。
 */
export type ViewMode = 'original' | 'result' | 'edit' | 'redraw' | 'patch';

/** 工作页 = 画框 + 贴图预览（编辑 / 重绘 / 修补）。 */
export const isWorkView = (v: ViewMode): boolean => v === 'edit' || v === 'redraw' || v === 'patch';

/** 每个工作流对应的工作页 —— 切换工作流 / 首次进入时自动落到它。 */
export const workViewOf = (mode: ProcessingMode): ViewMode =>
    mode === 'editor' ? 'edit' : mode === 'manual' ? 'patch' : 'redraw';

export type PerformanceMode = 'unlimited' | 'balanced';

/**
 * A saved API endpoint preset: base URL + API key + model, name-labelled.
 * Several of them are kept side by side (one per relay / vendor / account) so
 * the user can switch endpoints in one click instead of retyping the triple.
 * Persisted inside AppConfig (→ localStorage), one list per API family.
 */
export interface ApiProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 思考强度（翻译调用）：透传给 OpenAI 兼容接口的 `reasoning_effort`。
 *
 *  - 'none'   不思考（最低档，翻译这种轻任务默认就用它：更快、更省 token）
 *  - 'low'    'medium'  'high'  逐级加大模型思考预算
 *
 * 只会加到**翻译端点**的请求体（/chat/completions）上：编辑器整页翻译、
 * 单框翻译、术语表 AI 选择。AI 重绘走图片端点，不受它影响。
 */
export type TranslationReasoningEffort = 'none' | 'low' | 'medium' | 'high';

/** 翻译请求体里要并入的 `{ reasoning_effort }` 片段；未配置时不发该字段。 */
export const translationReasoningParams = (
  effort: TranslationReasoningEffort | undefined,
): { reasoning_effort?: TranslationReasoningEffort } =>
  effort ? { reasoning_effort: effort } : {};

/** 档位顺序（低 → 高），两处设置面板共用，避免选项漂移。 */
export const TRANSLATION_REASONING_EFFORTS: readonly TranslationReasoningEffort[] =
  ['none', 'low', 'medium', 'high'];

/** 档位 → i18n 文案 key（zh / en 均已提供）。 */
export const TRANSLATION_REASONING_LABEL_KEYS: Record<
  TranslationReasoningEffort,
  'reasoningNone' | 'reasoningLow' | 'reasoningMedium' | 'reasoningHigh'
> = {
  none: 'reasoningNone',
  low: 'reasoningLow',
  medium: 'reasoningMedium',
  high: 'reasoningHigh',
};

export interface AppConfig {
  prompt: string;
  /** 默认重绘场景：所有**没有单独改过**的切片（region / 全图模式下的图片）
   *  都走它；单独改过的切片走自己的 redrawIntent。见 RedrawIntent。 */
  defaultRedrawIntent: RedrawIntent;
  // Execution Mode is now effectively handled by concurrencyLimit
  // 1 = Serial, >1 = Concurrent
  executionMode: 'concurrent' | 'serial'; 
  concurrencyLimit: number;
  
  // Advanced: If an image has no regions, process the whole image
  processFullImageIfNoRegions: boolean;
  
  // Retry & Timeout Settings
  apiTimeout: number; // in milliseconds
  maxRetriesPerRegion: number; // per-region retry budget (excludes first attempt). Standard mode: each region counts independently. Full-image-masking mode: all regions in an image share one counter (one API call per image).
  /** 整批「跑完再重试」轮数（0 = 关闭）：一次翻译/重绘 sweep 结束后扫描图库，
   *  只要还有未处理（pending）或处理失败（failed）的框，就整体再跑一轮，最多
   *  这么多轮。与 maxRetriesPerRegion（单轮内同一框的尝试次数）相互独立。 */
  maxRetryRounds: number;
  showRetryDiagnostics: boolean; // show per-region retry count badge + error history

  // Workflow Mode
  processingMode: ProcessingMode;

  // Performance Mode
  performanceMode: PerformanceMode;

  /** Persist the editing session to IndexedDB so it survives reloads/tab
   *  discards. When false, nothing is written to disk (and any previously
   *  persisted session is wiped) — the user should exempt the site from the
   *  browser's tab sleeping to avoid losing work. */
  enableSessionPersistence: boolean;
  
  // Theme & Language
  theme: ThemeType;
  language: Language;

  // Provider Settings
  provider: AiProvider;
  
  // OpenAI Specifics
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  /** OpenAI 兼容链路用哪种图片接口（见 OpenAIImageEndpointMode）。默认 'chat'。 */
  openaiImageEndpointMode: OpenAIImageEndpointMode;

  /**
   * AI 重绘请求的**附加参数**：一段 JSON 对象文本（可留空）。
   *
   * 绝大多数接口不需要它，所以留空 = 请求体与以前完全一致（一个字节都不多
   * 发）。填了就原样并进重绘请求的负载：
   *  - OpenAI 兼容链路：chat 并入 JSON body，edits 并入 multipart 表单字段；
   *  - Gemini 原生：并入 generateContent 的 config。
   *
   * 典型用途是中转站 / 自部署后端的私有开关，例如
   * `{"size": "512x512", "num_inference_steps": 8}`。
   * 解析不出对象（空串 / 语法错 / 数组）时**静默忽略**，不让手滑的 JSON
   * 变成一次重绘失败；同名键会覆盖内置字段（model / prompt 等）。
   */
  imageApiExtraParams: string;

  // Saved image-generation endpoints (OpenAI-compatible). Switching a preset
  // writes its url/key/model into the openai* fields above.
  imageApiProfiles: ApiProfile[];
  /** id of the preset the openai* fields currently mirror (null = custom values). */
  activeImageApiProfileId: string | null;

  enableSquareFill: boolean; // New: Pad image to 1:1 square (blurred background) before sending
  squareFillSize: number; // px: square edge length for square fill (content is never downscaled below its original size)
  squareFillCropInset: number; // px: extra pixels trimmed from every side when cropping back (0 = exact original-ratio box)
  
  // Gemini Specifics
  geminiApiKey: string;
  geminiModel: string;

  // Backend Detection Settings (Python)
  pythonBackendUrl: string; // Unified Python backend base URL, e.g. http://localhost:5001 (hosts /detect, /erase, /health)
  
  // Detection Tuning
  detectionInflationPercent: number; // e.g. 10 for 10% expansion
  detectionOffsetXPercent: number; // e.g. 0
  detectionOffsetYPercent: number; // e.g. 0
  detectionConfidenceThreshold: number; // e.g. 30 for 0.3
  /** 自动检测气泡的跳过策略：开着 = 「只剩手画框、还没有任何文字区」的页面也跳过
   *  （用户手框过就当他处理过这页了），关着 = 这类页面照旧检测。已经有文字区的页面
   *  无论开关如何都会被跳过。判定见 types.ts → shouldSkipBubbleDetection。 */
  detectionSkipManualOnlyPages: boolean;
  
  // Manga Module Settings (New Structure)
  enableMangaMode: boolean;        // Master switch
  enableBubbleDetection: boolean;  // Sub switch: Auto-detect regions
  enableManualEditor: boolean;     // Sub switch: Brush/Text editor
  enableVerticalTextDefault: boolean; // Sub switch: Default text orientation
  /** 嵌字默认字体：services/fontService.ts 里的字体 id，'' = 系统默认。
   *  字体文件由 Python 后端首次请求时下载并缓存（server/fonts/），前端按需取用。 */
  editorFontFamily: string;

  /** 自动取色（嵌字）：擦除文字时顺手量出原文墨色（后端 /erase 的响应头，
   *  后端不可用时用浏览器内置算法的统计值），嵌字直接沿用，不再依赖视觉模型
   *  猜「黑/白」。量不出来（文字像素太少）时回落到原行为。手动选过的字色
   *  （dock 黑字/白字、吸管）不受影响 —— 见 EditorTextStyle.colorSource。 */
  editorAutoTextColor: boolean;

  // Logic Switch
  useFullImageMasking: boolean; // Send full image with non-selected areas masked white
  useInvertedMasking: boolean; // New: Selected areas are masked white (AI generates BG), Orginal regions kept.
  fullImageOpaquePercent: number; // 0-100, default 99. Determines how much of the center is opaque before feathering starts.

  // Translation Mode Settings
  enableTranslationMode: boolean;
  sendMaskedContextForTranslation: boolean;
  /** 字体自动识别（嵌字）：翻译时让视觉模型一并判断每个区域原文的字体风格，
   *  并从 services/fontService 的内置字体库里挑一个，嵌字时按区域套用。
   *  关闭 = 所有区域统一用全局 editorFontFamily。只影响编辑器嵌字，
   *  AI 重绘模式由模型自己画字，不受此开关影响。 */
  enableFontAutoDetect: boolean;
  translationBaseUrl: string;
  translationApiKey: string;
  translationModel: string;
  /** 思考强度：作为 `reasoning_effort` 发给翻译端点。'none' = 不思考（最低档）。
   *  见 TranslationReasoningEffort。 */
  translationReasoningEffort: TranslationReasoningEffort;

  // Saved translation endpoints (OpenAI-compatible), same model as imageApiProfiles.
  translationApiProfiles: ApiProfile[];
  /** id of the preset the translation* fields currently mirror (null = custom). */
  activeTranslationApiProfileId: string | null;

  translationPrompt: string;
  /** User's custom prompt for translation WITHOUT masked context (cached) */
  translationPromptNoContext?: string;
  /** User's custom prompt for translation WITH masked context (cached) */
  translationPromptWithContext?: string;

  /** 必须翻译: the redraw pipeline only touches regions whose translation has
   *  already been filled in (image-level cache in full-image-masking mode).
   *  Regions without one are skipped — left 'pending', not failed — and are
   *  re-checked on the next retry round / next run, so the user can run the
   *  translate stage whenever and then hit generate. Requires
   *  enableTranslationMode. */
  requireTranslationForGeneration: boolean;

  /** 重绘前翻译 (legacy behaviour, opt-in): when on together with
   *  enableTranslationMode, the redraw pipeline fills a missing translation
   *  inline (one extra translation call, cached like the translate stage would)
   *  and then paints with it as context — instead of redrawing without it and
   *  waiting for the separate 「翻译」 stage. Off by default: the two stages are
   *  decoupled and redraw only consumes the existing cache. While on it
   *  supersedes requireTranslationForGeneration's skip (a missing translation
   *  is auto-filled rather than waited for). */
  translateBeforeRedraw: boolean;

  /** 术语表 v2：已选定标准的术语，之后新翻页再出现该术语的其他译名时，
   *  自动替换成已选译名（本地字符串替换 + 重排，无 API 调用）。
   *  见 services/glossaryBook.ts / hooks/useGlossary.ts。 */
  glossaryAutoUnify: boolean;
  /** 整批翻译结束后自动发起一次「AI 选择标准译名」（纯文本调用，只处理有多种
   *  译名且尚未人工选择的术语）。默认关：这是一次 API 调用，由用户决定。 */
  glossaryAutoAiSelect: boolean;

  /** When true, images sent to translation/redraw APIs are re-encoded to WebP
   *  at a target file size (binary search on quality). Preserves pixel
   *  dimensions — no resampling. When false, raw originals are sent. */
  enableAiPayloadCompression: boolean;
  /** Target size in KB for the translation API payload + context image. */
  aiPayloadTranslationTargetKB: number;
  /** Target size in KB for the redraw (image edit) API payload. */
  aiPayloadRedrawTargetKB: number;
}

export enum ProcessingStep {
  IDLE = 'IDLE',
  CROPPING = 'CROPPING',
  API_CALLING = 'API_CALLING',
  STITCHING = 'STITCHING',
  DONE = 'DONE',
}

// =====================================================================
// 术语表 v2（workspace 级，见 services/glossaryBook.ts）
//
// 翻译不注入术语：每页翻译返回本页出现的术语（原文 + 本页实际译名），
// 按原文聚合成树 —— 一个 key 挂多个译名变体。人工或 AI 从变体里选定标准
// 译名后，本地替换统一所有锚定框的译文（不重新翻译）。
// =====================================================================

/** 一个译名变体出现位置的锚点。 */
export interface GlossaryRef {
  imageId: string;
  regionId: string;
}

/** 一个译名变体 + 它出现过的所有锚点（频次 = refs.length）。 */
export interface GlossaryVariant {
  value: string;
  refs: GlossaryRef[];
  /**
   * 用户自己填的译名槽位（每术语最多一个）：AI 译名之外的手写译名。
   *
   * 与 AI 变体走完全相同的选定 / 统一替换路径，但：
   *  - 不参与 AI 选择的候选（模型只从它自己译出的变体里挑，见 aiVariants）；
   *  - 不新建统计分支：之后某页的译名恰好等于它时，只往这个槽位叠加锚点，
   *    不会在同一条术语下出现两个同值变体；
   *  - 导出 / 导入 / 会话持久化照常保留这个标记。
   */
  custom?: boolean;
}

/**
 * 一条术语：原文 key + 翻译中实际出现过的译名变体（可含一个用户自定义槽位）。
 * selected = 选定的标准译名下标（variants 内）；null = 尚未统一。
 * note = AI 选择时给的理由（可选，仅展示）。
 */
export interface GlossaryTerm {
  key: string;
  variants: GlossaryVariant[];
  selected: number | null;
  note?: string;
}