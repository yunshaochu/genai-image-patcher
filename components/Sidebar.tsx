
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AppConfig, UploadedImage } from '../types';
import { t } from '../services/translations';
import { Section } from './sidebar/Section';
import { MangaToolsPanel } from './sidebar/MangaToolsPanel';
import { HelpTip } from './sidebar/HelpTip';

interface SidebarProps {
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  images: UploadedImage[];
  selectedImageId: string | null;
  selectedRegionId: string | null;
  onSelectImage: (id: string) => void;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  currentImage?: UploadedImage;
  onDeleteImage: (imageId: string) => void;
  onClearAllImages: () => void;
  onToggleSkip: (imageId: string) => void;
  onAutoDetect: (scope: 'current' | 'all') => void;
  isDetecting: boolean;
  onOpenGlobalSettings: () => void;
  onOpenHelp: () => void;
  /** Opens the 「发送记录」 inspector (what was actually sent to the AI). */
  onOpenPayloadInspector: () => void;
  /** Gallery export: every image, each as its 已完成 rendering. App owns it —
   *  it needs the same result-URL resolver as Download / Apply (both of which
   *  now live in the right-hand dock). */
  onDownloadAllZip: () => void;
  isZipping: boolean;
  /** Whole-work-state pack: gallery + editing session + settings as one ZIP. */
  onExportWorkState: () => void;
  /** Restore a work-state ZIP (replaces the gallery, merges settings). */
  onImportWorkState: (file: File) => void;
  workStateBusy: boolean;
  workStateStatus: { text: string; tone: 'ok' | 'warn' } | null;
  uploadProgress?: { current: number; total: number } | null;
  /** Nudge to clear the gallery after a download. Owned by App: the run/save
   *  actions live in the right-hand dock now, but the 清空图库 button they point
   *  at is still here (gallery header). */
  clearHighlight: boolean;
  setClearHighlight: React.Dispatch<React.SetStateAction<boolean>>;
}

const SECTION_STORAGE_KEY = 'genai_patcher_sidebar_sections_v1';

const formatBytes = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/**
 * Per-image pipeline state, shown as the corner badge on each thumbnail.
 * A finished result wins, but an in-flight / failed region is surfaced even
 * when earlier regions already completed — the whole point of the badge is to
 * spot retries and leftovers without opening the image.
 */
type ThumbStatus = 'completed' | 'failed' | 'processing' | 'pending';

const resolveThumbStatus = (img: UploadedImage): ThumbStatus | null => {
  if (img.finalResultUrl) return 'completed';
  if (img.regions.some(r => r.status === 'processing')) return 'processing';
  if (img.regions.some(r => r.status === 'failed')) return 'failed';
  if (img.regions.some(r => r.status === 'completed')) return 'completed';
  if (img.regions.length > 0) return 'pending';
  return null;
};

type GalleryStatusLabel =
  | 'galleryStatusCompleted'
  | 'galleryStatusFailed'
  | 'galleryStatusProcessing'
  | 'galleryStatusPending';

const STATUS_BADGE: Record<ThumbStatus, { className: string; labelKey: GalleryStatusLabel; icon: React.ReactNode }> = {
  completed: {
    className: 'bg-emerald-500 text-white',
    labelKey: 'galleryStatusCompleted',
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />,
  },
  failed: {
    className: 'bg-rose-500 text-white',
    labelKey: 'galleryStatusFailed',
    icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M12 8v4m0 3.5h.01" />,
  },
  processing: {
    className: 'bg-skin-primary text-white animate-pulse',
    labelKey: 'galleryStatusProcessing',
    icon: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
  },
  pending: {
    className: 'bg-amber-500 text-white',
    labelKey: 'galleryStatusPending',
    icon: <circle cx="12" cy="12" r="4.5" strokeWidth="3" />,
  },
};

/**
 * One gallery thumbnail, memoized on its own props.
 *
 * Editing in the editor replaces the edited image object — and with it the
 * whole `images` array — so the grid used to re-render every row on every
 * keystroke. With this memo (plus the stable handlers App passes down) only the
 * touched row re-renders. Props must stay primitive/stable: inline closures
 * created per row would defeat the memo.
 */
