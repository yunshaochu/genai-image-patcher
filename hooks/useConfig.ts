
import { useState, useEffect } from 'react';
import { AppConfig } from '../types';
import { EDITOR_FONTS } from '../services/fontService';

const CONFIG_STORAGE_KEY = 'genai_patcher_config_v3';
/** Records that the user's config has already been migrated to the opt-in
 *  session-persistence default (see useConfig). */
const SESSION_PERSISTENCE_OPTIN_KEY = 'genai_patcher_session_persistence_optin_v1';
export const DEFAULT_PROMPT = `1. 请用中文翻译替换掉图片里的日文。如果原图是艺术字，那么要和原图一样，用富有艺术性的字体来画出中文，不能用打印体，要富有艺术性。
2. 生成一张只有中文的图
3. 强调：不是让你续写、续画，而是对这张图的文字进行更换，换为中文
4. 图片大小和比例不许变，必须严格维持我发给你的比例，包括高斯模糊的地方的分界线也不能变。这种严格的比例控制对我的项目来说是必要的。`;

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
  executionMode: 'concurrent',
  concurrencyLimit: 3,
  processFullImageIfNoRegions: false, 
  apiTimeout: 150000, // 150 seconds default
  maxRetriesPerRegion: 1,
  showRetryDiagnostics: false,
  theme: 'light',
  language: 'zh',
  provider: 'openai',
  performanceMode: 'unlimited',
  enableSessionPersistence: false, // opt-in: persisting the session occupies local disk space
  openaiBaseUrl: 'http://localhost:7860/v1',
  openaiApiKey: '',
  openaiModel: 'gemini-imagen',
  openaiStream: false, 
  // Saved API presets (quick switch between url/key/model triples)
  imageApiProfiles: [],
  activeImageApiProfileId: null,
  enableSquareFill: false, // Default false
  squareFillSize: 1024, // px: square edge length for square fill padding
  squareFillCropInset: 0, // px: extra pixels trimmed from every side when cropping back
  geminiApiKey: process.env.API_KEY || '',
  geminiModel: 'gemini-2.5-flash-image', 
  processingMode: 'api',
  // Default to localhost for Python backend development
  // Unified backend (server/, see docs/API_RTDTR.md) listens on 5001
  pythonBackendUrl: 'http://localhost:5001',
  ocrApiUrl: 'http://localhost:5000/ocr',
  
  // Detection Tuning Defaults
  detectionInflationPercent: 5,
  detectionOffsetXPercent: 0,
  detectionOffsetYPercent: 0,
  detectionConfidenceThreshold: 30,
  generationRegionSource: 'text', // 'text' = text_bubble+text_free; 'bubble' = whole bubble outlines+text_free
  
  // Manga Module Defaults
  enableMangaMode: false,
  enableBubbleDetection: true,
  enableOCR: true,
  enableManualEditor: true,
  enableVerticalTextDefault: false,
  editorFontFamily: '', // '' = 系统默认字体；其余 id 见 services/fontService.ts
  
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
  translationApiProfiles: [],
  activeTranslationApiProfileId: null,
  translationPrompt: DEFAULT_TRANSLATION_PROMPT,
  translationPromptNoContext: '',
  translationPromptWithContext: '',
  requireTranslationForGeneration: false,
  translateBeforeRedraw: false,
  enableGlossary: true,
  glossaryText: '',

  // AI Payload Compression Defaults
  enableAiPayloadCompression: true,
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
  const [config, setConfig] = useState<AppConfig>(() => {
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

        // Ensure openaiStream exists (migration for existing users)
        if (typeof migratedConfig.openaiStream === 'undefined') {
            migratedConfig.openaiStream = false;
        }
        
        // Ensure enableSquareFill exists
        if (typeof migratedConfig.enableSquareFill === 'undefined') {
            migratedConfig.enableSquareFill = false;
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

        // Ensure translation prompt cache slots exist
        if (typeof migratedConfig.translationPromptNoContext === 'undefined') {
            migratedConfig.translationPromptNoContext = '';
        }
        if (typeof migratedConfig.translationPromptWithContext === 'undefined') {
            migratedConfig.translationPromptWithContext = '';
        }

        // Ensure the translation-stage / glossary settings exist
        if (typeof migratedConfig.requireTranslationForGeneration === 'undefined') {
            migratedConfig.requireTranslationForGeneration = false;
        }
        if (typeof migratedConfig.translateBeforeRedraw === 'undefined') {
            migratedConfig.translateBeforeRedraw = false;
        }
        if (typeof migratedConfig.enableGlossary === 'undefined') {
            migratedConfig.enableGlossary = true;
        }
        if (typeof migratedConfig.glossaryText === 'undefined') {
            migratedConfig.glossaryText = '';
        }

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

  return { config, setConfig };
}