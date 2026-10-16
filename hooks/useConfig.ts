
import { useState, useEffect, useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { AppConfig, RedrawIntent } from '../types';
import { EDITOR_FONTS } from '../services/fontService';

const CONFIG_STORAGE_KEY = 'genai_patcher_config_v3';
/** Records that the user's config has already been migrated to the opt-in
 *  session-persistence default (see useConfig). */
const SESSION_PERSISTENCE_OPTIN_KEY = 'genai_patcher_session_persistence_optin_v1';

/**
 * 全局默认提示词 —— 只放**所有意图共用**的不变量（比例 / 禁止续画 / 只改指定处）。
 *
 * 翻译替换、擦除文字、任意自定义这些**意图相关**的指令不属于全局：它们放在
 * 选区提示词（见 DEFAULT_TRANSLATE_REGION_PROMPT / DEFAULT_ERASE_REGION_PROMPT），
 * 否则切到「擦除」tab 时，全局里那句「替换为中文」会和擦除意图打架。
 */
export const DEFAULT_PROMPT = `1. 严格维持我发给你的图片大小和比例，包括高斯模糊的分界线也不能变。这种严格的比例控制对我的项目来说是必要的。
2. 强调：不是让你续写、续画，而是严格按我的指令修改这张图的指定内容。
3. 只改我指定要改的地方，其余部分保持原样。`;

/**
 * 迁移用：旧版全局默认提示词（内含「翻译替换」意图）。仅当老用户的
 * config.prompt 与它一字不差（即从未自己改过）时，才替换为新的不变量版——
 * 用户自己写过的内容一律保留，避免覆盖他们的手工调校。
 */
const LEGACY_DEFAULT_PROMPT = `1. 请用中文翻译替换掉图片里的日文。如果原图是艺术字，那么要和原图一样，用富有艺术性的字体来画出中文，不能用打印体，要富有艺术性。
2. 生成一张只有中文的图
3. 强调：不是让你续写、续画，而是对这张图的文字进行更换，换为中文
4. 图片大小和比例不许变，必须严格维持我发给你的比例，包括高斯模糊的地方的分界线也不能变。这种严格的比例控制对我的项目来说是必要的。`;

/** 「翻译」tab 的选区默认提示词（物化进 customPrompt）。 */
export const DEFAULT_TRANSLATE_REGION_PROMPT = `请用中文翻译替换掉图里的日文。如果原图是艺术字，那么要和原图一样，用富有艺术性的字体来画出中文，不能用打印体，要富有艺术性。`;

/** 「擦除」tab 的选区默认提示词（物化进 customPromptErase）。 */
export const DEFAULT_ERASE_REGION_PROMPT = `把图中文字完整擦除，不要添加任何新文字（尤其不要写中文）。
1. 原图里有气泡的：保留气泡的边框和底色，只擦掉里面的文字。
2. 原图里没有气泡的：直接把文字擦成干净的背景，绝对不要凭空新增一个气泡或边框。
3. 网点、渐变、人物、景物等画面内容保持原样。`;

/** 意图对应的选区默认提示词。'custom' 没有默认值（空 = 只带全局不变量）。 */
export const defaultRegionPrompt = (intent: RedrawIntent): string =>
  intent === 'translate' ? DEFAULT_TRANSLATE_REGION_PROMPT
    : intent === 'erase' ? DEFAULT_ERASE_REGION_PROMPT
      : '';

export const TRANSLATION_MODE_IMAGE_PROMPT = `1. 请用中文翻译替换掉图片里的日文。如果原图是艺术字，那么要和原图一样，用富有艺术性的字体来画出中文，不能用打印体，要富有艺术性。
2. 生成一张只有中文的图
3. 强调：不是让你续写、续画，而是对这张图的文字进行更换，换为中文
4. 图片大小和比例不许变，必须严格维持我发给你的比例，包括高斯模糊的地方的分界线也不能变。这种严格的比例控制对我的项目来说是必要的。`;

export const DEFAULT_TRANSLATION_PROMPT = `> **角色设定**：
> 你是专业的漫画汉化组成员，负责提取文本、定位和翻译。
>
> **任务目标**：
> 识别图片中的所有日语文字，并将其翻译成流畅的中文。
>
> **核心要求（严格执行）**：
> 1.  **禁止闲聊**：**绝对不要**输出任何开场白（如"好的，这是翻译..."）、结束语或解释性文字。直接输出翻译内容。
> 2.  **分镜结构**：必须按照漫画的分镜格（Panel）顺序，从上到下、从右到左排列。
> 3.  **视觉锚点**：对于每一处文字，必须描述其在画面中的具体位置（例如："长发女生的对话框"、"背景左侧的竖排心理描写"），以便我进行嵌字。
> 4.  **格式规范**：请严格遵守下方的输出格式。
>
> **输出格式模板**：
>
> ### [分镜描述，如：第一格（上方大图）]
> *   **[具体位置/说话人]**： [日语原文] ——> **[中文翻译]**
> *   **[具体位置/说话人]**： [日语原文] ——> **[中文翻译]**
>
> ---
>
> ### [分镜描述，如：第二格（左下）]
> *   **[具体位置/说话人]**： [日语原文] ——> **[中文翻译]**
>
> （以此类推...）`;

export const TRANSLATION_CONTEXT_SYSTEM_PROMPT = `> **角色设定**：
> 你是专业的漫画汉化组成员，负责提取文本、定位和翻译。
>
> **重要说明**：
> 本次请求包含两张图片：
> - **第1张图片（小图）**：从漫画中截取的**需要翻译的局部切片**。**只需要翻译这一小张图**里面的文字。
> - **第2张图片（大图）**：整页漫画的**遮罩全图**（非选区部分已涂白），仅用于提供**上下文参考**（如对话场景、人物关系、画面氛围等）。**绝对不要翻译**第2张图里可见区域的任何文字。
>
> **核心要求（严格执行）**：
> 1.  **翻译范围**：**只翻译第1张切片图片中的文字**，第2张大图仅作上下文参考。
> 2.  **禁止闲聊**：**绝对不要**输出任何开场白（如"好的，这是翻译..."）、结束语或解释性文字。直接输出翻译内容。
> 3.  **视觉锚点**：对于每一处文字，必须描述其在第1张切片图中的具体位置（例如："左上角对话框"、"右侧竖排小字"），以便我进行嵌字。
> 4.  **格式规范**：请严格遵守下方的输出格式。
>
> **输出格式模板**：
>
> *   **[位置描述]**： [日语原文] ——> **[中文翻译]**
> *   **[位置描述]**： [日语原文] ——> **[中文翻译]**
>
> （以此类推...）`;

const DEFAULT_CONFIG: AppConfig = {
  prompt: DEFAULT_PROMPT,
  defaultRedrawIntent: 'translate',
  executionMode: 'concurrent',
  concurrencyLimit: 3,
  processFullImageIfNoRegions: false, 
  apiTimeout: 150000, // 150 seconds default
  maxRetriesPerRegion: 1,
  maxRetryRounds: 3,
  showRetryDiagnostics: false,
  theme: 'light',
  language: 'zh',
  provider: 'openai',
  performanceMode: 'unlimited',
  enableSessionPersistence: false, // opt-in: persisting the session occupies local disk space
  openaiBaseUrl: 'http://localhost:7860/v1',
  openaiApiKey: '',
  openaiModel: 'gemini-imagen',
  // OpenAI 兼容链路的图片接口形态：'chat' = /v1/chat/completions（历史默认），
  // 'edit' = /v1/images/edits（图像专用图生图接口，multipart 上传原图）。
  openaiImageEndpointMode: 'chat',
  // 附加请求参数：留空 = 不发任何额外字段（见 AppConfig.imageApiExtraParams）
  imageApiExtraParams: '',
  // Saved API presets (quick switch between url/key/model triples)
  imageApiProfiles: [],
  activeImageApiProfileId: null,
  enableSquareFill: true, // Default true: keeps the generated result from distorting the original ratio
  squareFillSize: 1024, // px: square edge length for square fill padding
  squareFillCropInset: 0, // px: extra pixels trimmed from every side when cropping back
  geminiApiKey: process.env.API_KEY || '',
  geminiModel: 'gemini-2.5-flash-image', 
  processingMode: 'api',
  // Default to localhost for Python backend development
  // Unified backend (server/, see docs/API_RTDTR.md) listens on 5001
  pythonBackendUrl: 'http://localhost:5001',
  
  // Detection Tuning Defaults
  detectionInflationPercent: 5,
  detectionOffsetXPercent: 0,
  detectionOffsetYPercent: 0,
  // 置信度过滤默认 0.3（= DETECTION_CONFIDENCE_FLOOR，滑块下限）：检测按此下限取框，
  // 用户可在「当前图片 / 全部图片」上调高，实时隐藏低分框。
  detectionConfidenceThreshold: 30,
  // 跳过策略默认关：只有手画框的页面照旧检测（= 与历史行为一致）。
  detectionSkipManualOnlyPages: false,
  // 文字掩码精准擦除默认关：开后端要多加载一个分割模型，检测变慢。
  detectionTextMask: false,
  
  // Manga Module Defaults
  enableMangaMode: false,
  enableBubbleDetection: true,
  enableManualEditor: true,
  enableVerticalTextDefault: false,
  editorFontFamily: '', // '' = 系统默认字体；其余 id 见 services/fontService.ts
  editorAutoTextColor: false, // 擦除时量出的原文墨色是否直接用于嵌字
  
  // New Logic Toggle
  useFullImageMasking: false,
  useInvertedMasking: false,
  fullImageOpaquePercent: 90, 

  // Translation Defaults
  enableTranslationMode: false,
  sendMaskedContextForTranslation: false,
  enableFontAutoDetect: false,
  translationBaseUrl: 'http://localhost:7860/v1',
  translationApiKey: '',
  translationModel: 'gemini-3-flash-preview',
  // 思考强度：'none' = 不思考（翻译默认最低档）。
  translationReasoningEffort: 'none',
  translationApiProfiles: [],
  activeTranslationApiProfileId: null,
  translationPrompt: DEFAULT_TRANSLATION_PROMPT,
  translationPromptNoContext: '',
  translationPromptWithContext: '',
  // 编辑器翻译的提示词模板：'' = 用内置默认（见 types.ts → editorTranslationPrompt）
  editorTranslationPrompt: '',
  requireTranslationForGeneration: false,
  translateBeforeRedraw: false,
  glossaryAutoUnify: true,
  glossaryAutoAiSelect: false,

  /** 擦除判定默认关：翻译端点不一定收得下两张图，预擦除也要多花几秒。 */
  enableEraseJudgedFreeze: false,
  /** 子开关也默认关 = 拟声词/语气词照旧一律冻结（与不开擦除判定时一致）。 */
  enableEraseJudgedFreezeForSfx: false,
  /** 重绘标记默认关：它会决定冻结框之后走哪个重绘场景，不该替用户决定。 */
  enableAiRedrawIntentMarking: false,
  enableMarkTranslateIntent: false,
  enableMarkEraseIntent: false,

  // AI Payload Compression Defaults
  enableAiPayloadCompression: true,
  /** 长边上限默认 0 = 不限：沿用「原分辨率直发」的老行为。清晰度与 token 的取舍
   *  交给用户自己定 —— 设置面板上列了参考值（2048 / 1536 / 1280），也说了怎么用
   *  「发送记录」对照微调。 */
  aiPayloadTranslationMaxPx: 0,
  aiPayloadTranslationTargetKB: 500,
  aiPayloadRedrawTargetKB: 1500,
};

/** A fresh factory-default config. Returns a new object with new array
 *  instances, so a reset can never hand out references shared with
 *  DEFAULT_CONFIG (a later `profiles.push(...)` would otherwise corrupt the
 *  defaults for the rest of the session). */
export const createDefaultConfig = (): AppConfig => ({
  ...DEFAULT_CONFIG,
  imageApiProfiles: [],
  translationApiProfiles: [],
});

export function useConfig() {
  const [config, setConfigState] = useState<AppConfig>(() => {
    try {
      const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        const geminiKey = parsed.geminiApiKey || process.env.API_KEY || '';
        
        // Migration logic for old config to new Manga Mode structure
        const migratedConfig = { 
            ...DEFAULT_CONFIG, 
            ...parsed, 
            geminiApiKey: geminiKey,
            language: parsed.language || 'zh' 
        };

        // If 'enableSmartAssist' existed in old config, map it to 'enableMangaMode'
        if ('enableSmartAssist' in parsed) {
            migratedConfig.enableMangaMode = parsed.enableSmartAssist;
            delete migratedConfig.enableSmartAssist;
        }

        // The Enable Stream (Beta) switch is gone: chat/completions is always
        // requested non-streaming. Drop the dead key from stored configs.
        delete (migratedConfig as any).openaiStream;

        // 「AI 重绘区域」（气泡框 / 文字框）选择器已移除：重绘管线固定只画
        // 文字框（text_bubble + text_free）。丢弃存储里的死键。
        delete (migratedConfig as any).generationRegionSource;

        // OCR 功能已移除（开关 + 独立 OCR 接口）：丢弃存储里的死键。
        delete (migratedConfig as any).enableOCR;
        delete (migratedConfig as any).ocrApiUrl;

        
        // Ensure the OpenAI-compatible image endpoint mode exists.
        // Anything but an explicit 'edit' falls back to the historical
        // chat/completions behaviour.
        if (migratedConfig.openaiImageEndpointMode !== 'edit') {
            migratedConfig.openaiImageEndpointMode = 'chat';
        }

        // 附加请求参数：老配置没有这个键 → 留空（不发送额外字段）。
        if (typeof migratedConfig.imageApiExtraParams !== 'string') {
            migratedConfig.imageApiExtraParams = '';
        }

        // Ensure enableSquareFill exists (on by default)
        if (typeof migratedConfig.enableSquareFill === 'undefined') {
            migratedConfig.enableSquareFill = true;
        }
        // Square fill: old squareFillMode/squareFillMargin were replaced by squareFillSize
        delete (migratedConfig as any).squareFillMode;
        delete (migratedConfig as any).squareFillMargin;
        if (typeof migratedConfig.squareFillSize === 'undefined') {
            migratedConfig.squareFillSize = 1024;
        }
        if (typeof migratedConfig.squareFillCropInset === 'undefined') {
            migratedConfig.squareFillCropInset = 0;
        }
        
        // Ensure useFullImageMasking exists
        if (typeof migratedConfig.useFullImageMasking === 'undefined') {
            migratedConfig.useFullImageMasking = false;
        }

        // Ensure useInvertedMasking exists
        if (typeof migratedConfig.useInvertedMasking === 'undefined') {
            migratedConfig.useInvertedMasking = false;
        }
        
        // Ensure fullImageOpaquePercent exists
        if (typeof migratedConfig.fullImageOpaquePercent === 'undefined') {
            migratedConfig.fullImageOpaquePercent = 90;
        }

        // Ensure Translation settings exist
        if (typeof migratedConfig.enableTranslationMode === 'undefined') {
            migratedConfig.enableTranslationMode = false;
            migratedConfig.translationBaseUrl = 'http://localhost:7860/v1';
            migratedConfig.translationApiKey = '';
            migratedConfig.translationModel = 'gemini-3-flash-preview';
            migratedConfig.translationPrompt = DEFAULT_TRANSLATION_PROMPT;
        }
        
        // Ensure translationPrompt exists (for users who had translation mode enabled but no prompt stored)
        if (typeof migratedConfig.translationPrompt === 'undefined') {
            migratedConfig.translationPrompt = DEFAULT_TRANSLATION_PROMPT;
        }

        // Ensure sendMaskedContextForTranslation exists
        if (typeof migratedConfig.sendMaskedContextForTranslation === 'undefined') {
            migratedConfig.sendMaskedContextForTranslation = false;
        }

        // Ensure the font auto-detect switch exists (off by default)
        if (typeof migratedConfig.enableFontAutoDetect === 'undefined') {
            migratedConfig.enableFontAutoDetect = false;
        }

        // Ensure the eraser-measured text colour switch exists (off by default)
        if (typeof migratedConfig.editorAutoTextColor === 'undefined') {
            migratedConfig.editorAutoTextColor = false;
        }

        // Ensure translation prompt cache slots exist
        if (typeof migratedConfig.translationPromptNoContext === 'undefined') {
            migratedConfig.translationPromptNoContext = '';
        }
        if (typeof migratedConfig.translationPromptWithContext === 'undefined') {
            migratedConfig.translationPromptWithContext = '';
        }

        // 编辑器翻译的提示词模板（'' = 内置默认）
        if (typeof migratedConfig.editorTranslationPrompt === 'undefined') {
            migratedConfig.editorTranslationPrompt = '';
        }

        // 「翻译」不再是独立开关：它绑死在「启用漫画模块」上。存量配置里两者可能
        // 不一致（老版本分开存），这里强制对齐一次 —— 之后由 setConfig 持续维持。
        migratedConfig.enableTranslationMode = !!migratedConfig.enableMangaMode;

        // Ensure the translation-stage / glossary settings exist
        if (typeof migratedConfig.requireTranslationForGeneration === 'undefined') {
            migratedConfig.requireTranslationForGeneration = false;
        }
        if (typeof migratedConfig.translateBeforeRedraw === 'undefined') {
            migratedConfig.translateBeforeRedraw = false;
        }
        if (typeof migratedConfig.glossaryAutoUnify === 'undefined') {
            migratedConfig.glossaryAutoUnify = true;
        }
        if (typeof migratedConfig.glossaryAutoAiSelect === 'undefined') {
            migratedConfig.glossaryAutoAiSelect = false;
        }
        // 术语表 v1（全局注入式）已废弃：相关字段从配置里清掉。术语数据现在
        // 是 workspace 级（GlossaryTerm 树），见 services/glossaryBook.ts。
        delete (migratedConfig as any).enableGlossary;
        delete (migratedConfig as any).glossaryText;

        // detectionApiUrl + editorBackendUrl were merged into the single
        // pythonBackendUrl (unified backend base URL). Derive it from the old
        // keys; the old 5000 default maps to the new 5001 default.
        if (typeof parsed.pythonBackendUrl === 'undefined') {
            const oldEditor = parsed.editorBackendUrl as string | undefined;
            const oldDetect = parsed.detectionApiUrl as string | undefined;
            if (oldEditor) {
                migratedConfig.pythonBackendUrl = oldEditor;
            } else if (oldDetect && oldDetect !== 'http://localhost:5000/detect') {
                migratedConfig.pythonBackendUrl = oldDetect.replace(/\/detect\/?$/, '');
            }
        }
        delete (migratedConfig as any).detectionApiUrl;
        delete (migratedConfig as any).editorBackendUrl;

        // Ensure performanceMode exists
        if (typeof migratedConfig.performanceMode === 'undefined') {
            migratedConfig.performanceMode = 'unlimited';
        }

        // Ensure AI payload compression settings exist
        if (typeof migratedConfig.enableAiPayloadCompression === 'undefined') {
            migratedConfig.enableAiPayloadCompression = true;
        }
        if (typeof migratedConfig.aiPayloadTranslationMaxPx === 'undefined') {
            // 0 = 不限：与升级前完全一致（原分辨率直发）。不替存量会话改变行为，
            // 想省 token 自己去设置里调。
            migratedConfig.aiPayloadTranslationMaxPx = 0;
        }
        if (typeof migratedConfig.aiPayloadTranslationTargetKB === 'undefined') {
            migratedConfig.aiPayloadTranslationTargetKB = 500;
        }
        if (typeof migratedConfig.aiPayloadRedrawTargetKB === 'undefined') {
            migratedConfig.aiPayloadRedrawTargetKB = 1500;
        }

        // Ensure retry diagnostics toggle exists
        if (typeof migratedConfig.showRetryDiagnostics === 'undefined') {
            migratedConfig.showRetryDiagnostics = false;
        }

        // 擦除判定（翻译时）：新功能，存量会话一律关 —— 开关打开会让翻译多发一张图、
        // 并在翻译前多跑一轮擦除，不该替用户决定。
        if (typeof migratedConfig.enableEraseJudgedFreeze === 'undefined') {
            migratedConfig.enableEraseJudgedFreeze = false;
        }
        if (typeof migratedConfig.enableEraseJudgedFreezeForSfx === 'undefined') {
            // 子开关同样默认关 = 拟声词照旧一律冻结，与升级前一致。
            // 注意：这个值**不跟着主开关清空** —— 主开关只是让它不生效/不显示，
            // 下次主开关打开时按记着的样子恢复（见 types 里该字段的说明）。
            migratedConfig.enableEraseJudgedFreezeForSfx = false;
        }

        // 重绘标记（翻译时）：同样是新功能，存量会话一律关 —— 它决定冻结框之后走哪个
        // 重绘场景，属于用户该自己拍板的事。
        if (typeof migratedConfig.enableAiRedrawIntentMarking === 'undefined') {
            migratedConfig.enableAiRedrawIntentMarking = false;
        }
        if (typeof migratedConfig.enableMarkTranslateIntent === 'undefined') {
            migratedConfig.enableMarkTranslateIntent = false;
        }
        if (typeof migratedConfig.enableMarkEraseIntent === 'undefined') {
            migratedConfig.enableMarkEraseIntent = false;
        }

        // 整批「跑完再重试」轮数：老配置没有 → 3（重试机制引入时的默认值）。
        if (typeof migratedConfig.maxRetryRounds === 'undefined') {
            migratedConfig.maxRetryRounds = 3;
        }

        // 自动检测的跳过策略：老配置没有 → false（只有手画框的页面照旧检测，
        // 保持引入这个开关之前的行为）。
        if (typeof migratedConfig.detectionSkipManualOnlyPages === 'undefined') {
            migratedConfig.detectionSkipManualOnlyPages = false;
        }

        // 文字掩码精准擦除：老配置没有 → false（不加载 comic-text-detector，
        // 检测保持原速度）。
        if (typeof migratedConfig.detectionTextMask === 'undefined') {
            migratedConfig.detectionTextMask = false;
        }

        // 提示词模块拆分「翻译 / 擦除 / 自定义」后，全局提示词只保留不变量。
        // 未改过默认值的老用户把旧默认（含「翻译替换」）换成新的不变量版；
        // 自己写过内容的一律保留。
        if (migratedConfig.prompt === LEGACY_DEFAULT_PROMPT) {
            migratedConfig.prompt = DEFAULT_PROMPT;
        }

        // 默认重绘场景：老配置没有 → 翻译（与历史默认一致）。
        if (migratedConfig.defaultRedrawIntent !== 'erase' && migratedConfig.defaultRedrawIntent !== 'custom') {
            migratedConfig.defaultRedrawIntent = 'translate';
        }

        // 编辑器字体：'' = 系统默认；字体库里已删除的 id 一律回落到系统默认，
        // 否则设置面板的下拉框会显示成空白。
        if (
            typeof migratedConfig.editorFontFamily !== 'string' ||
            (migratedConfig.editorFontFamily !== '' &&
                !EDITOR_FONTS.some(f => f.id === migratedConfig.editorFontFamily))
        ) {
            migratedConfig.editorFontFamily = '';
        }

        // Ensure the saved API-preset lists exist (multi-endpoint quick switch)
        if (!Array.isArray(migratedConfig.imageApiProfiles)) {
            migratedConfig.imageApiProfiles = [];
        }
        if (typeof migratedConfig.activeImageApiProfileId === 'undefined') {
            migratedConfig.activeImageApiProfileId = null;
        }
        if (!Array.isArray(migratedConfig.translationApiProfiles)) {
            migratedConfig.translationApiProfiles = [];
        }
        if (typeof migratedConfig.activeTranslationApiProfileId === 'undefined') {
            migratedConfig.activeTranslationApiProfileId = null;
        }

        // 思考强度（翻译调用）：老配置没有这个键 → 默认「不思考」；枚举值被手改
        // 坏的也一并丢弃（否则会以非法 reasoning_effort 打到接口上）。
        if (!['none', 'low', 'medium', 'high'].includes(migratedConfig.translationReasoningEffort)) {
            migratedConfig.translationReasoningEffort = 'none';
        }

        // Session persistence is opt-in now (it writes the whole session to
        // local disk). Configs saved before the switch existed carry the old
        // default (true), which is indistinguishable from a deliberate choice,
        // so the new default (OFF) is applied once per install — the marker
        // records that the user has seen the switch, after which their own
        // toggle value always wins.
        if (!localStorage.getItem(SESSION_PERSISTENCE_OPTIN_KEY)) {
            migratedConfig.enableSessionPersistence = false;
            try {
                localStorage.setItem(SESSION_PERSISTENCE_OPTIN_KEY, '1');
            } catch { /* ignore — private mode */ }
        }

        return migratedConfig;
      }
    } catch (e) {
      console.error("Failed to load config from localStorage", e);
    }
    // No stored config (or unreadable): the defaults already have session
    // persistence OFF. Record the marker so the one-time reset above never
    // fires again and a later opt-in keeps winning.
    try {
      localStorage.setItem(SESSION_PERSISTENCE_OPTIN_KEY, '1');
    } catch { /* ignore — private mode */ }
    return DEFAULT_CONFIG;
  });

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
      } catch (e) {
        console.error("Failed to persist config", e);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [config]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', config.theme || 'light');
  }, [config.theme]);

  /**
   * 写入配置。除了原样落盘，这里还钉死一条绑定关系：**漫画模块 = 翻译总开关**。
   *
   * 「启用翻译模式」在面板上没有自己的开关了 —— 它跟着 enableMangaMode 走。
   * 放在写入路径（而不是某个 effect）里的好处是：任何修改路径（设置面板、重置为
   * 默认、导入配置…）都自动带上这条规则，且只在漫画模块**真的变化**时才动手，
   * 不会在每次无关写入时乱改值。
   *
   * 顺带保留旧版独立开关的副作用：打开翻译时把全局提示词切成「翻译模式」那一版。
   */
  const setConfig = useCallback<Dispatch<SetStateAction<AppConfig>>>((action) => {
    setConfigState(prev => {
      const next = typeof action === 'function'
        ? (action as (p: AppConfig) => AppConfig)(prev)
        : action;
      if (next === prev) return prev;
      // 漫画模块这一格变了 = 翻译总开关跟着翻；顺带沿用旧版独立开关的副作用
      //（打开时把全局提示词切成「翻译模式」版）。
      const mangaChanged = next.enableMangaMode !== prev.enableMangaMode;
      // 值本身不一致（例如导入了一份老配置）也要修正 —— 这条不变量对任何写入路径
      // 都成立，不只是开关被点的瞬间。
      if (!mangaChanged && next.enableTranslationMode === next.enableMangaMode) return next;
      return {
        ...next,
        enableTranslationMode: next.enableMangaMode,
        ...(mangaChanged && next.enableMangaMode ? { prompt: TRANSLATION_MODE_IMAGE_PROMPT } : {}),
      };
    });
  }, []);

  return { config, setConfig };
}