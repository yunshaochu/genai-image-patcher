

import { useState, useEffect } from 'react';
import { AppConfig } from '../types';

const CONFIG_STORAGE_KEY = 'genai_patcher_config_v3';
const DEFAULT_PROMPT = "Enhance this section with high detail, keeping realistic lighting.";

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
  enableVerticalTextDefault: false
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