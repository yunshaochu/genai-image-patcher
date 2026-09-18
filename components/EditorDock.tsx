import React, { useEffect, useRef, useState, useCallback } from 'react';
import { AppConfig, Region, UploadedImage } from '../types';
import { t } from '../services/translations';
import { loadImage, cropRegion, releaseObjectURL } from '../services/imageUtils';

/**
 * Right-side collapsible dock for the editor workflow's "编辑" canvas tab.
 *
 * Shows the currently selected region's editable properties — text content,
 * direction, font size, erase toggle, OCR — replacing the old per-region card
 * list in the left sidebar. Brush touch-up lives here too (collapsed section).
 * Prev/next buttons cycle through the image's editable regions.
 *
 * AI-owned regions (completed by the image-generation pipeline) are shown
 * read-only: the AI patch is final and the editor must not overwrite it.
 */

interface EditorDockProps {
  image: UploadedImage;
  config: AppConfig;
  selectedRegionId: string;
  onSelectRegion: (regionId: string | null) => void;
  busy: boolean;
  /** regionId → last resolved font size (auto-fit or manual), shown as the
   *  font-size input placeholder so users have a reference for manual sizing. */
  computedFontSizes?: Record<string, number>;
  onUpdateRegion: (regionId: string, updates: {
    editorText?: string;
    editorErased?: boolean;
    editorStyle?: Region['editorStyle'];
  }) => void;
  onOcrRegion: (regionId: string) => Promise<void>;
  buildBrushBase: (regionId: string) => Promise<string | null>;
  onBrushChange: (regionId: string, url: string | null) => void;
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
  onUpdateRegion, onOcrRegion, buildBrushBase, onBrushChange,
}) => {
  const lang = config.language;
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1'; } catch { return false; }
  });
  const [brushOpen, setBrushOpen] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed]);

  const editableRegions = image.regions.filter(r => !r.contextOnly);
  const idx = editableRegions.findIndex(r => r.id === selectedRegionId);
  const region = idx >= 0 ? editableRegions[idx] : null;

  // Collapsed: thin strip with an expand handle (kept visible so the user
  // can always get the dock back while a region is selected).
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

  if (!region) return null;

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
        {region.editorErased && (
          <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-sky-100 text-sky-700">
            {t(lang, 'editorErasedBadge')}
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

        {/* Erase toggle + OCR */}
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
