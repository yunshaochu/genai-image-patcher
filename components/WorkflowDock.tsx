
import React, { useCallback, useEffect, useState } from 'react';
import { AppConfig, ProcessingStep, UploadedImage, RedrawIntent, isRegionPaintable } from '../types';
import { t } from '../services/translations';
import { fetchOpenAIModels } from '../services/aiService';
import { Section } from './sidebar/Section';
import { SettingsPanel } from './sidebar/SettingsPanel';
import { FullImageMaskRow, ManualPatchRow } from './sidebar/WorkbenchItems';
import { DockActions, useRunGating } from './sidebar/DockActions';
import { LayerOrderButtons } from './sidebar/LayerOrderButtons';
import { DEFAULT_PROMPT, defaultRegionPrompt } from '../hooks/useConfig';
import type { PromptField } from '../hooks/useImageManager';
import { LayerDirection } from '../services/mangaEditor';

/**
 * Right-side dock for the two API-driven workflows, mirroring EditorDock's
 * placement for the editor workflow: everything that configures or runs a job
 * lives next to the canvas instead of in the left sidebar, so the sidebar stays
 * a gallery / mode switcher and the working surface gets the full height.
 *
 *  - 'api'    (AI 重绘)      → 提示词 + 连接设置 + 处理选项 (+ 底部执行区)
 *  - 'manual' (补丁工坊)     → 切片 / 遮罩输入 / 回填区 (+ 底部执行区)
 *
 * The pinned footer (DockActions) holds 翻译 / 重绘 / 结果保存, which used to be
 * the left sidebar's footer; the collapsed rail repeats the run buttons as icons
 * so collapsing the dock can never strand them.
 *
 * The editor workflow keeps its own dock (EditorDock), which is bound to the
 * canvas 'edit' tab rather than to the mode.
 */

const SECTIONS_STORAGE_KEY = 'genai_patcher_workflow_dock_sections_v1';
const COLLAPSE_STORAGE_KEY = 'genai_patcher_workflow_dock_collapsed_v1';
/** 场景对应的选区/图片提示词槽内容（三套槽并存，切场景不丢数据）。 */
const intentSlot = (
  v: { customPrompt?: string; customPromptErase?: string; customPromptFree?: string } | undefined,
  tab: RedrawIntent
): string =>
  !v ? '' : (tab === 'erase' ? v.customPromptErase
    : tab === 'custom' ? v.customPromptFree
      : v.customPrompt) ?? '';

interface WorkflowDockProps {
  config: AppConfig;
  onConfigChange: (key: keyof AppConfig, value: any) => void;
  currentImage?: UploadedImage;
  selectedRegionId: string | null;
  onUpdateRegionPrompt: (imageId: string, regionId: string, prompt: string, field: PromptField) => void;
  onUpdateImagePrompt?: (imageId: string, prompt: string, field: PromptField) => void;
  /** 记录某格 / 某图的重绘场景覆盖（undefined = 清除覆盖，跟随全局默认场景）。 */
  onUpdateRegionIntent: (imageId: string, regionId: string, intent: RedrawIntent | undefined) => void;
  onUpdateImageIntent: (imageId: string, intent: RedrawIntent | undefined) => void;
  /** 独立译文槽（翻译 tab 的「本框译文」框）。 */
  onUpdateRegionTranslation: (imageId: string, regionId: string, translation: string) => void;
  onUpdateImageTranslation: (imageId: string, translation: string) => void;
  onManualPatchUpdate: (imageId: string, regionId: string, base64: string) => void;
  onOcrRegion: (imageId: string, regionId: string) => void;
  /**
   * 调整选中格的叠放次序（谁盖谁 = regions 数组下标，下标越大越靠上）。
   * AI 重绘 / 手动修补工坊共用：贴图部分重叠时，↑ 让这一格盖到相邻贴图之上。
   */
  onReorderRegion?: (imageId: string, regionId: string, dir: LayerDirection) => void;
  // Run / result actions are pinned to the dock's bottom edge (see DockActions).
  images: UploadedImage[];
  processingState: ProcessingStep;
  processAll: boolean;
  onProcessAllChange: (value: boolean) => void;
  onTranslate: (processAll: boolean) => void;
  onProcess: (processAll: boolean) => void;
  onStop: () => void;
  onDownload: () => void;
  onApplyAsOriginal: () => void;
}

