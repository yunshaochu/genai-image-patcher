

import { useState, useEffect } from 'react';
import { AppConfig } from '../types';

const CONFIG_STORAGE_KEY = 'genai_patcher_config_v3';
const DEFAULT_PROMPT = "Enhance this section with high detail, keeping realistic lighting.";

export const DEFAULT_TRANSLATION_PROMPT = `Role: Professional Manga Translator and Typesetter.

Task: Translate all text in the provided manga image into Chinese.

Requirements for Spatial Context & Formatting:
1. Panel-by-Panel Breakdown: Do not list text randomly. Group the translations by the comic panels (e.g., "Panel 1 (Top)", "Panel 2 (Bottom Left)", "Footer").
2. Visual Anchoring: For each text block, describe its specific location relative to the characters or the frame (e.g., "Right speech bubble next to the long-haired girl", "Vertical narration text on the left", "Small text overlay on background").
3. Speaker Identification: If possible, identify who is speaking or thinking based on the visual cues.
4. Format: Please use the following structure for each entry:
    * [Location/Speaker]: [Original Japanese Text] -> [Chinese Translation]

Goal: The output should allow the reader to easily map the translation back to the specific speech bubble in the image without confusion.`;

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
  openaiModel: 'dall-e-3',
  openaiStream: true, // Default to true
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
  fullImageOpaquePercent: 99, // Default to 99% opaque (1% feathering)

  // Translation Defaults
  enableTranslationMode: false,
  translationBaseUrl: 'https://api.openai.com/v1',
  translationApiKey: '',
  translationModel: 'gpt-4o',
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
            migratedConfig.openaiStream = true;
        }
        
        // Ensure useFullImageMasking exists
        if (typeof migratedConfig.useFullImageMasking === 'undefined') {
            migratedConfig.useFullImageMasking = false;
        }
        
        // Ensure fullImageOpaquePercent exists
        if (typeof migratedConfig.fullImageOpaquePercent === 'undefined') {
            migratedConfig.fullImageOpaquePercent = 99;
        }

        // Ensure Translation settings exist
        if (typeof migratedConfig.enableTranslationMode === 'undefined') {
            migratedConfig.enableTranslationMode = false;
            migratedConfig.translationBaseUrl = 'https://api.openai.com/v1';
            migratedConfig.translationApiKey = '';
            migratedConfig.translationModel = 'gpt-4o';
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