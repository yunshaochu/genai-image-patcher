
import { useState, useEffect } from 'react';
import { AppConfig } from '../types';

const CONFIG_STORAGE_KEY = 'genai_patcher_config_v3';
const DEFAULT_PROMPT = "Enhance this section with high detail, keeping realistic lighting.";

export const DEFAULT_TRANSLATION_PROMPT = `> **角色设定**：
> 你是专业的漫画汉化组成员，负责提取文本、定位和翻译。
>
> **任务目标**：
> 识别图片中的所有日语文字，并将其翻译成流畅的中文。
>
> **核心要求（严格执行）**：
> 1.  **禁止闲聊**：**绝对不要**输出任何开场白（如“好的，这是翻译...”）、结束语或解释性文字。直接输出翻译内容。
> 2.  **分镜结构**：必须按照漫画的分镜格（Panel）顺序，从上到下、从右到左排列。
> 3.  **视觉锚点**：对于每一处文字，必须描述其在画面中的具体位置（例如：“长发女生的对话框”、“背景左侧的竖排心理描写”），以便我进行嵌字。
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

const DEFAULT_CONFIG: AppConfig = {
  prompt: DEFAULT_PROMPT,
  executionMode: 'concurrent',
  concurrencyLimit: 3,
  processFullImageIfNoRegions: false, 
  apiTimeout: 150000, // 150 seconds default
  maxRetries: 1,
  theme: 'light',
  language: 'zh',
  provider: 'openai',
  openaiBaseUrl: 'http://localhost:7860/v1',
  openaiApiKey: '',
  openaiModel: 'gemini-imagen',
  openaiStream: false, 
  geminiApiKey: process.env.API_KEY || '',
  geminiModel: 'gemini-2.5-flash-image', 
  processingMode: 'api',
  // Default to localhost for Python backend development
  detectionApiUrl: 'http://localhost:5000/detect',
  ocrApiUrl: 'http://localhost:5000/ocr',
  
  // Detection Tuning Defaults
  detectionInflationPercent: 10,
  detectionOffsetXPercent: 0,
  detectionOffsetYPercent: 0,
  detectionConfidenceThreshold: 30,
  
  // Manga Module Defaults
  enableMangaMode: false,
  enableBubbleDetection: true,
  enableOCR: true,
  enableManualEditor: true,
  enableVerticalTextDefault: false,
  
  // New Logic Toggle
  useFullImageMasking: false,
  fullImageOpaquePercent: 90, 

  // Translation Defaults
  enableTranslationMode: false,
  translationBaseUrl: 'http://localhost:7860/v1',
  translationApiKey: '',
  translationModel: 'gemini-3-flash-preview',
  translationPrompt: DEFAULT_TRANSLATION_PROMPT
};

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
        
        // Ensure useFullImageMasking exists
        if (typeof migratedConfig.useFullImageMasking === 'undefined') {
            migratedConfig.useFullImageMasking = false;
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

        return migratedConfig;
      }
    } catch (e) {
      console.error("Failed to load config from localStorage", e);
    }
    return DEFAULT_CONFIG;
  });

  useEffect(() => {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', config.theme || 'light');
  }, [config.theme]);

  return { config, setConfig };
}