export const WorkflowDock: React.FC<WorkflowDockProps> = ({
  config,
  onConfigChange,
  currentImage,
  selectedRegionId,
  onUpdateRegionPrompt,
  onUpdateImagePrompt,
  onUpdateRegionIntent,
  onUpdateImageIntent,
  onUpdateRegionTranslation,
  onUpdateImageTranslation,
  onManualPatchUpdate,
  onOcrRegion,
  onReorderRegion,
  images,
  processingState,
  processAll,
  onProcessAllChange,
  onTranslate,
  onProcess,
  onStop,
  onDownload,
  onApplyAsOriginal,
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
  /** 选中框的「错误历史」是否展开（重试诊断）。 */
  const [errHistoryOpen, setErrHistoryOpen] = useState(false);

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
  // 叠放次序：regions 数组下标越大越靠上 —— 编辑画布按数组顺序叠 DOM，拼接也是按
  // 数组顺序 drawImage。只有贴图互相重叠时看得出差别。
  const layerIdx = selectedRegion
    ? currentImage?.regions.findIndex(r => r.id === selectedRegion.id) ?? -1
    : -1;
  const showFullImagePrompt = !!config.processFullImageIfNoRegions
    && !!currentImage
    && currentImage.regions.length === 0;

  // ── 提示词模块：全局默认场景 + 单选框覆盖 ────────────────────────────
  // 默认场景持久化在 config：所有**没被单独改过**的切片都走它。
  // 选中框的 tab 显示它的**有效场景**（自己的覆盖 ?? 默认场景）；改 tab = 只给
  // 这一个框加覆盖，其他框不受影响。
  const defaultIntent: RedrawIntent = config.defaultRedrawIntent ?? 'translate';
  // 有没有"正在编辑的目标"：选中了框，或全图模式下的当前图片。没有 → 只给用户
  // 设置「默认场景」；有 → 给这个目标设置覆盖。
  const hasTarget = !!currentImage && (showFullImagePrompt || !!selectedRegion);
  const targetIntent: RedrawIntent | undefined = showFullImagePrompt
    ? currentImage?.redrawIntent
    : selectedRegion?.redrawIntent;
  const activeIntent: RedrawIntent = targetIntent ?? defaultIntent;
  const hasOverride = targetIntent !== undefined;
  const sceneLabel = (v: RedrawIntent) =>
    t(lang, v === 'translate' ? 'promptTabTranslate' : v === 'erase' ? 'promptTabErase' : 'promptTabCustom');

  /** 给当前目标单独设置场景覆盖。 */
  const handleTargetIntentChange = (tab: RedrawIntent) => {
    if (!currentImage) return;
    if (showFullImagePrompt) onUpdateImageIntent(currentImage.id, tab);
    else if (selectedRegion) onUpdateRegionIntent(currentImage.id, selectedRegion.id, tab);
  };
  /** 清除当前目标的覆盖 → 重新跟随默认场景。 */
  const clearTargetIntent = () => {
    if (!currentImage) return;
    if (showFullImagePrompt) onUpdateImageIntent(currentImage.id, undefined);
    else if (selectedRegion) onUpdateRegionIntent(currentImage.id, selectedRegion.id, undefined);
  };

  // 当前场景对应的槽位内容 / 默认值 / 占位符（默认值不落库，作占位符展示；
  // 「重置为默认」按钮才会把它物化进槽）。
  const slotValue = showFullImagePrompt
    ? intentSlot(currentImage, activeIntent)
    : (selectedRegion ? intentSlot(selectedRegion, activeIntent) : '');
  const slotDefault = defaultRegionPrompt(activeIntent);
  const slotPlaceholder = activeIntent === 'translate'
    ? (slotDefault || t(lang, 'promptSpecificPlaceholder'))
    : activeIntent === 'erase'
      ? (slotDefault || t(lang, 'promptErasePlaceholder'))
      : t(lang, 'promptCustomPlaceholder');
  const translationValue = showFullImagePrompt
    ? (currentImage?.customTranslation ?? '')
    : (selectedRegion?.customTranslation ?? '');

  const handleSlotChange = (value: string) => {
    if (!currentImage) return;
    if (showFullImagePrompt) onUpdateImagePrompt?.(currentImage.id, value, activeIntent);
    else if (selectedRegion) onUpdateRegionPrompt(currentImage.id, selectedRegion.id, value, activeIntent);
  };
  const handleTranslationChange = (value: string) => {
    if (!currentImage) return;
    if (showFullImagePrompt) onUpdateImageTranslation(currentImage.id, value);
    else if (selectedRegion) onUpdateRegionTranslation(currentImage.id, selectedRegion.id, value);
  };

  const gating = useRunGating({ config, images, currentImage, processingState, processAll });

  // Collapsed: thin rail. The run AND save buttons now live ONLY in this dock
  // (they used to sit in the left sidebar), so collapsing must not put them out
  // of reach: 翻译 / 重绘 / 停止 plus 应用为原图 / 下载 stay as icons.
  if (collapsed) {
    return (
      <div className="h-full shrink-0 w-7 bg-skin-surface border-l border-skin-border shadow-lg flex flex-col items-center">
        <button
          onClick={() => setCollapsed(false)}
          className="w-full h-8 flex items-center justify-center text-skin-muted hover:text-skin-primary hover:bg-skin-fill transition-colors"
          title={t(lang, 'dockExpand')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
        </button>

        <div className="w-full border-t border-skin-border px-0.5 py-2 flex flex-col items-center gap-1.5">
          {gating.isProcessing ? (
            <button
              onClick={onStop}
              className="w-6 h-6 rounded-md bg-rose-500 hover:bg-rose-600 text-white flex items-center justify-center transition-colors"
              title={t(lang, 'stop')}
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
            </button>
          ) : (
            <>
              <button
                onClick={() => onTranslate(processAll)}
                disabled={!!gating.translateReason}
                title={gating.translateReason || t(lang, processAll ? 'translateAll' : 'translate')}
                className="w-6 h-6 rounded-md border border-sky-500/50 text-sky-600 dark:text-sky-400 hover:bg-sky-500/15 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"></path></svg>
              </button>
              {/* 补丁工坊 composites its patches locally — no API run to start. */}
              {!isManualMode && (
                <button
                  onClick={() => onProcess(processAll)}
                  disabled={!!gating.generateReason}
                  title={gating.generateReason || t(lang, processAll ? 'generateAll' : 'generate')}
                  className="w-6 h-6 rounded-md bg-skin-primary text-skin-primary-fg hover:opacity-90 disabled:bg-skin-muted disabled:text-skin-surface disabled:cursor-not-allowed flex items-center justify-center transition-all"
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                </button>
              )}

              {/* Save actions, same gating as the pinned footer (hidden while a
                  run is in flight, exactly like the footer's result row). */}
              {gating.hasResult && (
                <>
                  <span className="w-4 h-px bg-skin-border my-0.5" />
                  <button
                    onClick={() => onApplyAsOriginal(processAll)}
                    title={processAll ? t(lang, 'applyAsOriginalAllHint') : t(lang, 'applyAsOriginal')}
                    className="w-6 h-6 rounded-md border border-skin-border text-skin-muted hover:text-skin-primary hover:bg-skin-fill flex items-center justify-center transition-colors"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path></svg>
                  </button>
                  <button
                    onClick={() => onDownload(processAll)}
                    title={processAll ? t(lang, 'downloadResultAllHint') : t(lang, 'downloadResult')}
                    className="w-6 h-6 rounded-md border border-skin-border text-skin-muted hover:text-skin-primary hover:bg-skin-fill flex items-center justify-center transition-colors"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                  </button>
                </>
              )}
            </>
          )}
        </div>

        <span className="mt-auto mb-3 text-[9px] font-bold tracking-widest text-skin-muted" style={{ writingMode: 'vertical-rl' }}>
          {t(lang, isManualMode ? 'modeManual' : 'modeApi')}
        </span>
      </div>
    );
  }

  return (
    <aside className="h-full w-[272px] shrink-0 bg-skin-surface border-l border-skin-border shadow-2xl flex flex-col animate-in fade-in slide-in-from-right-4">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-skin-border shrink-0">
        <span className="text-[10px] font-bold text-skin-text">{t(lang, isManualMode ? 'modeManual' : 'modeApi')}</span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {/* 叠放次序：选中了框就能调（AI 重绘 / 手动修补工坊通用） */}
          {selectedRegion && (
            <LayerOrderButtons
              lang={lang}
              canUp={layerIdx >= 0 && layerIdx < currentImage!.regions.length - 1}
              canDown={layerIdx > 0}
              onChange={(dir) => onReorderRegion?.(currentImage!.id, selectedRegion.id, dir)}
            />
          )}
          <button
            onClick={() => setCollapsed(true)}
            className="p-1 rounded text-skin-muted hover:text-skin-primary hover:bg-skin-fill transition-colors"
            title={t(lang, 'dockCollapse')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 5l7 7-7 7" /></svg>
          </button>
        </div>
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
                    onIntentChange={(v) => onUpdateImageIntent(currentImage.id, v)}
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
                      onIntentChange={(v) => onUpdateRegionIntent(currentImage.id, region.id, v)}
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
                {/* 全局：所有意图共用的不变量（比例 / 禁止续画…） */}
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
                  <p className="text-[9px] text-skin-muted leading-tight mt-1">{t(lang, 'promptGlobalHint')}</p>
                </div>

                {/* 场景选择器**二选一**，避免两个分段控件堆在一起：
                    - 没选中任何框 → 「默认场景」（写 config，所有未覆盖的切片都走它）；
                    - 选中了框 / 全图模式 → 「此框场景 / 此图场景」（写该切片的覆盖）。
                    三套提示词槽并存，切场景不丢数据。 */}
                <div className="pt-2 border-t border-skin-border border-dashed transition-all space-y-2">
                  {!hasTarget ? (
                    <div>
                      <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">
                        {t(lang, 'promptDefaultScene')}
                      </label>
                      <div className="flex bg-skin-fill p-0.5 rounded border border-skin-border">
                        {(['translate', 'erase', 'custom'] as const).map(v => (
                          <button
                            key={v}
                            onClick={() => onConfigChange('defaultRedrawIntent', v)}
                            className={`flex-1 px-1 py-1 text-[10px] rounded transition-all ${defaultIntent === v ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted hover:text-skin-text'}`}
                          >
                            {sceneLabel(v)}
                          </button>
                        ))}
                      </div>
                      <p className="text-[9px] text-skin-muted leading-tight mt-1">{t(lang, 'promptDefaultSceneHint')}</p>
                    </div>
                  ) : (
                    <>
                      <div>
                        <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 flex items-center justify-between">
                          <span className="flex items-center gap-2">
                            {t(lang, showFullImagePrompt ? 'promptFullImageScene' : 'promptRegionScene')}
                            {showFullImagePrompt ? (
                              <span className="px-1.5 py-0.5 rounded-full bg-skin-fill text-skin-primary font-mono normal-case truncate max-w-[100px] border border-skin-border">
                                Full Image
                              </span>
                            ) : selectedRegion && (
                              <span className="px-1.5 py-0.5 rounded-full bg-skin-fill text-skin-primary font-mono normal-case truncate max-w-[100px] border border-skin-border">
                                ID: {selectedRegion.id.slice(0, 4)}
                              </span>
                            )}
                          </span>
                          {hasOverride ? (
                            <button
                              onClick={clearTargetIntent}
                              className="text-[9px] text-skin-primary hover:underline bg-transparent border-0 cursor-pointer normal-case font-normal"
                              title={t(lang, 'promptFollowDefaultTip')}
                            >
                              {t(lang, 'promptFollowDefault')}
                            </button>
                          ) : (
                            <span className="text-[9px] text-skin-muted normal-case font-normal">{t(lang, 'promptFollowingDefault')}</span>
                          )}
                        </label>
                        <div className="flex bg-skin-fill p-0.5 rounded border border-skin-border">
                          {(['translate', 'erase', 'custom'] as const).map(v => (
                            <button
                              key={v}
                              onClick={() => handleTargetIntentChange(v)}
                              className={`flex-1 px-1 py-1 text-[10px] rounded transition-all ${activeIntent === v ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted hover:text-skin-text'}`}
                            >
                              {sceneLabel(v)}
                            </button>
                          ))}
                        </div>
                      </div>

                      <label className="text-[10px] uppercase font-bold text-skin-muted flex items-center justify-between">
                        <span className="flex items-center gap-2">
                          {t(lang, showFullImagePrompt ? 'promptFullImageLabel' : 'promptSpecificLabel')}
                        </span>
                        {slotDefault && (
                          <button
                            onClick={() => handleSlotChange(slotDefault)}
                            className="text-[9px] text-skin-primary hover:underline bg-transparent border-0 cursor-pointer normal-case font-normal"
                          >
                            {t(lang, 'promptResetDefault')}
                          </button>
                        )}
                      </label>

                      <textarea
                        key={`${activeIntent}-${showFullImagePrompt ? currentImage!.id : selectedRegion!.id}`}
                        value={slotValue}
                        onChange={(e) => handleSlotChange(e.target.value)}
                        // Lock the textarea while THIS region is being processed.
                        readOnly={!showFullImagePrompt && selectedRegion!.status === 'processing'}
                        className={`w-full h-16 p-2 text-xs border border-skin-border rounded-lg bg-skin-surface focus:ring-1 focus:ring-skin-primary focus:border-skin-primary transition-all resize-none shadow-sm animate-in fade-in ${!showFullImagePrompt && selectedRegion!.status === 'processing' ? 'opacity-60 cursor-not-allowed' : ''}`}
                        placeholder={slotPlaceholder}
                      />

                      {/* 译文是独立字段（不再混进提示词）：只在「翻译」场景出现。
                          手动可改；只有翻译场景会把它作为上下文发给重绘模型。 */}
                      {/* 重试诊断：错误历史此前只渲染在工坊那一行（只有手动修补
                          工坊会出现），AI 重绘 模式里点了失败却无处看原因。 */}
                      {selectedRegion && config.showRetryDiagnostics && (selectedRegion.errorHistory?.length ?? 0) > 0 && (
                        <div className="pt-1.5 border-t border-skin-border">
                          <button
                            onClick={() => setErrHistoryOpen(v => !v)}
                            className="text-[10px] text-skin-muted hover:text-skin-primary transition-colors w-full text-left"
                          >
                            {errHistoryOpen
                              ? t(lang, 'errorHistoryHide')
                              : t(lang, 'errorHistoryShow').replace('{count}', String(selectedRegion.errorHistory!.length))}
                          </button>
                          {errHistoryOpen && (
                            <ol className="mt-1 space-y-1 list-decimal list-inside text-[10px] text-rose-600/90 break-all">
                              {selectedRegion.errorHistory!.map((msg, i) => (
                                <li key={i} className="leading-tight">{msg}</li>
                              ))}
                            </ol>
                          )}
                        </div>
                      )}

                      {activeIntent === 'translate' && (
                        <div className="pt-1">
                          <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">
                            {t(lang, 'promptTranslationLabel')}
                          </label>
                          <textarea
                            key={`tr-${showFullImagePrompt ? currentImage!.id : selectedRegion!.id}`}
                            value={translationValue}
                            onChange={(e) => handleTranslationChange(e.target.value)}
                            className="w-full h-14 p-2 text-xs border border-skin-border rounded-lg bg-skin-surface focus:ring-1 focus:ring-skin-primary focus:border-skin-primary transition-all resize-none shadow-sm"
                            placeholder={t(lang, 'promptTranslationPlaceholder')}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
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

                <div>
                  <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'endRetryRoundsLabel')}</label>
                  <input
                    type="number" min="0" step="1"
                    value={config.maxRetryRounds}
                    onChange={(e) => onConfigChange('maxRetryRounds', Math.max(0, Number(e.target.value)))}
                    className="w-full p-1.5 text-xs border border-skin-border rounded-lg bg-skin-surface shadow-sm"
                  />
                  <span className="block text-[10px] text-skin-muted leading-tight mt-1">{t(lang, 'endRetryRoundsDesc')}</span>
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

      {/* Run / result actions pinned to the bottom edge: the config sections
          above scroll, these never do — and they are now next to the canvas they
          act on instead of at the bottom of the left sidebar. */}
      <DockActions
        config={config}
        images={images}
        currentImage={currentImage}
        processingState={processingState}
        processAll={processAll}
        onProcessAllChange={onProcessAllChange}
        onTranslate={onTranslate}
        onProcess={onProcess}
        onStop={onStop}
        onDownload={onDownload}
        onApplyAsOriginal={onApplyAsOriginal}
      />
    </aside>
  );
};

export default WorkflowDock;
