
import React, { useCallback, useEffect, useState } from 'react';
import { AppConfig, UploadedImage, isRegionPaintable } from '../types';
import { t } from '../services/translations';
import { fetchOpenAIModels } from '../services/aiService';
import { Section } from './sidebar/Section';
import { SettingsPanel } from './sidebar/SettingsPanel';
import { FullImageMaskRow, ManualPatchRow } from './sidebar/WorkbenchItems';
import { DEFAULT_PROMPT } from '../hooks/useConfig';

/**
 * Right-side dock for the two API-driven workflows, mirroring EditorDock's
 * placement for the editor workflow: the panels that configure a run live next
 * to the canvas instead of in the left sidebar, so the sidebar stays a
 * gallery / mode switcher and the working surface gets the full height.
 *
 *  - 'api'    (AI 重绘)      → 提示词 + 连接设置 + 处理选项
 *  - 'manual' (补丁工坊)     → 切片 / 遮罩输入 / 回填区
 *
 * The editor workflow keeps its own dock (EditorDock), which is bound to the
 * canvas 'edit' tab rather than to the mode.
 */

const SECTIONS_STORAGE_KEY = 'genai_patcher_workflow_dock_sections_v1';
const COLLAPSE_STORAGE_KEY = 'genai_patcher_workflow_dock_collapsed_v1';

interface WorkflowDockProps {
  config: AppConfig;
  onConfigChange: (key: keyof AppConfig, value: any) => void;
  currentImage?: UploadedImage;
  selectedRegionId: string | null;
  onUpdateRegionPrompt: (imageId: string, regionId: string, prompt: string) => void;
  onUpdateImagePrompt?: (imageId: string, prompt: string) => void;
  onManualPatchUpdate: (imageId: string, regionId: string, base64: string) => void;
  onOcrRegion: (imageId: string, regionId: string) => void;
}

