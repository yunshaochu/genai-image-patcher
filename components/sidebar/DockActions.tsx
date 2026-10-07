
import React from 'react';
import { AppConfig, ProcessingStep, UploadedImage, RedrawIntent, isRegionPaintable, clampRedrawIntent, imageApiSupportsIntent } from '../../types';
import { t } from '../../services/translations';
import { HelpTip } from './HelpTip';

/**
 * Gate shared by every place that can start a run, so the compact rail (dock
 * collapsed) and the full block can never disagree about what is clickable.
 *
 * Scope = selected image or the whole (non-skipped) gallery; translation needs
 * the translation endpoint and something left to translate; generation needs a
 * key and at least one region (unless 无选区时处理全图 is on).
 */
export interface RunGating {
  isProcessing: boolean;
  isDone: boolean;
  hasResult: boolean;
  /** Non-empty when the redraw button must stay disabled (doubles as tooltip). */
  generateReason: string;
  translateReason: string;
  statusKey: string;
}

export const useRunGating = ({
  config,
  images = [],
  currentImage,
  processingState = ProcessingStep.IDLE,
  processAll = false,
  resultOnly = false,
}: {
  config: AppConfig;
  images?: UploadedImage[];
  currentImage?: UploadedImage;
  /** Defaults to IDLE — callers that only need the result gating (e.g. the
   *  edit dock's collapsed rail) have no API run state to pass. */
  processingState?: ProcessingStep;
  processAll?: boolean;
  resultOnly?: boolean;
}): RunGating => {
  const lang = config.language;
  const isProcessing = processingState !== ProcessingStep.IDLE && processingState !== ProcessingStep.DONE;
  const isDone = processingState === ProcessingStep.DONE;

  const hasValidKey = config.provider === 'openai' ? !!config.openaiApiKey : !!config.geminiApiKey;
  const targetImageExists = processAll ? images.length > 0 : !!currentImage;
  const hasRegions = processAll
    ? images.some(i => i.regions.length > 0)
    : (currentImage?.regions.length ?? 0) > 0;
  const canProceedWithEmptyRegions = config.processFullImageIfNoRegions === true;

  const scopedImages = processAll
    ? images.filter(img => !img.isSkipped)
    : (currentImage ? [currentImage] : []);
  const isGenPaintable = (r: UploadedImage['regions'][number]) =>
    isRegionPaintable(r);
  // 译文只对「翻译」意图有意义：擦除 / 自定义不需要译文（也会跳过翻译阶段）。
  // 兜底 = 全局「默认场景」，与重绘管线用的是同一个来源。
  const intentOf = (v: { redrawIntent?: RedrawIntent }): RedrawIntent =>
    clampRedrawIntent(v.redrawIntent, config.enableMangaMode, config.defaultRedrawIntent ?? 'translate');
  const regionNeedsTranslation = (r: UploadedImage['regions'][number]) =>
    isGenPaintable(r) && intentOf(r) === 'translate';
  // 场景标记：当前生图 API 没勾选的场景管线会整体跳过（见 useImageProcessor）。
  // 这里只用来判断「一个框都跑不了」，让重绘按钮不再是一个无声的空操作。
  const intentSupported = (v: { redrawIntent?: RedrawIntent }) => imageApiSupportsIntent(config, intentOf(v));
  const hasPaintableRegions = scopedImages.some(img => img.regions.some(isGenPaintable));
  const anyProcessableRegion = scopedImages.some(img =>
    img.regions.some(isGenPaintable) && (config.useFullImageMasking
      ? intentSupported(img)
      : img.regions.some(r => isGenPaintable(r) && intentSupported(r)))
  );
  const translationReady = scopedImages.some(img =>
    config.useFullImageMasking
      ? img.regions.some(isGenPaintable) && intentOf(img) === 'translate' && !!img.customTranslation?.trim()
      : img.regions.some(r => regionNeedsTranslation(r) && !!r.customTranslation?.trim())
  );
  const translationWorkLeft = scopedImages.some(img =>
    config.useFullImageMasking
      ? img.regions.some(isGenPaintable) && intentOf(img) === 'translate' && !img.customTranslation?.trim()
      : img.regions.some(r => regionNeedsTranslation(r) && !r.customTranslation?.trim())
  );

  const generateReason = resultOnly ? '' : (() => {
    if (!targetImageExists) return 'No image selected';
    if (!hasValidKey) return 'Missing API Key (Check Settings)';
    if (!hasRegions && !canProceedWithEmptyRegions) return 'No regions selected';
    // 有可绘制的框，但当前生图 API 一个场景都没勾选（或全是被跳过的那种）：
    // 跑起来也只是空转，直接说明原因。
    if (hasPaintableRegions && !anyProcessableRegion) return t(lang, 'apiScenarioNoneAvailable');
    // 必须翻译 on but nothing translated yet: generating would only skip
    // everything, so point the user at the translate stage instead. Moot while
    // 重绘前翻译 fills missing translations inline.
    // 漫画模块关闭 → 「翻译」场景不存在，任何框都不会有译文，这里必须整体放行，
    // 否则「必须翻译」会把重绘永久卡死在「没有可翻译内容」上。
    if (config.enableMangaMode && config.enableTranslationMode && config.requireTranslationForGeneration
        && !config.translateBeforeRedraw && !translationReady) {
      return t(lang, 'requireTranslationNone');
    }
    return '';
  })();

  const translateReason = resultOnly ? '' : (() => {
    // 「翻译」场景没勾选时整个翻译阶段都不跑（译文只喂给翻译重绘）。
    if (!imageApiSupportsIntent(config, 'translate')) return t(lang, 'apiScenarioTranslateOff');
    if (!config.enableTranslationMode || !config.translationApiKey || !config.translationBaseUrl) {
      return t(lang, 'translateMissingConfig');
    }
    if (scopedImages.length === 0) return t(lang, 'translateNoTarget');
    if (!translationWorkLeft) return t(lang, 'translateNothingToDo');
    return '';
  })();

  // Scope-aware: with 「全部」 the result actions stay available as long as ANY
  // image has a result — otherwise they would vanish just because the selected
  // picture happens to be untouched, even though there is a gallery to export.
  const hasResult = processAll
    ? images.some(img => !!img.finalResultUrl || img.regions.some(r => r.status === 'completed'))
    : !!currentImage
      && (!!currentImage.finalResultUrl || currentImage.regions.some(r => r.status === 'completed'));

  return {
    isProcessing,
    isDone,
    hasResult,
    generateReason,
    translateReason,
    statusKey: processingState.toLowerCase(),
  };
};

