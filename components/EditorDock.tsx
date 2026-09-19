import React, { useEffect, useRef, useState, useCallback } from 'react';
import { AppConfig, Region, UploadedImage } from '../types';
import { t } from '../services/translations';
import { loadImage, cropRegion, releaseObjectURL } from '../services/imageUtils';
import { EraseScope, RestoreScope, isAiOwned } from '../hooks/useMangaEditor';

/**
 * Right-side collapsible dock for the editor workflow's "编辑" canvas tab.
 *
 * The dock is always present on the edit tab and is context-sensitive:
 *  - No box selected → global batch operations (erase / restore / OCR /
 *    translate) plus a hint to click a box.
 *  - Box selected → that region's editable properties (text, direction,
 *    font size, erase toggle, OCR, brush touch-up) with prev/next cycling.
 *
 * AI-owned regions (completed by the image-generation pipeline) are shown
 * read-only: the AI patch is final and the editor must not overwrite it.
 */

interface EditorDockProps {
  image: UploadedImage;
  config: AppConfig;
  selectedRegionId: string | null;
  onSelectRegion: (regionId: string | null) => void;
  busy: boolean;
  /** regionId → last resolved font size (auto-fit or manual), shown as the
   *  font-size input placeholder so users have a reference for manual sizing. */
  computedFontSizes?: Record<string, number>;
  onConfigChange: (key: keyof AppConfig, value: any) => void;
  onUpdateRegion: (regionId: string, updates: {
    editorText?: string;
    editorErased?: boolean;
    editorStyle?: Region['editorStyle'];
  }) => void;
  onOcrRegion: (regionId: string) => Promise<void>;
  buildBrushBase: (regionId: string) => Promise<string | null>;
  onBrushChange: (regionId: string, url: string | null) => void;
  onErase: (scope: EraseScope) => void;
  /** Batch variants: apply the same operation to every loaded image. */
  onEraseAllImages: (scope: EraseScope) => void;
  onRestoreErase: (scope: RestoreScope) => void;
  onRestoreEraseAllImages: (scope: RestoreScope) => void;
  onOcrAll: () => void;
  onTranslate: () => void;
  onTranslateAll: () => void;
  /** True while an auto-translate run is in flight — shows the stop button. */
  translating: boolean;
  onStopTranslate: () => void;
  onUnfreeze: (regionId: string) => void;
  onFreeze: (regionId: string) => void;
  onWhitenFrozenTextFree: () => void;
  /** One-click reveal of every frozen translation sitting on an AI bubble base. */
  onRevealAiBase: () => void;
}

const COLLAPSE_STORAGE_KEY = 'genai_patcher_editor_dock_collapsed_v1';

const classBadge = (region: Region, lang: 'zh' | 'en'): string => {
  if (region.detectedClass === 'text_bubble') return t(lang, 'editorClassBubble');
  if (region.detectedClass === 'text_free') return t(lang, 'editorClassFree');
  return t(lang, 'editorClassManual');
};

