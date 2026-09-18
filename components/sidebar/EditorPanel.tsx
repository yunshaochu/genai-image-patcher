import React, { useEffect, useRef, useState, useCallback } from 'react';
import { AppConfig, Region, UploadedImage } from '../../types';
import { t } from '../../services/translations';
import { loadImage, cropRegion, releaseObjectURL } from '../../services/imageUtils';
import { EraseScope, RestoreScope } from '../../hooks/useMangaEditor';

/**
 * Sidebar panel for the in-place manga text editor (editor workflow mode).
 *
 * Text tab: regions ARE the text boxes (no "add box" — user-drawn and
 * detected boxes are the editable areas). Supports one-click / per-region
 * flood-fill erasure with scoped undo, and per-region typesetting with
 * auto font size + vertical/horizontal direction.
 *
 * Brush tab: low-frequency manual touch-up painting on the selected region,
 * kept as a secondary tab since auto-erasure covers most cases.
 */

interface EditorPanelProps {
  image: UploadedImage;
  config: AppConfig;
  selectedRegionId: string | null;
  onSelectRegion: (id: string | null) => void;
  busy: boolean;
  onUpdateRegion: (regionId: string, updates: {
    editorText?: string;
    editorErased?: boolean;
    editorStyle?: Region['editorStyle'];
  }) => void;
  onErase: (scope: EraseScope) => void;
  onRestoreErase: (scope: RestoreScope) => void;
  onOcrAll: () => void;
  onOcrRegion: (regionId: string) => void;
  onTranslate: () => void;
  onTranslateAll: () => void;
  buildBrushBase: (regionId: string) => Promise<string | null>;
  onBrushChange: (regionId: string, url: string | null) => void;
}

const classBadge = (region: Region, lang: 'zh' | 'en'): string => {
  if (region.detectedClass === 'text_bubble') return t(lang, 'editorClassBubble');
  if (region.detectedClass === 'text_free') return t(lang, 'editorClassFree');
  return t(lang, 'editorClassManual');
};