interface DockActionsProps {
  config: AppConfig;
  /** Gallery — only needed when the scope is "all images". */
  images?: UploadedImage[];
  currentImage?: UploadedImage;
  /** Only meaningful while an API job runs; the edit-mode footer has no run. */
  processingState?: ProcessingStep;
  processAll?: boolean;
  onProcessAllChange?: (value: boolean) => void;
  onTranslate?: (processAll: boolean) => void;
  onProcess?: (processAll: boolean) => void;
  onStop?: () => void;
  /** Scope-aware: `true` = every image in the gallery (see the handlers in App). */
  onDownload: (processAll: boolean) => void;
  onApplyAsOriginal: (processAll: boolean) => void;
  /** Edit mode: no API run at all — render the result actions only. */
  resultOnly?: boolean;
}

/**
 * Run / result actions, shared by the two hosts that can own them:
 *
 *  - WorkflowDock (AI 重绘 / 补丁工坊): the full block, pinned to the dock's
 *    bottom edge. It used to sit at the bottom of the left sidebar — i.e. at the
 *    end of a long scroll and far from the canvas it acts on, while every
 *    setting it depends on lives in the right-hand dock.
 *  - Sidebar (edit mode only, `resultOnly`): just 应用为原图 / 下载最终结果. The
 *    editor pipeline is local and its per-box controls live in EditorDock.
 */