// ---------------------------------------------------------------------------
// Brush painter (low-frequency manual touch-up on the selected region)
// ---------------------------------------------------------------------------
const BrushPainter: React.FC<{
  region: Region;
  image: UploadedImage;
  lang: 'zh' | 'en';
  buildBrushBase: (regionId: string) => Promise<string | null>;
  onBrushChange: (regionId: string, url: string | null) => void;
}> = ({ region, image, lang, buildBrushBase, onBrushChange }) => {
  const displayRef = useRef<HTMLCanvasElement>(null);
  const brushCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseImgRef = useRef<HTMLImageElement | null>(null);
  const paintingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const ownUrlsRef = useRef<string[]>([]);

  const [ready, setReady] = useState(false);
  const [brushSize, setBrushSize] = useState(14);
  const [brushColor, setBrushColor] = useState('#ffffff');
  const [hasStrokes, setHasStrokes] = useState(!!region.editorBrushUrl);

  const geomKey = `${region.x},${region.y},${region.width},${region.height}`;
  // Rebuild the base whenever editor content/geometry changes — but NOT on
  // brush strokes (the base excludes the brush layer by design).
  const baseDepsKey = `${region.id}|${geomKey}|${region.editorErased}|${region.editorText}|${region.ocrText}|${JSON.stringify(region.editorStyle)}`;

  const redraw = useCallback(() => {
    const display = displayRef.current;
    const base = baseImgRef.current;
    const brush = brushCanvasRef.current;
    if (!display || !base || !brush) return;
    const ctx = display.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, display.width, display.height);
    ctx.drawImage(base, 0, 0, display.width, display.height);
    ctx.drawImage(brush, 0, 0, display.width, display.height);
  }, []);

  // Load base (composite WITHOUT brush layer, or the plain crop)
  useEffect(() => {
    let active = true;
    setReady(false);
    (async () => {
      try {
        // buildBrushBase hands over ownership of its URL; the crop fallback
        // is created here. Either way we own `base` and release on unmount.
        let base = await buildBrushBase(region.id);
        if (!base) {
          const imgEl = await loadImage(image.previewUrl);
          base = await cropRegion(imgEl, region);
        }
        ownUrlsRef.current.push(base);
        const baseImg = await loadImage(base);
        if (!active) return;
        baseImgRef.current = baseImg;
        setReady(true);
      } catch (e) {
        console.error('Failed to build brush base', e);
      }
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseDepsKey, image.previewUrl]);

  // (Re)initialize the brush layer canvas at crop resolution
  useEffect(() => {
    let active = true;
    (async () => {
      const base = baseImgRef.current;
      if (!base) return;
      const w = base.naturalWidth;
      const h = base.naturalHeight;
      const brush = document.createElement('canvas');
      brush.width = w;
      brush.height = h;
      if (region.editorBrushUrl) {
        try {
          const bimg = await loadImage(region.editorBrushUrl);
          brush.getContext('2d')?.drawImage(bimg, 0, 0, w, h);
        } catch { /* stale URL — start with an empty layer */ }
      }
      if (!active) return;
      brushCanvasRef.current = brush;
      redraw();
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region.id, geomKey, ready]);

  // Release locally-owned crop URLs on unmount
  useEffect(() => {
    const owned = ownUrlsRef.current;
    return () => owned.forEach(releaseObjectURL);
  }, []);

  const toCropCoords = (e: React.PointerEvent): { x: number; y: number } | null => {
    const display = displayRef.current;
    const brush = brushCanvasRef.current;
    if (!display || !brush) return null;
    const rect = display.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * brush.width,
      y: ((e.clientY - rect.top) / rect.height) * brush.height,
    };
  };

  const strokeTo = (p: { x: number; y: number }) => {
    const brush = brushCanvasRef.current;
    const ctx = brush?.getContext('2d');
    if (!brush || !ctx) return;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = brushColor;
    ctx.lineWidth = brushSize;
    ctx.beginPath();
    const last = lastPointRef.current ?? p;
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastPointRef.current = p;
    redraw();
  };

  const exportBrushLayer = async () => {
    const brush = brushCanvasRef.current;
    if (!brush) return;
    const url = await new Promise<string | null>((resolve) => {
      brush.toBlob(b => resolve(b ? URL.createObjectURL(b) : null), 'image/png');
    });
    if (url) onBrushChange(region.id, url);
  };

  /** One-click whole-box white / black out: fill the entire brush layer with a
   *  single colour (same result as painting the box over with a huge brush)
   *  and write it back to the patch right away. */
  const fillWholeRegion = async (color: string) => {
    const brush = brushCanvasRef.current;
    const ctx = brush?.getContext('2d');
    if (!brush || !ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, brush.width, brush.height);
    ctx.restore();
    setHasStrokes(true);
    redraw();
    await exportBrushLayer();
  };

  const base = baseImgRef.current;
  const aspect = base ? base.naturalHeight / base.naturalWidth : 1;
  const displayW = 232;
  const displayH = Math.min(320, Math.max(60, Math.round(displayW * aspect)));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-skin-muted whitespace-nowrap">{t(lang, 'editor_brush_size')}</span>
        <input
          type="range" min="2" max="60" value={brushSize}
          onChange={(e) => setBrushSize(Number(e.target.value))}
          className="flex-1 h-1 accent-skin-primary"
        />
        <span className="text-[10px] font-mono w-6 text-right">{brushSize}</span>
      </div>
      <div className="flex items-center gap-1.5">
        {['#ffffff', '#000000', '#f8fafc', '#1e293b'].map(c => (
          <button
            key={c}
            onClick={() => setBrushColor(c)}
            className={`w-6 h-6 rounded-full border border-skin-border shadow-sm ${brushColor === c ? 'ring-2 ring-skin-primary ring-offset-1' : ''}`}
            style={{ backgroundColor: c }}
          />
        ))}
        <input
          type="color" value={brushColor}
          onChange={(e) => setBrushColor(e.target.value)}
          className="w-6 h-6 p-0 border-0 rounded-full overflow-hidden"
        />
        <button
          onClick={() => {
            const brush = brushCanvasRef.current;
            brush?.getContext('2d')?.clearRect(0, 0, brush.width, brush.height);
            setHasStrokes(false);
            onBrushChange(region.id, null);
            redraw();
          }}
          disabled={!hasStrokes && !region.editorBrushUrl}
          className="ml-auto text-[10px] px-2 py-1 border border-skin-border rounded text-skin-muted hover:text-rose-500 hover:border-rose-400 disabled:opacity-40 transition-colors"
        >
          {t(lang, 'editorBrushClear')}
        </button>
      </div>

      {/* One-click whole-box fill (fast cover-up without brushing) */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => fillWholeRegion('#ffffff')}
          className="flex-1 px-2 py-1 text-[10px] font-bold border border-skin-border rounded hover:border-skin-primary hover:text-skin-primary transition-colors"
          title={t(lang, 'editorBrushFillTip')}
        >
          {t(lang, 'editorBrushFillWhite')}
        </button>
        <button
          onClick={() => fillWholeRegion('#000000')}
          className="flex-1 px-2 py-1 text-[10px] font-bold border border-skin-border rounded hover:border-skin-primary hover:text-skin-primary transition-colors"
          title={t(lang, 'editorBrushFillTip')}
        >
          {t(lang, 'editorBrushFillBlack')}
        </button>
      </div>

      <div className="border border-skin-border rounded overflow-hidden bg-checkerboard flex justify-center">
        {ready ? (
          <canvas
            ref={displayRef}
            width={base?.naturalWidth || 1}
            height={base?.naturalHeight || 1}
            style={{ width: displayW, height: displayH, touchAction: 'none', cursor: 'crosshair' }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              const p = toCropCoords(e);
              if (!p) return;
              paintingRef.current = true;
              lastPointRef.current = null;
              strokeTo(p);
              setHasStrokes(true);
            }}
            onPointerMove={(e) => {
              if (!paintingRef.current) return;
              const p = toCropCoords(e);
              if (p) strokeTo(p);
            }}
            onPointerUp={() => {
              if (!paintingRef.current) return;
              paintingRef.current = false;
              lastPointRef.current = null;
              exportBrushLayer();
            }}
          />
        ) : (
          <div className="w-full h-24 animate-pulse bg-skin-fill" />
        )}
      </div>
      <p className="text-[9px] text-skin-muted italic">{t(lang, 'editorBrushHint')}</p>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Dock
// ---------------------------------------------------------------------------
const EditorDock: React.FC<EditorDockProps> = ({
  image, config, selectedRegionId, onSelectRegion, busy, computedFontSizes,
  onConfigChange, onUpdateRegion, onOcrRegion, buildBrushBase, onBrushChange,
  onErase, onEraseAllImages, onRestoreErase, onRestoreEraseAllImages,
  onOcrAll, onTranslate, onTranslateAll,
  translating, onStopTranslate,
  onUnfreeze, onFreeze, onWhitenFrozenTextFree, onRevealAiBase,
}) => {
  const lang = config.language;
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1'; } catch { return false; }
  });
  const [brushOpen, setBrushOpen] = useState(false);
  /** Batch scope of the no-selection actions: the current image only, or every
   *  loaded image (erase / restore / translate all respect it). */
  const [imageScope, setImageScope] = useState<'current' | 'all'>('current');

  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed]);

  const editableRegions = image.regions.filter(r => !r.contextOnly);
  const idx = editableRegions.findIndex(r => r.id === selectedRegionId);
  const region = idx >= 0 ? editableRegions[idx] : null;

  // Collapsed: thin strip with an expand handle (always kept visible so the
  // user can get the dock back regardless of selection state).
  if (collapsed) {
    return (
      <div className="absolute top-0 right-0 h-full z-20 flex">
        <button
          onClick={() => setCollapsed(false)}
          className="w-7 h-full bg-skin-surface border-l border-skin-border shadow-lg flex flex-col items-center justify-center gap-2 text-skin-muted hover:text-skin-primary hover:bg-skin-fill transition-colors"
          title={t(lang, 'editorDockProps')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
          <span className="text-[9px] font-bold tracking-widest" style={{ writingMode: 'vertical-rl' }}>{t(lang, 'editorDockProps')}</span>
        </button>
      </div>
    );
  }

  // Global view: no box selected → batch operations for the whole image.
  if (!region) {
    // Mirror the hook's pickTranslateTargets filter so the translate button's
    // disabled state matches what would actually be translated: AI-owned
    // regions and regions that already hold a translation (typeset or
    // frozen) are excluded — re-translating those wastes quota.
    const translateTargetCount = image.regions.filter(r =>
      !r.contextOnly && !isAiOwned(r) &&
      !r.editorText?.trim() && !r.editorFrozenText?.trim()
    ).length;
    // Editable but untranslatable → everything is already translated/frozen.
    const editableCount = image.regions.filter(r => !r.contextOnly && !isAiOwned(r)).length;
    const allTranslated = editableCount > 0 && translateTargetCount === 0;
    // Frozen text_free awaiting AI redraw — the whiten quick-fix targets these.
    const frozenFreeCount = image.regions.filter(r =>
      !r.contextOnly && r.detectedClass === 'text_free' && !!r.editorFrozenText?.trim()
    ).length;
    // Frozen translations held back on AI-redrawn bubble bases — the
    // one-click reveal typesets them all without any erasure.
    const aiBaseFrozenCount = image.regions.filter(r =>
      r.aiBubbleBase && !isAiOwned(r) && !!r.editorFrozenText?.trim()
    ).length;

    // Scope-aware dispatchers: '所有图片' routes to the batch variants.
    const runErase = (scope: EraseScope) =>
      imageScope === 'all' ? onEraseAllImages(scope) : onErase(scope);
    const runRestore = (scope: RestoreScope) =>
      imageScope === 'all' ? onRestoreEraseAllImages(scope) : onRestoreErase(scope);
    const runTranslate = () => (imageScope === 'all' ? onTranslateAll() : onTranslate());

    return (
      <aside className="absolute top-0 right-0 h-full w-[272px] z-20 bg-skin-surface border-l border-skin-border shadow-2xl flex flex-col animate-in fade-in slide-in-from-right-4">
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-skin-border">
          <span className="text-[10px] font-bold text-skin-text">{t(lang, 'editorPanelTitle')}</span>
          <div className="ml-auto flex items-center gap-0.5">
            <button
              onClick={() => setCollapsed(true)}
              className="p-1 rounded text-skin-muted hover:text-skin-primary hover:bg-skin-fill transition-colors"
              title={t(lang, 'editorDockCollapse')}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 5l7 7-7 7" /></svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-3">
          {/* Batch scope: erase / restore / translate below apply to the
              current image only, or to every loaded image. */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-skin-muted whitespace-nowrap">{t(lang, 'editorScope')}</span>
            <div className="flex-1 flex bg-skin-fill p-0.5 rounded border border-skin-border">
              <button
                onClick={() => setImageScope('current')}
                className={`flex-1 px-1 py-0.5 text-[9px] rounded transition-all ${imageScope === 'current' ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted'}`}
                title={t(lang, 'editorScopeCurrentTip')}
              >
                {t(lang, 'editorScopeCurrent')}
              </button>
              <button
                onClick={() => setImageScope('all')}
                className={`flex-1 px-1 py-0.5 text-[9px] rounded transition-all ${imageScope === 'all' ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted'}`}
                title={t(lang, 'editorScopeAllTip')}
              >
                {t(lang, 'editorScopeAll')}
              </button>
            </div>
          </div>

          {/* Erasure batch actions */}
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => runErase('bubbleOnly')}
              disabled={busy}
              className="px-2 py-1.5 text-[10px] font-bold bg-skin-primary/10 text-skin-primary border border-skin-primary/20 rounded hover:bg-skin-primary/20 disabled:opacity-50 transition-colors"
              title={t(lang, 'editorEraseBubbleTip')}
            >
              {t(lang, 'editorEraseBubble')}
            </button>
            <button
              onClick={() => runErase('all')}
              disabled={busy}
              className="px-2 py-1.5 text-[10px] font-bold bg-skin-primary/10 text-skin-primary border border-skin-primary/20 rounded hover:bg-skin-primary/20 disabled:opacity-50 transition-colors"
              title={t(lang, 'editorEraseAllTip')}
            >
              {t(lang, 'editorEraseAll')}
            </button>
            <button
              onClick={() => runRestore('textFree')}
              disabled={busy}
              className="px-2 py-1.5 text-[10px] border border-skin-border rounded text-skin-muted hover:text-skin-text hover:bg-skin-fill disabled:opacity-50 transition-colors"
              title={t(lang, 'editorRestoreFreeTip')}
            >
              {t(lang, 'editorRestoreFree')}
            </button>
            <button
              onClick={() => runRestore('all')}
              disabled={busy}
              className="px-2 py-1.5 text-[10px] border border-skin-border rounded text-skin-muted hover:text-skin-text hover:bg-skin-fill disabled:opacity-50 transition-colors"
            >
              {t(lang, 'editorRestoreAll')}
            </button>
          </div>

          {config.enableOCR && (
            <button
              onClick={onOcrAll}
              disabled={busy}
              className="w-full px-2 py-1.5 text-[10px] border border-skin-border rounded text-skin-muted hover:text-skin-primary hover:border-skin-primary disabled:opacity-50 transition-colors flex items-center justify-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"></path></svg>
              {t(lang, 'editorOcrAll')}
            </button>
          )}

          {config.enableTranslationMode && (
            <div className="space-y-1.5">
              {translating ? (
                <button
                  onClick={onStopTranslate}
                  className="w-full px-2 py-1.5 text-[10px] font-bold bg-red-500 text-white rounded hover:bg-red-600 active:scale-95 transition-all flex items-center justify-center gap-1"
                  title={t(lang, 'editorStopTranslateTip')}
                >
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
                  {t(lang, 'editorStopTranslate')}
                </button>
              ) : (
                <button
                  onClick={runTranslate}
                  disabled={busy || (imageScope === 'current' && translateTargetCount === 0)}
                  className="w-full px-2 py-1.5 text-[10px] font-bold bg-skin-primary text-white rounded hover:brightness-110 active:scale-95 disabled:opacity-50 transition-all"
                  title={
                    imageScope === 'all'
                      ? t(lang, 'editorScopeAllTip')
                      : allTranslated ? t(lang, 'editorTranslateDoneTip') : t(lang, 'editorTranslateTip')
                  }
                >
                  {t(lang, 'editorTranslateAll')}
                </button>
              )}
              <button
                onClick={onWhitenFrozenTextFree}
                disabled={busy || frozenFreeCount === 0}
                className="w-full px-2 py-1.5 text-[10px] font-bold border border-violet-300 text-violet-600 bg-violet-500/10 rounded hover:bg-violet-500/20 disabled:opacity-50 transition-colors"
                title={t(lang, 'editorWhitenFreeTip')}
              >
                {t(lang, 'editorWhitenFree')}{frozenFreeCount > 0 ? ` (${frozenFreeCount})` : ''}
              </button>
              <button
                onClick={onRevealAiBase}
                disabled={busy || aiBaseFrozenCount === 0}
                className="w-full px-2 py-1.5 text-[10px] font-bold border border-teal-300 text-teal-600 bg-teal-500/10 rounded hover:bg-teal-500/20 disabled:opacity-50 transition-colors"
                title={t(lang, 'editorRevealAiBaseTip')}
              >
                {t(lang, 'editorRevealAiBase')}{aiBaseFrozenCount > 0 ? ` (${aiBaseFrozenCount})` : ''}
              </button>
            </div>
          )}

          {busy && (
            <div className="flex items-center justify-center gap-2 text-[10px] text-skin-primary">
              <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
              {t(lang, 'editorWorking')}
            </div>
          )}

          <p className="text-[10px] text-skin-muted leading-relaxed border border-dashed border-skin-border rounded-lg p-2 bg-skin-fill/20">
            {t(lang, 'editorEditHint')}
          </p>
        </div>
      </aside>
    );
  }

  // AI-owned: completed by the image-generation pipeline — read-only here.
  const aiLocked = region.status === 'completed' && !region.editorComposited;
  const text = region.editorText ?? region.ocrText ?? '';
  const vertical = region.editorStyle?.isVertical;

  const stepFontSize = (delta: number) => {
    const base = region.editorStyle?.fontSize ?? computedFontSizes?.[region.id] ?? 16;
    const next = Math.min(400, Math.max(6, base + delta));
    onUpdateRegion(region.id, { editorStyle: { fontSize: next } });
  };

  const gotoRegion = (delta: number) => {
    const len = editableRegions.length;
    if (len === 0) return;
    onSelectRegion(editableRegions[(idx + delta + len) % len].id);
  };

  return (
    <aside className="absolute top-0 right-0 h-full w-[272px] z-20 bg-skin-surface border-l border-skin-border shadow-2xl flex flex-col animate-in fade-in slide-in-from-right-4">
      {/* Header: region identity + navigation + collapse */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-skin-border">
        <span className="text-[10px] font-mono text-skin-muted">#{idx + 1}<span className="opacity-50">/{editableRegions.length}</span></span>
        <span className={`text-[8px] font-bold px-1 py-0.5 rounded ${
          region.detectedClass === 'text_bubble' ? 'bg-amber-100 text-amber-700' :
          region.detectedClass === 'text_free' ? 'bg-rose-100 text-rose-600' :
          'bg-skin-fill text-skin-muted'
        }`}>
          {classBadge(region, lang)}
        </span>
        {region.aiBubbleBase && (
          <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-teal-100 text-teal-700" title={t(lang, 'editorAiBaseBadgeTip')}>
            {t(lang, 'editorAiBaseBadge')}
          </span>
        )}
        {region.editorErased && (
          <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-sky-100 text-sky-700">
            {t(lang, 'editorErasedBadge')}
          </span>
        )}
        {region.editorFrozenText?.trim() && (
          <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-violet-100 text-violet-700">
            {t(lang, 'editorFrozenBadge')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            onClick={() => gotoRegion(-1)}
            disabled={editableRegions.length < 2}
            className="p-1 rounded text-skin-muted hover:text-skin-primary hover:bg-skin-fill disabled:opacity-30 transition-colors"
            title={t(lang, 'editorPrevRegion')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
          </button>
          <button
            onClick={() => gotoRegion(1)}
            disabled={editableRegions.length < 2}
            className="p-1 rounded text-skin-muted hover:text-skin-primary hover:bg-skin-fill disabled:opacity-30 transition-colors"
            title={t(lang, 'editorNextRegion')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>
          </button>
          <button
            onClick={() => setCollapsed(true)}
            className="p-1 rounded text-skin-muted hover:text-skin-primary hover:bg-skin-fill transition-colors"
            title={t(lang, 'editorDockCollapse')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 5l7 7-7 7" /></svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-3">
        {aiLocked && (
          <div className="flex items-start gap-1.5 p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 text-[10px] leading-tight">
            <svg className="w-3.5 h-3.5 mt-px shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
            {t(lang, 'editorAiLocked')}
          </div>
        )}

        {/* Text content */}
        <textarea
          value={text}
          onChange={(e) => onUpdateRegion(region.id, { editorText: e.target.value })}
          rows={4}
          disabled={aiLocked}
          placeholder={t(lang, 'editorTextPlaceholder')}
          className="w-full p-2 text-xs border border-skin-border rounded-lg bg-skin-surface focus:ring-1 focus:ring-skin-primary focus:border-skin-primary transition-all resize-none shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
        />

        {/* Direction + font size */}
        <div className="flex items-center gap-1.5">
          <div className="flex bg-skin-fill p-0.5 rounded border border-skin-border">
            {([undefined, true, false] as const).map((v, i) => (
              <button
                key={i}
                onClick={() => onUpdateRegion(region.id, { editorStyle: { isVertical: v } })}
                disabled={aiLocked}
                className={`px-1.5 py-0.5 text-[9px] rounded transition-all disabled:opacity-40 ${vertical === v ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted'}`}
              >
                {v === undefined ? t(lang, 'editorDirAuto') : v ? t(lang, 'editorDirVertical') : t(lang, 'editorDirHorizontal')}
              </button>
            ))}
          </div>
          <div className="w-24 ml-auto flex items-stretch">
            <input
              type="number"
              min={0}
              max={400}
              value={region.editorStyle?.fontSize ?? ''}
              placeholder={
                region.editorStyle?.fontSize
                  ? t(lang, 'editorFontSizeAuto')
                  : computedFontSizes?.[region.id]
                    ? `${t(lang, 'editorFontSizeAuto')} ${computedFontSizes[region.id]}px`
                    : t(lang, 'editorFontSizeAuto')
              }
              disabled={aiLocked}
              onChange={(e) => {
                // No clamping here: this is a controlled input, so clamping
                // mid-typing would rewrite the first digit (typing "4" of
                // "45" becomes "6" → "65").
                const raw = e.target.value;
                onUpdateRegion(region.id, {
                  editorStyle: { fontSize: raw === '' ? undefined : Math.max(1, Number(raw)) },
                });
              }}
              onBlur={(e) => {
                if (e.target.value === '') return;
                const clamped = Math.min(400, Math.max(6, Number(e.target.value)));
                if (clamped !== Number(e.target.value)) {
                  onUpdateRegion(region.id, { editorStyle: { fontSize: clamped } });
                }
              }}
              title={t(lang, 'editorFontSizeAutoTip')}
              className="flex-1 min-w-0 px-1 py-0.5 text-[10px] text-center border border-skin-border rounded-l bg-skin-surface disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:hidden [&::-webkit-inner-spin-button]:hidden"
            />
            <div className="flex flex-col border border-l-0 border-skin-border rounded-r overflow-hidden bg-skin-fill">
              <button
                onClick={() => stepFontSize(5)}
                disabled={aiLocked}
                title="+5"
                className="flex-1 px-1.5 flex items-center justify-center text-skin-muted hover:text-skin-primary hover:bg-skin-surface disabled:opacity-40 transition-all"
              >
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 6.5 L20.5 19 H3.5 Z" /></svg>
              </button>
              <button
                onClick={() => stepFontSize(-5)}
                disabled={aiLocked}
                title="-5"
                className="flex-1 px-1.5 flex items-center justify-center text-skin-muted hover:text-skin-primary hover:bg-skin-surface disabled:opacity-40 transition-all border-t border-skin-border"
              >
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 17.5 L3.5 5 H20.5 Z" /></svg>
              </button>
            </div>
          </div>
        </div>

        {/* Text colour: auto (AI-chosen / default black) or manual override.
            The outline auto-derives as the opposite colour and its width
            scales with the resolved font size. */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-bold text-skin-muted w-8 shrink-0">{t(lang, 'editorTextColor')}</span>
          <div className="flex border border-skin-border rounded overflow-hidden">
            {(['auto', 'black', 'white'] as const).map(v => (
              <button
                key={v}
                onClick={() => onUpdateRegion(region.id, {
                  editorStyle: v === 'auto'
                    ? { color: undefined, outlineColor: undefined, outlineWidth: undefined }
                    : v === 'black'
                      ? { color: '#000000', outlineColor: '#ffffff', outlineWidth: undefined }
                      : { color: '#ffffff', outlineColor: '#000000', outlineWidth: undefined },
                })}
                disabled={busy || aiLocked}
                className={`px-2 py-1 text-[9px] font-bold transition-colors ${
                  (region.editorStyle?.color === '#000000' ? 'black'
                    : region.editorStyle?.color === '#ffffff' ? 'white'
                    : 'auto') === v
                    ? 'bg-skin-primary text-white'
                    : 'text-skin-muted hover:bg-skin-primary/10'
                } disabled:opacity-50`}
              >
                {t(lang, v === 'auto' ? 'editorDirAuto' : v === 'black' ? 'editorColorBlack' : 'editorColorWhite')}
              </button>
            ))}
          </div>
        </div>

        {/* Erase toggle + per-region OCR */}
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={() => onUpdateRegion(region.id, { editorErased: !region.editorErased })}
            disabled={busy || aiLocked}
            className={`px-2 py-1.5 text-[10px] font-bold rounded border transition-colors disabled:opacity-50 ${
              region.editorErased
                ? 'border-sky-300 text-sky-600 bg-sky-500/10 hover:bg-sky-500/20'
                : 'bg-skin-primary/10 text-skin-primary border-skin-primary/20 hover:bg-skin-primary/20'
            }`}
          >
            {region.editorErased ? t(lang, 'editorRestoreRegion') : t(lang, 'editorEraseRegion')}
          </button>
          {config.enableOCR ? (
            <button
              onClick={async () => {
                await onOcrRegion(region.id);
                onUpdateRegion(region.id, {});
              }}
              disabled={busy || aiLocked || region.isOcrLoading}
              className="px-2 py-1.5 text-[10px] border border-skin-border rounded text-skin-muted hover:text-skin-primary hover:border-skin-primary disabled:opacity-50 transition-colors flex items-center justify-center gap-1"
            >
              {region.isOcrLoading ? (
                <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
              ) : 'OCR'}
            </button>
          ) : <span />}
        </div>

        {/* Freeze-state slot: frozen → held-back translation + unfreeze;
            otherwise → manual freeze (pull typeset text out of the image,
            keep it as frozen data for AI redraw). */}
        {region.editorFrozenText?.trim() ? (
          <div className="p-2 rounded-lg bg-violet-500/10 border border-violet-500/30 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <svg className="w-3 h-3 text-violet-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 2v20M4 6l16 12M20 6L4 18M8 4l4 3 4-3M8 20l4-3 4 3" /></svg>
              <span className="text-[10px] font-bold text-violet-600">{t(lang, 'editorFrozenBadge')}</span>
              <button
                onClick={() => onUnfreeze(region.id)}
                disabled={busy || aiLocked}
                className="ml-auto px-2 py-0.5 text-[10px] font-bold rounded border border-violet-300 text-violet-600 bg-violet-500/10 hover:bg-violet-500/20 disabled:opacity-50 transition-colors"
                title={t(lang, 'editorUnfreezeTip')}
              >
                {t(lang, 'editorUnfreeze')}
              </button>
            </div>
            <p className="text-[10px] text-skin-text whitespace-pre-wrap leading-relaxed">{region.editorFrozenText}</p>
            <p className="text-[9px] text-skin-muted leading-tight">{t(lang, 'editorFrozenTip')}</p>
          </div>
        ) : (
          <button
            onClick={() => onFreeze(region.id)}
            disabled={busy || aiLocked || !region.editorText?.trim()}
            className="w-full px-2 py-1.5 text-[10px] font-bold rounded border border-violet-300 text-violet-600 bg-violet-500/10 hover:bg-violet-500/20 disabled:opacity-50 transition-colors flex items-center justify-center gap-1"
            title={t(lang, 'editorFreezeTip')}
          >
            <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 2v20M4 6l16 12M20 6L4 18M8 4l4 3 4-3M8 20l4-3 4 3" /></svg>
            {t(lang, 'editorFreeze')}
          </button>
        )}

        {busy && (
          <div className="flex items-center justify-center gap-2 text-[10px] text-skin-primary">
            <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
            {t(lang, 'editorWorking')}
          </div>
        )}

        {/* Brush touch-up (collapsible, low frequency) */}
        {!aiLocked && (
          <div className="border border-skin-border rounded-lg overflow-hidden">
            <button
              onClick={() => setBrushOpen(o => !o)}
              className="w-full flex items-center justify-between px-2 py-1.5 text-[10px] font-bold text-skin-muted hover:text-skin-text bg-skin-fill/50 transition-colors"
            >
              <span>{t(lang, 'editorBrushSection')}</span>
              <svg className={`w-3 h-3 transition-transform ${brushOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
            </button>
            {brushOpen && (
              <div className="p-2 border-t border-skin-border">
                <BrushPainter
                  key={region.id}
                  region={region}
                  image={image}
                  lang={lang}
                  buildBrushBase={buildBrushBase}
                  onBrushChange={onBrushChange}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};

export default React.memo(EditorDock);