// ---------------------------------------------------------------------------
// Brush painter (secondary tab)
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
  const displayW = 256;
  const displayH = Math.min(360, Math.max(60, Math.round(displayW * aspect)));

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
// Main panel
// ---------------------------------------------------------------------------
export const EditorPanel: React.FC<EditorPanelProps> = ({
    image, config, selectedRegionId, onSelectRegion, busy, onUpdateRegion,
    onErase, onRestoreErase, onOcrAll, onOcrRegion, onTranslate, onTranslateAll,
    buildBrushBase, onBrushChange,
}) => {
  const lang = config.language;
  const [tab, setTab] = useState<'text' | 'brush'>('text');

  const textRegions = image.regions.filter(r => !r.contextOnly);
  const selectedRegion = image.regions.find(r => r.id === selectedRegionId) || null;

  return (
    <div className="space-y-3 animate-in fade-in slide-in-from-right-8">
      {/* Sub tabs */}
      <div className="flex bg-skin-fill p-1 rounded-lg border border-skin-border">
        <button
          onClick={() => setTab('text')}
          className={`flex-1 py-1.5 text-[10px] rounded-md transition-all ${tab === 'text' ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted hover:text-skin-text'}`}
        >
          {t(lang, 'editorTabText')}
        </button>
        <button
          onClick={() => setTab('brush')}
          className={`flex-1 py-1.5 text-[10px] rounded-md transition-all ${tab === 'brush' ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted hover:text-skin-text'}`}
        >
          {t(lang, 'editorTabBrush')}
        </button>
      </div>

      {tab === 'text' && (
        <>
          {/* Erasure actions */}
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => onErase('bubbleOnly')}
              disabled={busy}
              className="px-2 py-1.5 text-[10px] font-bold bg-skin-primary/10 text-skin-primary border border-skin-primary/20 rounded hover:bg-skin-primary/20 disabled:opacity-50 transition-colors"
              title={t(lang, 'editorEraseBubbleTip')}
            >
              {t(lang, 'editorEraseBubble')}
            </button>
            <button
              onClick={() => onErase('all')}
              disabled={busy}
              className="px-2 py-1.5 text-[10px] font-bold bg-skin-primary/10 text-skin-primary border border-skin-primary/20 rounded hover:bg-skin-primary/20 disabled:opacity-50 transition-colors"
              title={t(lang, 'editorEraseAllTip')}
            >
              {t(lang, 'editorEraseAll')}
            </button>
            <button
              onClick={() => onRestoreErase('textFree')}
              disabled={busy}
              className="px-2 py-1.5 text-[10px] border border-skin-border rounded text-skin-muted hover:text-skin-text hover:bg-skin-fill disabled:opacity-50 transition-colors"
              title={t(lang, 'editorRestoreFreeTip')}
            >
              {t(lang, 'editorRestoreFree')}
            </button>
            <button
              onClick={() => onRestoreErase('all')}
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
            <div className="grid grid-cols-2 gap-1.5">
              <button
                onClick={onTranslate}
                disabled={busy || textRegions.length === 0}
                className="px-2 py-1.5 text-[10px] font-bold bg-skin-primary text-white rounded hover:brightness-110 active:scale-95 disabled:opacity-50 transition-all"
                title={t(lang, 'editorTranslateTip')}
              >
                {t(lang, 'editorTranslateAll')}
              </button>
              <button
                onClick={onTranslateAll}
                disabled={busy}
                className="px-2 py-1.5 text-[10px] font-bold bg-skin-primary/10 text-skin-primary border border-skin-primary/20 rounded hover:bg-skin-primary/20 disabled:opacity-50 transition-colors"
                title={t(lang, 'editorTranslateAllImagesTip')}
              >
                {t(lang, 'editorTranslateAllImages')}
              </button>
            </div>
          )}

          {busy && (
            <div className="flex items-center justify-center gap-2 text-[10px] text-skin-primary">
              <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
              {t(lang, 'editorWorking')}
            </div>
          )}

          {/* Region cards */}
          {textRegions.length === 0 ? (
            <div className="text-center py-6 text-skin-muted italic text-xs border-2 border-dashed border-skin-border rounded-lg bg-skin-fill/20">
              {t(lang, 'noRegions')}
            </div>
          ) : (
            textRegions.map((region, idx) => {
              const isSelected = region.id === selectedRegionId;
              const text = region.editorText ?? region.ocrText ?? '';
              const vertical = region.editorStyle?.isVertical;
              return (
                <div
                  key={region.id}
                  onClick={() => onSelectRegion(region.id)}
                  className={`p-2 rounded-lg border transition-all cursor-pointer ${isSelected ? 'border-skin-primary bg-skin-primary/5 ring-1 ring-skin-primary/30' : 'border-skin-border bg-skin-fill/30 hover:border-skin-primary/50'}`}
                >
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-[9px] font-mono text-skin-muted">#{idx + 1}</span>
                    <span className={`text-[8px] font-bold px-1 py-0.5 rounded ${
                      region.detectedClass === 'text_bubble' ? 'bg-amber-100 text-amber-700' :
                      region.detectedClass === 'text_free' ? 'bg-rose-100 text-rose-600' :
                      'bg-skin-fill text-skin-muted'
                    }`}>
                      {classBadge(region, lang)}
                    </span>
                    {region.editorErased && (
                      <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-emerald-100 text-emerald-700">
                        {t(lang, 'editorErasedBadge')}
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => onUpdateRegion(region.id, { editorErased: !region.editorErased })}
                        className={`text-[9px] px-1.5 py-0.5 rounded border transition-colors ${
                          region.editorErased
                            ? 'border-emerald-300 text-emerald-600 hover:bg-emerald-50'
                            : 'border-skin-border text-skin-muted hover:text-skin-primary hover:border-skin-primary'
                        }`}
                      >
                        {region.editorErased ? t(lang, 'editorRestoreRegion') : t(lang, 'editorEraseRegion')}
                      </button>
                      {config.enableOCR && (
                        <button
                          onClick={async () => {
                            await onOcrRegion(region.id);
                            onUpdateRegion(region.id, {});
                          }}
                          disabled={region.isOcrLoading}
                          className="text-[9px] px-1.5 py-0.5 rounded border border-skin-border text-skin-muted hover:text-skin-primary hover:border-skin-primary disabled:opacity-50 transition-colors"
                        >
                          {region.isOcrLoading ? '...' : 'OCR'}
                        </button>
                      )}
                    </div>
                  </div>

                  <textarea
                    value={text}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onUpdateRegion(region.id, { editorText: e.target.value })}
                    rows={2}
                    placeholder={t(lang, 'editorTextPlaceholder')}
                    className="w-full p-1.5 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary focus:border-skin-primary transition-all resize-none"
                  />

                  <div className="flex items-center gap-1.5 mt-1.5" onClick={(e) => e.stopPropagation()}>
                    {/* Direction tri-state: auto / vertical / horizontal */}
                    <div className="flex bg-skin-fill p-0.5 rounded border border-skin-border">
                      {([undefined, true, false] as const).map((v, i) => (
                        <button
                          key={i}
                          onClick={() => onUpdateRegion(region.id, { editorStyle: { isVertical: v } })}
                          className={`px-1.5 py-0.5 text-[9px] rounded transition-all ${vertical === v ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted'}`}
                        >
                          {v === undefined ? t(lang, 'editorDirAuto') : v ? t(lang, 'editorDirVertical') : t(lang, 'editorDirHorizontal')}
                        </button>
                      ))}
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={400}
                      value={region.editorStyle?.fontSize ?? ''}
                      placeholder={t(lang, 'editorFontSizeAuto')}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const v = e.target.value === '' ? undefined : Math.max(6, Number(e.target.value));
                        onUpdateRegion(region.id, { editorStyle: { fontSize: v } });
                      }}
                      title={t(lang, 'editorFontSizeAutoTip')}
                      className="w-14 ml-auto px-1 py-0.5 text-[10px] text-center border border-skin-border rounded bg-skin-surface"
                    />
                  </div>
                </div>
              );
            })
          )}
        </>
      )}

      {tab === 'brush' && (
        selectedRegion && !selectedRegion.contextOnly ? (
          <BrushPainter
            key={selectedRegion.id}
            region={selectedRegion}
            image={image}
            lang={lang}
            buildBrushBase={buildBrushBase}
            onBrushChange={onBrushChange}
          />
        ) : (
          <div className="text-center py-6 text-skin-muted italic text-xs border-2 border-dashed border-skin-border rounded-lg bg-skin-fill/20">
            {t(lang, 'editorSelectRegionHint')}
          </div>
        )
      )}
    </div>
  );
};