export const WorkflowDock: React.FC<WorkflowDockProps> = ({
  config,
  onConfigChange,
  currentImage,
  selectedRegionId,
  onUpdateRegionPrompt,
  onUpdateImagePrompt,
  onManualPatchUpdate,
  onOcrRegion,
}) => {
  const lang = config.language;
  const isManualMode = config.processingMode === 'manual';

  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1'; } catch { return false; }
  });
  // The panels are the dock's whole purpose here, so 提示词 / 工坊 start open.
  const [open, setOpen] = useState<Record<'prompt' | 'settings' | 'execution' | 'manual', boolean>>(() => {
    try {
      const saved = localStorage.getItem(SECTIONS_STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    return { prompt: true, settings: false, execution: false, manual: true };
  });
  const [modelList, setModelList] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed]);

  useEffect(() => {
    try { localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(open)); } catch { /* ignore */ }
  }, [open]);

  const toggle = (key: keyof typeof open) => setOpen(prev => ({ ...prev, [key]: !prev[key] }));

  const handleFetchModels = useCallback(async () => {
    if (!config.openaiApiKey || !config.openaiBaseUrl) {
      alert('Please enter API Key and Base URL first.');
      return;
    }
    setIsLoadingModels(true);
    try {
      const models = await fetchOpenAIModels(config.openaiBaseUrl, config.openaiApiKey);
      setModelList(models);
      if (models.length > 0 && !models.includes(config.openaiModel)) {
        onConfigChange('openaiModel', models[0]);
      }
    } catch (e: any) {
      alert('Failed to fetch models: ' + e.message);
    } finally {
      setIsLoadingModels(false);
    }
  }, [config.openaiApiKey, config.openaiBaseUrl, config.openaiModel, onConfigChange]);

  const selectedRegion = currentImage && selectedRegionId
    ? currentImage.regions.find(r => r.id === selectedRegionId) ?? null
    : null;
  const showFullImagePrompt = !!config.processFullImageIfNoRegions
    && !!currentImage
    && currentImage.regions.length === 0;

  // Collapsed: thin strip with an expand handle, same affordance as EditorDock.
  if (collapsed) {
    return (
      <div className="h-full shrink-0 flex">
        <button
          onClick={() => setCollapsed(false)}
          className="w-7 h-full bg-skin-surface border-l border-skin-border shadow-lg flex flex-col items-center justify-center gap-2 text-skin-muted hover:text-skin-primary hover:bg-skin-fill transition-colors"
          title={t(lang, 'dockExpand')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
          <span className="text-[9px] font-bold tracking-widest" style={{ writingMode: 'vertical-rl' }}>
            {t(lang, isManualMode ? 'modeManual' : 'modeApi')}
          </span>
        </button>
      </div>
    );
  }

  return (
    <aside className="h-full w-[272px] shrink-0 bg-skin-surface border-l border-skin-border shadow-2xl flex flex-col animate-in fade-in slide-in-from-right-4">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-skin-border shrink-0">
        <span className="text-[10px] font-bold text-skin-text">{t(lang, isManualMode ? 'modeManual' : 'modeApi')}</span>
        <button
          onClick={() => setCollapsed(true)}
          className="ml-auto p-1 rounded text-skin-muted hover:text-skin-primary hover:bg-skin-fill transition-colors"
          title={t(lang, 'dockCollapse')}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 5l7 7-7 7" /></svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-3">
        {isManualMode ? (
          <Section title={t(lang, 'workbenchTitle')} isOpen={open.manual} onToggle={() => toggle('manual')}>
            {currentImage ? (
              <div className="space-y-3 animate-in fade-in slide-in-from-right-8">
                {/* Render Full Image Mask Row FIRST if enabled */}
                {config.useFullImageMasking && (
                  <FullImageMaskRow
                    image={currentImage}
                    config={config}
                    onPatchUpdate={(base64) => onManualPatchUpdate(currentImage.id, 'special-full-image-mask', base64)}
                  />
                )}

                {selectedRegionId ? (() => {
                  const region = currentImage.regions.find(r => r.id === selectedRegionId);
                  // Regions the pipeline would never paint (per the
                  // generation source) have no patch zone.
                  if (!region || !isRegionPaintable(region, config.generationRegionSource ?? 'text')) {
                    return !config.useFullImageMasking ? (
                      <div className="text-center py-8 text-skin-muted italic text-xs">
                        {t(lang, 'noRegions')}
                      </div>
                    ) : null;
                  }
                  return (
                    <ManualPatchRow
                      key={region.id}
                      region={region}
                      image={currentImage}
                      config={config}
                      onPatchUpdate={(base64) => onManualPatchUpdate(currentImage.id, region.id, base64)}
                      lang={lang}
                      onOcr={() => onOcrRegion(currentImage.id, region.id)}
                      showOcr={config.enableMangaMode && config.enableOCR}
                      showRetryDiagnostics={!!config.showRetryDiagnostics}
                    />
                  );
                })() : !config.useFullImageMasking && (
                  <div className="text-center py-8 text-skin-muted italic text-xs">
                    {t(lang, 'noRegions')}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8 text-skin-muted italic text-xs">
                {t(lang, 'noRegions')}
              </div>
            )}
          </Section>
        ) : (
          <>
            <Section title={t(lang, 'promptTitle')} isOpen={open.prompt} onToggle={() => toggle('prompt')}>
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 flex items-center justify-between">
                    <span>{t(lang, 'promptGlobalLabel')}</span>
                    <button
                      onClick={() => onConfigChange('prompt', DEFAULT_PROMPT)}
                      className="text-[9px] text-skin-primary hover:underline bg-transparent border-0 cursor-pointer flex items-center gap-1"
                      title={t(lang, 'resetToDefault')}
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                      {t(lang, 'reset')}
                    </button>
                  </label>
                  <textarea
                    value={config.prompt}
                    onChange={(e) => onConfigChange('prompt', e.target.value)}
                    className="w-full h-20 p-2 text-xs border border-skin-border rounded-lg bg-skin-surface focus:ring-1 focus:ring-skin-primary focus:border-skin-primary transition-all resize-none shadow-sm"
                    placeholder={t(lang, 'promptPlaceholder')}
                  />
                </div>

                {currentImage && (
                  <div className="pt-2 border-t border-skin-border border-dashed transition-all">
                    {showFullImagePrompt ? (
                      <>
                        <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block flex items-center gap-2">
                          {t(lang, 'promptFullImageLabel')}
                          <span className="px-1.5 py-0.5 rounded-full bg-skin-fill text-skin-primary font-mono normal-case truncate max-w-[100px] border border-skin-border">
                            Full Image
                          </span>
                        </label>
                        <textarea
                          key={`full-${currentImage.id}`}
                          value={currentImage.customPrompt || ''}
                          onChange={(e) => onUpdateImagePrompt && onUpdateImagePrompt(currentImage.id, e.target.value)}
                          className="w-full h-16 p-2 text-xs border border-skin-border rounded-lg bg-skin-surface focus:ring-1 focus:ring-skin-primary focus:border-skin-primary transition-all resize-none shadow-sm animate-in fade-in"
                          placeholder={t(lang, 'promptFullImagePlaceholder')}
                        />
                      </>
                    ) : (
                      <>
                        <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block flex items-center gap-2">
                          {t(lang, 'promptSpecificLabel')}
                          {selectedRegion && (
                            <span className="px-1.5 py-0.5 rounded-full bg-skin-fill text-skin-primary font-mono normal-case truncate max-w-[100px] border border-skin-border">
                              ID: {selectedRegion.id.slice(0, 4)}
                            </span>
                          )}
                        </label>

                        {selectedRegion ? (
                          <textarea
                            key={selectedRegion.id}
                            value={selectedRegion.customPrompt || ''}
                            onChange={(e) => onUpdateRegionPrompt(currentImage.id, selectedRegion.id, e.target.value)}
                            // Lock the textarea while THIS region is being processed
                            // (its prompt is already in flight to the API; mid-flight
                            // edits would be silently ignored). Other regions remain
                            // editable even during batch processing.
                            readOnly={selectedRegion.status === 'processing'}
                            className={`w-full h-16 p-2 text-xs border border-skin-border rounded-lg bg-skin-surface focus:ring-1 focus:ring-skin-primary focus:border-skin-primary transition-all resize-none shadow-sm animate-in fade-in ${selectedRegion.status === 'processing' ? 'opacity-60 cursor-not-allowed' : ''}`}
                            placeholder={t(lang, 'promptSpecificPlaceholder')}
                          />
                        ) : (
                          <div className="w-full h-16 p-2 text-xs border border-dashed border-skin-border rounded-lg bg-skin-fill/20 flex items-center justify-center text-skin-muted text-center italic">
                            Select a region to customize its prompt
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </Section>

            <Section title={t(lang, 'settingsTitle')} isOpen={open.settings} onToggle={() => toggle('settings')}>
              <SettingsPanel
                config={config}
                onChange={onConfigChange}
                onFetchModels={handleFetchModels}
                modelList={modelList}
                isLoadingModels={isLoadingModels}
              />
            </Section>

            <Section title={t(lang, 'executionTitle')} isOpen={open.execution} onToggle={() => toggle('execution')}>
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'mode')}</label>
                  <div className="flex bg-skin-fill p-1 rounded-lg border border-skin-border">
                    <button
                      onClick={() => onConfigChange('executionMode', 'concurrent')}
                      className={`flex-1 py-1 text-[10px] rounded transition-all ${config.executionMode === 'concurrent' ? 'bg-skin-surface shadow-sm text-skin-primary' : 'text-skin-muted'}`}
                    >
                      {t(lang, 'modeConcurrent')}
                    </button>
                    <button
                      onClick={() => onConfigChange('executionMode', 'serial')}
                      className={`flex-1 py-1 text-[10px] rounded transition-all ${config.executionMode === 'serial' ? 'bg-skin-surface shadow-sm text-skin-primary' : 'text-skin-muted'}`}
                    >
                      {t(lang, 'modeSerial')}
                    </button>
                  </div>
                </div>

                {config.executionMode === 'concurrent' && (
                  <div>
                    <div className="flex justify-between">
                      <label className="text-[10px] uppercase font-bold text-skin-muted block">{t(lang, 'concurrency')}</label>
                      <span className="text-[10px] font-mono">{config.concurrencyLimit}</span>
                    </div>
                    <input
                      type="number" min="1" step="1"
                      value={config.concurrencyLimit}
                      onChange={(e) => onConfigChange('concurrencyLimit', Math.max(1, Number(e.target.value)))}
                      className="w-full p-1.5 text-xs border border-skin-border rounded-lg bg-skin-surface shadow-sm"
                    />
                  </div>
                )}

                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'timeoutLabel')}</label>
                    <input
                      type="number" value={config.apiTimeout / 1000}
                      onChange={(e) => onConfigChange('apiTimeout', Number(e.target.value) * 1000)}
                      className="w-full p-1.5 text-xs border border-skin-border rounded-lg bg-skin-surface shadow-sm"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'retriesLabel')}</label>
                    <input
                      type="number" value={config.maxRetriesPerRegion}
                      onChange={(e) => onConfigChange('maxRetriesPerRegion', Number(e.target.value))}
                      className="w-full p-1.5 text-xs border border-skin-border rounded-lg bg-skin-surface shadow-sm"
                    />
                  </div>
                </div>

                <div className="pt-2 border-t border-skin-border/50 space-y-2">
                  <label className="flex items-start gap-2 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={config.processFullImageIfNoRegions}
                      onChange={(e) => onConfigChange('processFullImageIfNoRegions', e.target.checked)}
                      className="mt-0.5"
                    />
                    <div>
                      <span className="block text-xs font-medium text-skin-text group-hover:text-skin-primary transition-colors">{t(lang, 'processFullImage')}</span>
                      <span className="block text-[10px] text-skin-muted leading-tight mt-0.5">{t(lang, 'processFullImageDesc')}</span>
                    </div>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={config.showRetryDiagnostics}
                      onChange={(e) => onConfigChange('showRetryDiagnostics', e.target.checked)}
                      className="mt-0.5"
                    />
                    <div>
                      <span className="block text-xs font-medium text-skin-text group-hover:text-skin-primary transition-colors">{t(lang, 'showRetryDiagnostics')}</span>
                      <span className="block text-[10px] text-skin-muted leading-tight mt-0.5">{t(lang, 'showRetryDiagnosticsDesc')}</span>
                    </div>
                  </label>
                </div>
              </div>
            </Section>
          </>
        )}
      </div>
    </aside>
  );
};

export default WorkflowDock;