const ThumbnailItem = React.memo(function ThumbnailItem({
  img,
  lang,
  isSelected,
  onSelectImage,
  onToggleSkip,
  onDeleteImage,
}: {
  img: UploadedImage;
  lang: AppConfig['language'];
  isSelected: boolean;
  onSelectImage: (id: string) => void;
  onToggleSkip: (imageId: string) => void;
  onDeleteImage: (imageId: string) => void;
}) {
  const status = img.isSkipped ? null : resolveThumbStatus(img);
  return (
    <div
      data-image-id={img.id}
      className={`group relative flex flex-col p-1.5 rounded-lg border transition-all cursor-pointer overflow-hidden ${isSelected ? 'border-skin-primary bg-skin-primary/5 shadow-sm ring-1 ring-skin-primary/30' : 'border-skin-border bg-skin-surface hover:border-skin-primary/50 hover:shadow-sm'}`}
      onClick={() => onSelectImage(img.id)}
    >
      {/* Portrait-leaning frame: manga pages are tall, so the old square box
          squeezed a whole page into a thin strip surrounded by empty checker. */}
      <div className="w-full aspect-[3/4] rounded overflow-hidden bg-checkerboard relative mb-1.5">
        <img
          src={img.thumbnailUrl || img.previewUrl}
          alt={img.file.name}
          className={`w-full h-full object-contain transition-transform duration-200 group-hover:scale-[1.03] ${img.isSkipped ? 'grayscale opacity-50' : ''}`}
          loading="lazy"
          decoding="async"
        />

        {img.isSkipped && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/25 z-0">
            <span className="text-[9px] text-white font-bold bg-black/55 px-1.5 py-0.5 rounded tracking-wide">{t(lang, 'skipped')}</span>
          </div>
        )}

        <button
          onClick={(e) => { e.stopPropagation(); onToggleSkip(img.id); }}
          className={`absolute top-1 left-1 p-1 rounded-sm shadow-sm transition-all z-10 ${img.isSkipped ? 'bg-skin-primary text-white' : 'bg-skin-surface/90 text-skin-muted hover:text-skin-primary hover:bg-white'}`}
          title={img.isSkipped ? t(lang, 'enableImage') : t(lang, 'skipImage')}
        >
          {img.isSkipped ? (
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>
          ) : (
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"></path></svg>
          )}
        </button>

        <button
          onClick={(e) => { e.stopPropagation(); onDeleteImage(img.id); }}
          className="absolute top-1 right-1 p-1 rounded-sm bg-skin-surface/90 hover:bg-rose-500 hover:text-white text-rose-500 shadow-sm transition-all z-10"
          title={t(lang, 'deleteImage')}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
        </button>

        {status && (
          <div
            className={`absolute bottom-1 right-1 w-4 h-4 rounded-full flex items-center justify-center shadow-sm ring-1 ring-white/70 z-10 ${STATUS_BADGE[status].className}`}
            title={t(lang, STATUS_BADGE[status].labelKey)}
          >
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">{STATUS_BADGE[status].icon}</svg>
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0 w-full px-0.5">
        <div className="text-[10px] font-medium truncate text-skin-text leading-tight" title={img.file.name}>{img.file.name}</div>
        <div className="flex items-center justify-between gap-1 mt-1">
          <span className="text-[9px] text-skin-muted truncate">{img.originalWidth}×{img.originalHeight}</span>
          {img.regions.length > 0 && (
            <span
              className="text-[9px] bg-skin-fill px-1 rounded text-skin-muted whitespace-nowrap"
              title={t(lang, 'payloadRegionCount', { count: img.regions.length })}
            >
              {t(lang, 'galleryRegionBadge', { count: img.regions.length })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

const Sidebar: React.FC<SidebarProps> = ({
  config,
  setConfig,
  images,
  selectedImageId,
  onSelectImage,
  onUpload,
  currentImage,
  onDeleteImage,
  onClearAllImages,
  onToggleSkip,
  onAutoDetect,
  isDetecting,
  onOpenGlobalSettings,
  onOpenHelp,
  onOpenPayloadInspector,
  onDownloadAllZip,
  isZipping,
  onExportWorkState,
  onImportWorkState,
  workStateBusy,
  workStateStatus,
  uploadProgress,
  clearHighlight,
  setClearHighlight,
}) => {
  const [detectScope, setDetectScope] = useState<'current' | 'all'>('current');
  const [clearConfirmation, setClearConfirmation] = useState(false);
  const [storageUsage, setStorageUsage] = useState<number | null>(null);
  // Work-state import replaces the whole gallery, so it is armed first (same
  // two-step pattern as 清空图库 / 导入配置) before the file picker opens.
  const [workStateImportArmed, setWorkStateImportArmed] = useState(false);
  const workStateFileRef = useRef<HTMLInputElement>(null);

  const handleWorkStateImportClick = () => {
    if (workStateBusy) return;
    if (!workStateImportArmed) {
      setWorkStateImportArmed(true);
      window.setTimeout(() => setWorkStateImportArmed(false), 4000);
      return;
    }
    setWorkStateImportArmed(false);
    workStateFileRef.current?.click();
  };

  const handleWorkStateFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be picked again after a failure
    if (file) onImportWorkState(file);
  };

  // Poll the origin's storage usage (IndexedDB session + everything else on
  // this origin). Refresh immediately when the image count changes, and on a
  // slow interval to catch blob writes from the debounced autosave.
  useEffect(() => {
    let cancelled = false;
    const update = async () => {
      try {
        const est = await navigator.storage.estimate();
        if (!cancelled && typeof est.usage === 'number') setStorageUsage(est.usage);
      } catch { /* Storage API unsupported — hide the indicator */ }
    };
    update();
    const timer = setInterval(update, 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [images.length]);
  
  // Initialize sections state from localStorage or default
  const [sectionsState, setSectionsState] = useState(() => {
    try {
      const saved = localStorage.getItem(SECTION_STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.error("Failed to load sidebar sections state", e);
    }
    // Default: Gallery and Workflow open
    return {
      gallery: true,
      manga: false,
      workflow: true, // DEFAULT: TRUE
      editor: true
    };
  });

  // Persist sections state when changed
  useEffect(() => {
    localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify(sectionsState));
  }, [sectionsState]);

  // Scroll gallery to selected thumbnail when selection changes (e.g. arrow keys)
  useEffect(() => {
    if (!selectedImageId) return;
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-image-id="${selectedImageId}"]`);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
  }, [selectedImageId]);

  const toggleSection = (key: keyof typeof sectionsState) => {
    setSectionsState((prev: any) => ({ ...prev, [key]: !prev[key] }));
  };

  // "processed" = anything beyond the untouched picture. The gallery ZIP exports
  // ALL images, so its badge shows the gallery size (that label sits next to it).
  const processedCount = images.filter(img =>
    img.regions.some(r => r.status === 'completed') || img.finalResultUrl || img.isSkipped
  ).length;
  
  const lang = config.language;

  // Stable identity: the memoized sub-panels receive it as a prop, so an inline
  // closure here would re-render them on every keystroke.
  const handleConfigChange = useCallback((key: keyof AppConfig, value: any) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  }, [setConfig]);

  const handleClearGallery = (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();

      if (clearConfirmation) {
          onClearAllImages();
          setClearConfirmation(false);
          setClearHighlight(false);
      } else {
          setClearConfirmation(true);
          setTimeout(() => setClearConfirmation(false), 3000);
      }
  };

  const isEditorMode = config.processingMode === 'editor';
  // The editor workflow tab is gated behind the manga module + 修补编辑器 switch.
  const editorTabAvailable = config.enableMangaMode && config.enableManualEditor;
  const showMangaToolkit = config.enableMangaMode;

  // If the editor tab's gating switch is turned off while editor mode is
  // active, fall back to manual mode so the UI never gets stuck on a hidden tab.
  useEffect(() => {
    if (isEditorMode && !editorTabAvailable) {
      handleConfigChange('processingMode', 'manual');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditorMode, editorTabAvailable]);

  return (
    <aside className="w-80 h-full bg-skin-surface border-r border-skin-border flex flex-col shadow-2xl z-20 relative">
      <div className="p-5 border-b border-skin-border bg-skin-surface relative flex flex-col gap-4">
        {/* Header Buttons */}
        <div className="absolute top-3 right-3 flex gap-1">
             {/* Native title only renders a name; this one carries the
                 explanation, in the app's own tooltip style. */}
             <HelpTip text={t(lang, 'payloadInspectorTip')}>
               <button
                 onClick={onOpenPayloadInspector}
                 className="p-2 text-skin-muted hover:text-skin-primary hover:bg-skin-fill rounded-full transition-all"
               >
                 <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
               </button>
             </HelpTip>

             <button
               onClick={onOpenGlobalSettings}
               className="p-2 text-skin-muted hover:text-skin-primary hover:bg-skin-fill rounded-full transition-all"
               title={t(lang, 'globalSettings')}
             >
               <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
             </button>

             <button
               onClick={onOpenHelp}
               className="p-2 text-skin-muted hover:text-skin-primary hover:bg-skin-fill rounded-full transition-all"
               title={t(lang, 'helpTitle')}
             >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
             </button>
        </div>

        <div className="pr-28">
           <h1 className="font-bold text-xl text-skin-primary tracking-tight">{t(lang, 'appTitle')}</h1>
           <p className="text-[10px] text-skin-muted uppercase tracking-wider">{t(lang, 'appSubtitle')}</p>
        </div>
     </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
        
        {/* Gallery Section */}
        <Section title={t(lang, 'galleryTitle')} isOpen={sectionsState.gallery} onToggle={() => toggleSection('gallery')}>
           {/* Compact single-row uploaders: the old stacked icon-over-label
               cards spent 80px of sidebar height on two short actions. */}
           <div className="flex gap-2 mb-2">
               <label className="flex-1 h-11 border border-dashed border-skin-border hover:border-skin-primary rounded-lg px-2 cursor-pointer transition-colors bg-skin-fill/30 hover:bg-skin-fill group flex items-center justify-center gap-2">
                  <input type="file" multiple accept="image/*" className="hidden" onChange={onUpload} />
                  <svg className="w-4 h-4 shrink-0 text-skin-muted group-hover:text-skin-primary transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
                  <span className="text-[11px] font-medium text-skin-muted group-hover:text-skin-text whitespace-nowrap">{t(lang, 'uploadFiles')}</span>
               </label>
              
               <label className="flex-1 h-11 border border-dashed border-skin-border hover:border-skin-primary rounded-lg px-2 cursor-pointer transition-colors bg-skin-fill/30 hover:bg-skin-fill group flex items-center justify-center gap-2">
                  <input 
                    type="file" 
                    multiple 
                    {...({ webkitdirectory: "", directory: "" } as any)}
                    className="hidden" 
                    onChange={onUpload}
                    onClick={(e) => (e.currentTarget.value = '')}
                  />
                  <svg className="w-4 h-4 shrink-0 text-skin-muted group-hover:text-skin-primary transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
                  <span className="text-[11px] font-medium text-skin-muted group-hover:text-skin-text whitespace-nowrap">{t(lang, 'uploadFolder')}</span>
               </label>
            </div>

            {uploadProgress && uploadProgress.total > 0 && (
              <div className="mb-2 animate-in fade-in slide-in-from-top-1">
                <div className="flex justify-between text-[10px] text-skin-muted font-bold mb-1">
                  <span>{t(lang, 'uploadingProgress', { current: uploadProgress.current, total: uploadProgress.total })}</span>
                  <span>{Math.round((uploadProgress.current / uploadProgress.total) * 100)}%</span>
                </div>
                <div className="h-1.5 w-full bg-skin-fill rounded-full overflow-hidden">
                  <div
                    className="h-full bg-skin-primary rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
                  ></div>
                </div>
              </div>
            )}

            {/* 工作状态整包：图库 + 编辑现场（编辑器 / AI 重绘数据）+ 设置。
                导出只读，导入会整包替换当前现场，所以走两步确认。常驻显示，
                这样图库为空时也能直接导入一个工作状态包恢复。 */}
            <div className="flex gap-2 mb-2">
                <button
                    type="button"
                    onClick={onExportWorkState}
                    disabled={workStateBusy || images.length === 0}
                    title={t(lang, 'workStateExportTip')}
                    className="flex-1 py-1.5 text-xs border border-skin-border rounded-lg text-skin-muted hover:text-skin-primary hover:border-skin-primary transition-colors flex items-center justify-center gap-2 bg-skin-fill/30 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-skin-muted disabled:hover:border-skin-border"
                >
                    {workStateBusy ? (
                        <>
                            <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                            {t(lang, 'workStateBusy')}
                        </>
                    ) : (
                        <>
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"></path></svg>
                            {t(lang, 'workStateExport')}
                        </>
                    )}
                </button>

                <button
                    type="button"
                    onClick={handleWorkStateImportClick}
                    disabled={workStateBusy}
                    title={workStateImportArmed ? t(lang, 'workStateImportArmHint') : t(lang, 'workStateImportTip')}
                    className={`flex-1 py-1.5 text-xs border rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed ${
                        workStateImportArmed
                            ? 'bg-rose-500 border-rose-600 text-white'
                            : 'border-skin-border text-skin-muted hover:text-skin-primary hover:border-skin-primary bg-skin-fill/30'
                    }`}
                >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M12 12V4m0 8l-4-4m4 4l4-4"></path></svg>
                    {workStateImportArmed ? t(lang, 'workStateImportConfirm') : t(lang, 'workStateImport')}
                </button>
            </div>

            <input
                ref={workStateFileRef}
                type="file"
                accept=".zip,application/zip,application/x-zip-compressed"
                className="hidden"
                onChange={handleWorkStateFile}
            />

            {workStateStatus && (
                <p className={`mb-2 text-[10px] leading-snug ${workStateStatus.tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                    {workStateStatus.text}
                </p>
            )}

            {images.length > 0 ? (
             <div className="space-y-2">
                <div className="flex gap-2">
                    <button 
                        onClick={onDownloadAllZip}
                        disabled={isZipping}
                        className="flex-1 py-1.5 text-xs border border-skin-border rounded-lg text-skin-muted hover:text-skin-primary hover:border-skin-primary transition-colors flex items-center justify-center gap-2 bg-skin-fill/30"
                        title={t(lang, 'downloadZip')}
                    >
                        {isZipping ? (
                            <>
                                <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                                {t(lang, 'zipping')}
                            </>
                        ) : (
                            <>
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                                ZIP ({images.length})
                            </>
                        )}
                    </button>
                    
                    <button
                        type="button"
                        onClick={handleClearGallery}
                        className={`px-3 py-1.5 text-xs border rounded-lg transition-all flex items-center justify-center gap-1 ${
                            clearConfirmation
                                ? 'bg-rose-500 text-white border-rose-600 shadow-md scale-105'
                                : clearHighlight
                                    ? 'border-rose-500 text-rose-500 bg-rose-500/10 shadow-[0_0_10px_rgba(244,63,94,0.45)] animate-pulse'
                                    : 'border-skin-border text-skin-muted hover:text-rose-500 hover:border-rose-500 hover:bg-rose-50 bg-skin-fill/30'
                        }`}
                        title={clearConfirmation ? "Click again to confirm" : clearHighlight ? t(lang, 'clearGalleryHint') : t(lang, 'clearGallery')}
                    >
                        {clearConfirmation ? (
                            <span className="font-bold text-[10px] animate-pulse">SURE?</span>
                        ) : (
                            <>
                                <svg className="w-3.5 h-3.5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                {clearHighlight && <span className="font-bold text-[10px] pointer-events-none whitespace-nowrap">{t(lang, 'clearGallery')}</span>}
                            </>
                        )}
                    </button>
                </div>

                <div className="grid grid-cols-2 gap-2 max-h-[320px] overflow-y-auto custom-scrollbar pr-1 border border-skin-border/30 rounded-lg p-1 bg-skin-fill/10">
                  {images.map(img => (
                    <ThumbnailItem
                      key={img.id}
                      img={img}
                      lang={lang}
                      isSelected={selectedImageId === img.id}
                      onSelectImage={onSelectImage}
                      onToggleSkip={onToggleSkip}
                      onDeleteImage={onDeleteImage}
                    />
                  ))}
                </div>

                <div className="text-[10px] text-skin-muted text-center flex justify-between px-1">
                   <span>{t(lang, 'galleryImages', { count: images.length })}</span>
                   <span>{t(lang, 'galleryProcessed', { count: processedCount })}</span>
                </div>

                {storageUsage !== null && config.enableSessionPersistence && (
                   <div className="text-[10px] text-skin-muted/80 text-center px-1 -mt-1" title={t(lang, 'localCacheTip')}>
                      {t(lang, 'localCache')}: {formatBytes(storageUsage)}
                   </div>
                )}
             </div>
           ) : (
             <div className="text-center py-6 text-xs text-skin-muted italic border-2 border-dashed border-skin-border rounded-lg bg-skin-fill/20">
                {t(lang, 'dropToUpload')}
             </div>
           )}
        </Section>
        
        <Section title={t(lang, 'modeTitle')} isOpen={sectionsState.workflow} onToggle={() => toggleSection('workflow')}>
           <div className="flex bg-skin-fill p-1 rounded-lg border border-skin-border">
               {(['api', 'manual', 'editor'] as const)
                 .filter(m => m !== 'editor' || editorTabAvailable)
                 .map(m => (
                 <button
                   key={m}
                   onClick={() => handleConfigChange('processingMode', m)}
                   className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${config.processingMode === m ? 'bg-skin-surface text-skin-primary shadow-sm' : 'text-skin-muted hover:text-skin-text'}`}
                 >
                    {m === 'api' ? t(lang, 'modeApi') : m === 'manual' ? t(lang, 'modeManual') : t(lang, 'modeEditor')}
                 </button>
               ))}
           </div>

           {/* Square Fill — applies to BOTH API processing and the manual workbench,
               so it lives here in the mode section instead of the API-only settings. */}
           <div className="pt-3 mt-3 border-t border-skin-border/50">
               {/* squareFill is meaningless when inverted masking is active: padding gets undone
                   immediately after the API call / on paste. Disable the toggle and grey it out. */}
               {(() => {
                   const squareFillDisabled = !!config.useInvertedMasking;
                   return (
                       <label className={`flex items-start gap-2 group ${squareFillDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                           <input
                               type="checkbox"
                               checked={config.enableSquareFill && !squareFillDisabled}
                               disabled={squareFillDisabled}
                               onChange={(e) => handleConfigChange('enableSquareFill', e.target.checked)}
                               className="mt-0.5 rounded border-skin-border text-skin-primary focus:ring-skin-primary disabled:opacity-50"
                           />
                           <span className="block text-xs font-medium text-skin-text group-hover:text-skin-primary transition-colors">{t(lang, 'squareFill')}</span>
                           {/* Long description moved behind the "?" (hover/focus) —
                               when the toggle is auto-disabled the icon turns amber
                               and carries the reason instead. */}
                           <HelpTip
                               className="mt-0.5"
                               tone={squareFillDisabled ? 'warn' : 'default'}
                               text={squareFillDisabled
                                   ? t(lang, 'squareFillDisabledByInvertedTip')
                                   : t(lang, 'squareFillDesc')}
                           />
                       </label>

                   );
               })()}
               {config.enableSquareFill && !config.useInvertedMasking && (
                   <div className="mt-2 ml-1 pl-5 border-l-2 border-skin-border/30 space-y-2">
                       {/* Square edge length */}
                       <label className="flex items-center gap-2 text-[11px]">
                           <span className="text-skin-muted">{t(lang, 'squareFillSize')}</span>
                           <input
                               type="number"
                               min={256}
                               max={8192}
                               value={config.squareFillSize}
                               onChange={(e) => handleConfigChange('squareFillSize', Math.max(256, Math.min(8192, Number(e.target.value) || 1024)))}
                               className="w-16 px-1.5 py-0.5 text-xs bg-skin-fill border border-skin-border rounded focus:outline-none focus:ring-1 focus:ring-skin-primary text-skin-text"
                           />
                       </label>
                       {/* Extra inset while cropping back — removes residual blur bleed.
                           Its description also lives behind the "?". */}
                       <label className="flex items-center gap-2 text-[11px]">
                           <span className="text-skin-muted">{t(lang, 'squareFillCropInset')}</span>
                           <HelpTip text={t(lang, 'squareFillCropInsetDesc')} />
                           <input
                               type="number"
                               min={0}
                               max={256}
                               value={config.squareFillCropInset}
                               onChange={(e) => handleConfigChange('squareFillCropInset', Math.max(0, Math.min(256, Math.round(Number(e.target.value)) || 0)))}
                               className="w-16 px-1.5 py-0.5 text-xs bg-skin-fill border border-skin-border rounded focus:outline-none focus:ring-1 focus:ring-skin-primary text-skin-text"
                           />
                       </label>
                       </div>
               )}
           </div>
        </Section>

        {showMangaToolkit && (
            <Section title={t(lang, 'mangaTitle')} isOpen={sectionsState.manga} onToggle={() => toggleSection('manga')}>
               <MangaToolsPanel
                   config={config}
                   onChange={handleConfigChange}
                   onAutoDetect={onAutoDetect}
                   isDetecting={isDetecting}
                   hasCurrentImage={!!currentImage}
                  detectScope={detectScope}
                  setDetectScope={setDetectScope}
               />
            </Section>
        )}

      </div>

    </aside>
  );
};

export default React.memo(Sidebar);
