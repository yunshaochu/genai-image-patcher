import React from 'react';
import { AppConfig } from '../types';
import { t } from '../services/translations';
import {
    TRANSLATION_MODE_IMAGE_PROMPT,
    DEFAULT_TRANSLATION_PROMPT,
    TRANSLATION_CONTEXT_SYSTEM_PROMPT,
} from '../hooks/useConfig';

interface GlobalSettingsProps {
    config: AppConfig;
    setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
    updateConfig: (key: keyof AppConfig, value: any) => void;
    transModels: string[];
    setTransModels: React.Dispatch<React.SetStateAction<string[]>>;
    fetchTransModels: () => Promise<void> | void;
    onClose: () => void;
}

const GlobalSettings: React.FC<GlobalSettingsProps> = ({
    config,
    setConfig,
    updateConfig,
    transModels,
    setTransModels,
    fetchTransModels,
    onClose,
}) => {
    return (
        <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
           <div className="bg-skin-surface max-w-sm w-full rounded-xl shadow-2xl flex flex-col border border-skin-border animate-in fade-in zoom-in-95">
              <div className="p-4 border-b border-skin-border flex justify-between items-center">
                 <h3 className="font-bold text-lg">{t(config.language, 'globalSettings')}</h3>
                 <button onClick={onClose} className="p-1 hover:bg-skin-fill rounded">✕</button>
              </div>
              <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar">
                  <div className="flex items-center justify-between">
                      <div>
                          <div className="text-sm font-bold text-skin-text">{t(config.language, 'enableMangaMode')}</div>
                          <div className="text-xs text-skin-muted">{t(config.language, 'enableMangaModeDesc')}</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                            type="checkbox"
                            className="sr-only peer"
                            checked={config.enableMangaMode}
                            onChange={(e) => updateConfig('enableMangaMode', e.target.checked)}
                        />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-skin-primary"></div>
                      </label>
                  </div>
                  {config.enableMangaMode && (
                     <div className="pl-4 border-l-2 border-skin-border space-y-4 mt-4">
                         <div className="flex items-center justify-between">
                            <div>
                                <div className="text-xs font-bold text-skin-text">{t(config.language, 'enableBubbleDetection')}</div>
                                <div className="text-[10px] text-skin-muted">{t(config.language, 'enableBubbleDetectionDesc')}</div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="sr-only peer"
                                    checked={config.enableBubbleDetection}
                                    onChange={(e) => updateConfig('enableBubbleDetection', e.target.checked)}
                                />
                                <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-skin-primary"></div>
                            </label>
                         </div>
                         <div className="flex items-center justify-between">
                            <div>
                                <div className="text-xs font-bold text-skin-text">{t(config.language, 'enableOCR')}</div>
                                <div className="text-[10px] text-skin-muted">{t(config.language, 'enableOCRDesc')}</div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="sr-only peer"
                                    checked={config.enableOCR}
                                    onChange={(e) => updateConfig('enableOCR', e.target.checked)}
                                />
                                <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-skin-primary"></div>
                            </label>
                         </div>
                         <div className="flex items-center justify-between">
                            <div>
                                <div className="text-xs font-bold text-skin-text">{t(config.language, 'enableManualEditor')}</div>
                                <div className="text-[10px] text-skin-muted">{t(config.language, 'enableManualEditorDesc')}</div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="sr-only peer"
                                    checked={config.enableManualEditor}
                                    onChange={(e) => updateConfig('enableManualEditor', e.target.checked)}
                                />
                                <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-skin-primary"></div>
                            </label>
                         </div>
                         {config.enableManualEditor && (
                             <div className="flex items-center justify-between">
                                <div>
                                    <div className="text-xs font-bold text-skin-text">{t(config.language, 'enableVerticalTextDefault')}</div>
                                    <div className="text-[10px] text-skin-muted">{t(config.language, 'enableVerticalTextDefaultDesc')}</div>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        className="sr-only peer"
                                        checked={config.enableVerticalTextDefault}
                                        onChange={(e) => updateConfig('enableVerticalTextDefault', e.target.checked)}
                                    />
                                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-skin-primary"></div>
                                </label>
                             </div>
                         )}
                     </div>
                  )}
                  <div className="flex items-center justify-between border-t border-skin-border pt-4 mt-4">
                      <div>
                          <div className="text-sm font-bold text-skin-text">{t(config.language, 'useFullImageMasking')}</div>
                          <div className="text-xs text-skin-muted max-w-[200px]">{t(config.language, 'useFullImageMaskingDesc')}</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                            type="checkbox"
                            className="sr-only peer"
                            checked={config.useFullImageMasking}
                            onChange={(e) => updateConfig('useFullImageMasking', e.target.checked)}
                        />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-skin-primary"></div>
                      </label>
                  </div>
                  {config.useFullImageMasking && (
                      <div className="pl-4 border-l-2 border-skin-border space-y-4 mt-4 animate-in fade-in slide-in-from-top-1">
                          <div className="flex items-center justify-between">
                            <div>
                                <div className="text-xs font-bold text-skin-text">{t(config.language, 'useInvertedMasking')}</div>
                                <div className="text-[10px] text-skin-muted">{t(config.language, 'useInvertedMaskingDesc')}</div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="sr-only peer"
                                    checked={config.useInvertedMasking}
                                    onChange={(e) => updateConfig('useInvertedMasking', e.target.checked)}
                                />
                                <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-skin-primary"></div>
                            </label>
                         </div>

                          <div className="bg-skin-fill/30 p-3 rounded-lg border border-skin-border space-y-2">
                              <label className="text-[10px] uppercase font-bold text-skin-muted block">{t(config.language, 'fullImageOpaquePercent')}</label>
                              <div className="flex items-center gap-3">
                                  <input
                                      type="range" min="80" max="100" step="1"
                                      value={config.fullImageOpaquePercent}
                                      onChange={(e) => updateConfig('fullImageOpaquePercent', Number(e.target.value))}
                                      className="flex-1 h-1 bg-skin-border rounded-lg appearance-none cursor-pointer accent-skin-primary"
                                  />
                                  <div className="relative">
                                      <input
                                          type="number" min="0" max="100"
                                          value={config.fullImageOpaquePercent}
                                          onChange={(e) => updateConfig('fullImageOpaquePercent', Math.max(0, Math.min(100, Number(e.target.value))))}
                                          className="w-12 p-1 text-xs text-center border border-skin-border rounded bg-skin-surface"
                                      />
                                      <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[9px] text-skin-muted pointer-events-none">%</span>
                                  </div>
                              </div>
                              <p className="text-[10px] text-skin-muted leading-tight">{t(config.language, 'fullImageOpaquePercentDesc')}</p>
                          </div>
                      </div>
                  )}
                  <div className="flex items-center justify-between border-t border-skin-border pt-4 mt-4">
                      <div>
                          <div className="text-sm font-bold text-skin-text">{t(config.language, 'enableTranslationMode')}</div>
                          <div className="text-xs text-skin-muted max-w-[200px]">{t(config.language, 'enableTranslationModeDesc')}</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                            type="checkbox"
                            className="sr-only peer"
                            checked={config.enableTranslationMode}
                            onChange={(e) => {
                                const enabled = e.target.checked;
                                setConfig(prev => ({
                                    ...prev,
                                    enableTranslationMode: enabled,
                                    prompt: enabled ? TRANSLATION_MODE_IMAGE_PROMPT : prev.prompt
                                }));
                            }}
                        />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-skin-primary"></div>
                      </label>
                  </div>
                  {config.enableTranslationMode && (
                      <div className="bg-skin-fill/30 p-3 rounded-lg border border-skin-border space-y-3 animate-in fade-in slide-in-from-top-2">
                          <h4 className="text-xs font-bold text-skin-text uppercase tracking-wider">{t(config.language, 'translationSettings')}</h4>
                           <div className="flex items-center justify-between">
                               <div>
                                   <div className="text-xs font-medium text-skin-text">{t(config.language, 'sendMaskedContextForTranslation')}</div>
                                   <div className="text-[10px] text-skin-muted max-w-[220px]">{t(config.language, 'sendMaskedContextForTranslationDesc')}</div>
                               </div>
                               <label className="relative inline-flex items-center cursor-pointer">
                                   <input
                                       type="checkbox"
                                       className="sr-only peer"
                                       checked={config.sendMaskedContextForTranslation}
                                         onChange={(e) => {
                                             const enabled = e.target.checked;
                                             const currentPrompt = config.translationPrompt;
                                             const oldSlotKey = !enabled ? 'translationPromptWithContext' : 'translationPromptNoContext';
                                             const newSlotKey = enabled ? 'translationPromptWithContext' : 'translationPromptNoContext';
                                             const cachedPrompt = (config as any)[newSlotKey];
                                             const newPrompt = cachedPrompt || (enabled ? TRANSLATION_CONTEXT_SYSTEM_PROMPT : DEFAULT_TRANSLATION_PROMPT);
                                             setConfig(prev => ({
                                                 ...prev,
                                                 sendMaskedContextForTranslation: enabled,
                                                 [oldSlotKey]: currentPrompt,
                                                 translationPrompt: newPrompt,
                                             }));
                                         }}
                                   />
                                   <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-skin-primary"></div>
                               </label>
                           </div>
                          <div>
                              <label className="text-[10px] text-skin-muted block mb-1">{t(config.language, 'baseUrl')}</label>
                              <input
                                  type="text"
                                  value={config.translationBaseUrl}
                                  onChange={(e) => updateConfig('translationBaseUrl', e.target.value)}
                                  className="w-full p-2 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50"
                              />
                          </div>
                          <div>
                              <label className="text-[10px] text-skin-muted block mb-1">{t(config.language, 'apiKey')}</label>
                              <input
                                  type="password"
                                  value={config.translationApiKey}
                                  onChange={(e) => updateConfig('translationApiKey', e.target.value)}
                                  className="w-full p-2 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50"
                              />
                          </div>
                          <div>
                              <div className="flex justify-between items-center mb-1">
                                <label className="text-[10px] text-skin-muted block">{t(config.language, 'model')}</label>
                                <button onClick={fetchTransModels} className="text-[10px] text-skin-primary hover:underline">{t(config.language, 'fetchList')}</button>
                              </div>
                              <div className="relative">
                                  <input
                                      type="text"
                                      value={config.translationModel}
                                      onChange={(e) => updateConfig('translationModel', e.target.value)}
                                      className="w-full p-2 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50"
                                  />
                                  {transModels.length > 0 && (
                                      <div className="mt-1 max-h-24 overflow-y-auto border border-skin-border rounded bg-skin-surface absolute z-10 w-full shadow-lg">
                                          {transModels.map(m => (
                                              <div
                                                key={m}
                                                onClick={() => { updateConfig('translationModel', m); setTransModels([]); }}
                                                className="px-2 py-1 text-[10px] hover:bg-skin-fill cursor-pointer truncate"
                                              >
                                                  {m}
                                              </div>
                                          ))}
                                      </div>
                                  )}
                              </div>
                          </div>
                          <div>
                              <div className="flex justify-between items-center mb-1">
                                  <label className="text-[10px] text-skin-muted block">{t(config.language, 'translationPromptLabel')}</label>
                                    <button
                                        onClick={() => {
                                            const defaultPrompt = config.sendMaskedContextForTranslation ? TRANSLATION_CONTEXT_SYSTEM_PROMPT : DEFAULT_TRANSLATION_PROMPT;
                                            const slotKey = config.sendMaskedContextForTranslation ? 'translationPromptWithContext' : 'translationPromptNoContext';
                                            setConfig(prev => ({
                                                ...prev,
                                                translationPrompt: defaultPrompt,
                                                [slotKey]: '',
                                            }));
                                        }}
                                       className="text-[9px] text-skin-primary hover:underline bg-transparent border-0 cursor-pointer flex items-center gap-1"
                                       title={t(config.language, 'resetToDefault')}
                                   >
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                                      {t(config.language, 'reset')}
                                  </button>
                              </div>
                              <textarea
                                  value={config.translationPrompt}
                                  onChange={(e) => updateConfig('translationPrompt', e.target.value)}
                                  className="w-full p-2 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50 h-24 resize-none shadow-sm"
                                  placeholder={t(config.language, 'translationPromptPlaceholder')}
                              />
                          </div>
                      </div>
                  )}
              </div>
              <div className="p-4 border-t border-skin-border bg-skin-fill/30">
                  <button onClick={onClose} className="w-full py-2 bg-skin-primary text-skin-primary-fg rounded-lg font-bold">
                     {t(config.language, 'close')}
                  </button>
              </div>
           </div>
        </div>
    );
};

export default GlobalSettings;