export const DockActions: React.FC<DockActionsProps> = ({
  config,
  images = [],
  currentImage,
  processingState = ProcessingStep.IDLE,
  processAll = false,
  onProcessAllChange,
  onTranslate,
  onProcess,
  onStop,
  onDownload,
  onApplyAsOriginal,
  resultOnly = false,
}) => {
  const lang = config.language;
  const { isProcessing, isDone, hasResult, generateReason, translateReason, statusKey } = useRunGating({
    config, images, currentImage, processingState, processAll, resultOnly,
  });
  // 补丁工坊 ('manual') has no API stage: its patches are composited locally
  // (App.handleManualPatchUpdate writes the region straight to 'completed'), so
  // a 开始重绘 button there would start an AI run the mode is not about. 翻译
  // stays — it is a genuinely useful local-aid operation in that workflow.
  const showGenerate = config.processingMode !== 'manual';

  const segBtn = (active: boolean) =>
    `px-2 py-1 text-[10px] font-bold rounded-md transition-all ${active
      ? 'bg-skin-surface shadow-sm text-skin-primary'
      : 'text-skin-muted hover:text-skin-text'}`;

  // Edit mode before any result has nothing to offer — don't leave an empty
  // bordered strip at the bottom of the sidebar.
  if (resultOnly && !hasResult && processingState === ProcessingStep.IDLE) return null;

  return (
    <div className="shrink-0 border-t border-skin-border bg-skin-surface">
      {/* Run status: dot + label + hairline bar. Replaces the old boxed block,
          which spent two stacked rows of chrome on one line of information. */}
      {processingState !== ProcessingStep.IDLE && (
        <div className="px-3 pt-3">
          <div className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${isDone ? 'bg-emerald-500' : 'bg-skin-primary animate-pulse'}`} />
            <span className="text-[11px] font-bold text-skin-text">{t(lang, statusKey as any)}</span>
            {!isDone && <span className="ml-auto text-[10px] text-skin-muted animate-pulse tracking-widest">···</span>}
          </div>
          <div className="mt-2 h-1 rounded-full bg-skin-fill overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-300 ${isDone ? 'w-full bg-emerald-500' : 'w-2/3 bg-skin-primary animate-progress-indeterminate'}`} />
          </div>
        </div>
      )}

      {isProcessing ? (
        <div className="p-3">
          <button
            onClick={onStop}
            className="w-full h-9 rounded-lg bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold shadow-sm shadow-rose-500/30 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
            {t(lang, 'stop')}
          </button>
        </div>
      ) : (
        <div className="p-3 space-y-2">
          {!resultOnly && (
            <>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-wider text-skin-muted">{t(lang, 'runTitle')}</span>
                {/* The two-stage explainer used to be a 3-line paragraph under
                    the buttons; it now lives behind this "?". */}
                {config.enableMangaMode && config.enableTranslationMode && !config.translateBeforeRedraw && (
                  <HelpTip text={t(lang, 'translateStageHint')} />
                )}
              </div>

              {/* Scope as a segmented control. The old checkbox read
                  "作用范围: 全部 12 张图片" and never made clear whether a checked
                  box meant "all" or described the current state. */}
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-skin-muted">{t(lang, 'scope')}</span>
                <div className="ml-auto flex items-center gap-0.5 p-0.5 rounded-lg bg-skin-fill border border-skin-border">
                  <button onClick={() => onProcessAllChange?.(false)} className={segBtn(!processAll)}>
                    {t(lang, 'scopeCurrent')}
                  </button>
                  <button onClick={() => onProcessAllChange?.(true)} className={segBtn(processAll)}>
                    {t(lang, 'scopeAll', { count: images.length })}
                  </button>
                </div>
              </div>

              {/* 「翻译」是漫画场景的动作：漫画模块关闭时整段隐藏（场景里已没有
                  「翻译」，还留一个按钮只会永远点不动）。 */}
              {config.enableMangaMode && (
                <button
                  onClick={() => onTranslate?.(processAll)}
                  disabled={!!translateReason}
                  title={translateReason || t(lang, 'translateStageHint')}
                  className="w-full h-9 rounded-lg border border-sky-500/50 bg-sky-500/5 text-sky-600 dark:text-sky-400 hover:bg-sky-500/15 hover:border-sky-500 text-[11px] font-bold transition-colors disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:bg-sky-500/5 disabled:hover:border-sky-500/50 flex items-center justify-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"></path></svg>
                  {t(lang, processAll ? 'translateAll' : 'translate')}
                </button>
              )}

              {showGenerate && (
                <>
                  <button
                    onClick={() => onProcess?.(processAll)}
                    disabled={!!generateReason}
                    title={generateReason}
                    className="w-full h-10 rounded-lg bg-skin-primary text-skin-primary-fg hover:opacity-90 disabled:bg-skin-muted disabled:text-skin-surface disabled:cursor-not-allowed text-xs font-bold shadow-sm shadow-skin-primary/25 transition-all active:scale-[0.98] disabled:active:scale-100 flex items-center justify-center gap-1.5"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                    {t(lang, processAll ? 'generateAll' : 'generate')}
                  </button>

                  {/* Surfaced only while the primary action is blocked — a hover
                      title alone is easy to miss on a disabled button. */}
                  {generateReason && (
                    <p className="text-[10px] text-center text-skin-muted leading-tight">{generateReason}</p>
                  )}
                  {config.enableMangaMode && config.enableTranslationMode && config.requireTranslationForGeneration
                    && !config.translateBeforeRedraw && (
                    <p className="flex items-start justify-center gap-1 text-[10px] leading-tight text-amber-600 dark:text-amber-400">
                      <svg className="w-3 h-3 shrink-0 mt-px" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path></svg>
                      <span>{t(lang, 'requireTranslation')}</span>
                    </p>
                  )}
                </>
              )}
            </>
          )}

          {hasResult && (
            <div className={`grid grid-cols-2 gap-2 ${resultOnly ? '' : 'pt-2 border-t border-skin-border/60'}`}>
              <button
                onClick={() => onApplyAsOriginal(processAll)}
                title={processAll ? t(lang, 'applyAsOriginalAllHint') : t(lang, 'applyAsOriginal')}
                className="h-8 rounded-lg border border-skin-border bg-skin-fill/40 hover:bg-skin-fill hover:border-skin-primary/50 hover:text-skin-primary text-skin-muted text-[11px] font-medium transition-colors flex items-center justify-center gap-1.5 px-2"
              >
                <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path></svg>
                <span className="truncate">{t(lang, processAll ? 'applyAsOriginalAll' : 'applyAsOriginal')}</span>
              </button>
              <button
                onClick={() => onDownload(processAll)}
                title={processAll ? t(lang, 'downloadResultAllHint') : t(lang, 'downloadResult')}
                className="h-8 rounded-lg border border-skin-border bg-skin-fill/40 hover:bg-skin-fill hover:border-skin-primary/50 hover:text-skin-primary text-skin-muted text-[11px] font-medium transition-colors flex items-center justify-center gap-1.5 px-2"
              >
                <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                <span className="truncate">{t(lang, processAll ? 'downloadResultAll' : 'downloadResult')}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DockActions;
