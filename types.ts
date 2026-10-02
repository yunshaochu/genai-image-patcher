
export interface RestoreBox {
  id: string;
  x: number;       // Percentage 0-100 relative to the region (not the full image)
  y: number;
  width: number;
  height: number;
  inverse: boolean; // true = keep AI result inside box, restore outside
}

/** Detection classes returned by the comic-detector API (docs/API_RTDTR.md) */
export type DetectedClass = 'bubble' | 'text_bubble' | 'text_free';

/**
 * Which detected class the AI redraw pipeline paints.
 * 'text'   — text_bubble + text_free (precise text boxes; best with strong
 *            models like the banana series). Default, historical behavior.
 * 'bubble' — whole bubble outlines + text_free (redrawing the entire bubble
 *            is far more forgiving for weaker models).
 * Manual regions are always paintable regardless of this setting.
 */
export type GenerationRegionSource = 'text' | 'bubble';

/**
 * Decides whether a region enters the AI redraw pipeline (masked + painted)
 * and is shown as a working box in the AI-generation canvas. Editor-mode
 * visibility is NOT governed by this — the editor always works on text
 * regions (see contextOnly).
 */
export const isRegionPaintable = (
  r: Pick<Region, 'source' | 'detectedClass' | 'contextOnly'>,
  source: GenerationRegionSource = 'text'
): boolean => {
  if (r.source === 'auto' && r.detectedClass) {
    // text_free is a work unit in both modes (no bubble outline covers it).
    if (r.detectedClass === 'text_free') return true;
    return source === 'bubble'
      ? r.detectedClass === 'bubble'
      : r.detectedClass === 'text_bubble';
  }
  // Manual / legacy regions keep the historical contextOnly semantics.
  return !r.contextOnly;
};

/**
 * Per-region text style used by the in-place manga text editor.
 * color/outline are written by the AI colour module (translation) and the
 * dock 字色 toggle; fontFamily is the dock 字体 override (see
 * services/fontService.ts); rotation remains reserved for a future UI.
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
  rotation?: number;      // reserved, default 0
}

/**
 * 这一格 AI 重绘的意图（提示词模块的 tab）。它决定：
 *  - 选区提示词用哪个槽（见 Region.customPrompt / customPromptErase / customPromptFree）；
 *  - 译文是否作为上下文拼进重绘 payload（只有 'translate' 拼）；
 *  - AI 结果在编辑器里怎么显示（翻译→已冻结 / 擦除→已擦除 / 自定义→AI 独占只读）。
 * `undefined` = 用户还没表态，运行时沿用提示词模块记忆的 tab。
 */
export type RedrawIntent = 'translate' | 'erase' | 'custom';

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
  contextOnly?: boolean; // If true, region is visible context only — not translated or painted
  ocrText?: string; // Detected text from OCR
  isOcrLoading?: boolean; // Loading state for OCR
  restoreBoxes?: RestoreBox[]; // Box-based restore regions (框选还原)
  restoreMaskUrl?: string; // Brush-based restore mask Object URL (涂抹还原), alpha=1=processed, 0=original

  // --- In-place manga text editor (editor workflow mode) ---
  editorText?: string;        // Edited/typeset text (falls back to ocrText when unset)
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
   *  erasure, before text) — the no-redraw-model fallback for frozen
   *  text_free on complex backgrounds. Only ever set by the batch
   *  「涂白 text_free 并解冻」action, which is what makes its reverse
   *  (「再次冻结」) able to recognise its own output. */
  editorWhitedOut?: boolean;
  /** Set when a completed AI-redrawn bubble (generationRegionSource='bubble')
   *  fully contains this text region: the bubble's patch already wiped the
   *  original text, so the region's base is clean. Effects:
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
  ocrApiUrl: string; // e.g. http://localhost:5000/ocr
  
  // Detection Tuning
  detectionInflationPercent: number; // e.g. 10 for 10% expansion
  detectionOffsetXPercent: number; // e.g. 0
  detectionOffsetYPercent: number; // e.g. 0
  detectionConfidenceThreshold: number; // e.g. 30 for 0.3
  generationRegionSource: GenerationRegionSource; // Which detected class the AI redraw pipeline paints (default 'text')
  
  // Manga Module Settings (New Structure)
  enableMangaMode: boolean;        // Master switch
  enableBubbleDetection: boolean;  // Sub switch: Auto-detect regions
  enableOCR: boolean;              // Sub switch: Text recognition
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

  /** Maintain a project-wide 术语表 while translating: each translation call
   *  also reports the term pairs it used, which are merged into `glossaryText`
   *  and fed back into the following translation prompts so naming stays
   *  consistent across every page. No new terms = no update. */
  enableGlossary: boolean;
  /** The glossary itself: one `原文 | 译文 | 备注` per line (备注 optional). */
  glossaryText: string;

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