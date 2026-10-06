import React, { useEffect, useRef, useState, useCallback } from 'react';
import { AppConfig, Region, UploadedImage } from '../types';
import { t } from '../services/translations';
import { loadImage, cropRegion, releaseObjectURL } from '../services/imageUtils';
import { layoutText, drawTextLayout, TextLayout } from '../services/textLayout';
import { getRegionEditorText, resolveAutoFontSize, editorRegionDisplay, LayerDirection } from '../services/mangaEditor';
import { EDITOR_FONTS, SYSTEM_FONT_STACK, editorFontStack, ensureEditorFontLoaded } from '../services/fontService';
import { EraseScope, RestoreScope, isAiOwned, editorPerfOn, DISCRETE_RECOMPOSITE_DEBOUNCE_MS } from '../hooks/useMangaEditor';
import { DockActions, useRunGating } from './sidebar/DockActions';
import { LayerOrderButtons } from './sidebar/LayerOrderButtons';

/**
 * Right-side collapsible dock for the editor workflow's "编辑" canvas tab.
 *
 * The dock is always present on the edit tab and is context-sensitive:
 *  - No box selected → global batch operations (erase / restore / translate)
 *    plus a hint to click a box.
 *  - Box selected → that region's editable properties (text, direction,
 *    font size, erase toggle, brush touch-up) with prev/next cycling.
 *
 * AI-owned regions (completed by the image-generation pipeline) are shown
 * read-only: the AI patch is final and the editor must not overwrite it.
 */

interface EditorDockProps {
  image: UploadedImage;
  /** Gallery — needed by the footer's result actions when 作用范围 is 「全部」. */
  images: UploadedImage[];
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
  }, opts?: { debounceMs?: number }) => void;
  buildBrushBase: (regionId: string) => Promise<string | null>;
  onBrushChange: (regionId: string, url: string | null) => void;
  onErase: (scope: EraseScope) => void;
  /** Batch variants: apply the same operation to every loaded image. */
  onEraseAllImages: (scope: EraseScope) => void;
  onRestoreErase: (scope: RestoreScope) => void;
  onRestoreEraseAllImages: (scope: RestoreScope) => void;
  onTranslate: () => void;
  onTranslateAll: () => void;
  /** True while an auto-translate run is in flight — shows the stop button. */
  translating: boolean;
  /** Image whose translation is currently in flight (null when idle). Batch
   *  runs set it per page, so per-region editing can stay unlocked for the
   *  pages that are NOT being translated right now. */
  translatingImageId?: string | null;
  onStopTranslate: () => void;
  onUnfreeze: (regionId: string) => void;
  onFreeze: (regionId: string) => void;
  /** Batch quick-fix for frozen text_free: whiten the box + typeset. */
  onWhitenFrozenTextFree: () => void;
  /** Scope「所有图片」variant: same whiten over every loaded image. */
  onWhitenFrozenTextFreeAll: () => void;
  /** Its reverse: re-freeze the boxes that quick-fix whitened. */
  onRefreezeWhitedTextFree: () => void;
  /** Scope「所有图片」variant of the reverse. */
  onRefreezeWhitedTextFreeAll: () => void;
  /** Roll the most recent whiten / re-freeze quick-fix back (0 = nothing to undo). */
  onUndoFreezeFix: () => void;
  freezeUndoDepth: number;
  /** One-click reveal of every frozen translation sitting on an AI bubble base. */
  onRevealAiBase: () => void;
  /** Result actions (pinned footer). Scope-aware: `true` = every loaded image. */
  onDownload: (processAll: boolean) => void;
  onApplyAsOriginal: (processAll: boolean) => void;
  /**
   * 调整本框的叠放次序（谁盖谁 = regions 数组下标，下标越大越靠上）。
   * 贴图部分重叠时才看得出差别：编辑画布与拼接都按数组顺序绘制。
   */
  onReorderRegion: (regionId: string, dir: LayerDirection) => void;
}

const COLLAPSE_STORAGE_KEY = 'genai_patcher_editor_dock_collapsed_v1';

// 画笔（画笔修补）手感跨会话记忆：尺寸与颜色都存在浏览器里，收起面板 / 换框 /
// 重开页面后不必再调一遍 —— 这是常用参数，不该每次都回到默认值。
const BRUSH_SIZE_STORAGE_KEY = 'genai_patcher_editor_brush_size_v1';
const BRUSH_COLOR_STORAGE_KEY = 'genai_patcher_editor_brush_color_v1';
const BRUSH_SIZE_MIN = 2;
const BRUSH_SIZE_MAX = 60;
const BRUSH_SIZE_DEFAULT = 14;
const BRUSH_COLOR_DEFAULT = '#ffffff';

/** 读取记忆的画笔大小：缺失 / 越界 / 损坏一律回落到默认值。 */
const loadBrushSize = (): number => {
  try {
    const raw = localStorage.getItem(BRUSH_SIZE_STORAGE_KEY);
    const n = raw === null ? NaN : Number(raw);
    if (!Number.isFinite(n)) return BRUSH_SIZE_DEFAULT;
    return Math.min(BRUSH_SIZE_MAX, Math.max(BRUSH_SIZE_MIN, Math.round(n)));
  } catch {
    return BRUSH_SIZE_DEFAULT;
  }
};

/** 读取记忆的画笔颜色；不是 #rrggbb 一律回落到默认白色。 */
const loadBrushColor = (): string => {
  try {
    const v = localStorage.getItem(BRUSH_COLOR_STORAGE_KEY);
    return v && /^#[0-9a-f]{6}$/i.test(v) ? v : BRUSH_COLOR_DEFAULT;
  } catch {
    return BRUSH_COLOR_DEFAULT;
  }
};

const classBadge = (region: Region, lang: 'zh' | 'en'): string => {
  if (region.detectedClass === 'text_bubble') return t(lang, 'editorClassBubble');
  if (region.detectedClass === 'text_free') return t(lang, 'editorClassFree');
  return t(lang, 'editorClassManual');
};

/**
 * Temporary timing probe (companion to useMangaEditor's recomposite timing):
 * logs when an input takes longer than 30 ms to reach the next painted frame,
 * which covers the handler plus the App re-render it triggers. Only slow ones
 * are logged so typing stays readable; silence with `window.__editorPerf = false`.
 */
const perfProbe = (label: string, startedAt: number) => {
  if (!editorPerfOn()) return;
  requestAnimationFrame(() => {
    const dt = performance.now() - startedAt;
    if (dt > 30) console.log(`[editorPerf] ${label}→上屏 ${Math.round(dt)}ms`);
  });
};

// ---------------------------------------------------------------------------
// Brush layer shortcuts (always visible — no need to expand the painter)
// ---------------------------------------------------------------------------

/**
 * Fill-white / fill-black / clear for the selected region's brush layer.
 *
 * These sit OUTSIDE the collapsible painter because they are the common case
 * (covering a box is one click; brushing is the exception) and because they
 * act on the layer data directly — no preview canvas, no (expensive) base
 * composite needed. The painter re-seeds its preview from `editorBrushUrl`
 * whenever these change it, so the two never disagree.
 */
const BrushActions: React.FC<{
  region: Region;
  lang: 'zh' | 'en';
  onBrushChange: (regionId: string, url: string | null) => void;
  /** AI「擦除」产物优先：本框不许再用画笔修补（会盖住干净底图）。 */
  locked?: boolean;
}> = ({ region, lang, onBrushChange, locked }) => {
  /** One-click whole-box white / black out. A solid colour is stretched onto
   *  the crop when compositing, so a tiny canvas is all that is needed. */
  const fillWholeRegion = async (color: string) => {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const url = await new Promise<string | null>((resolve) => {
      canvas.toBlob(b => resolve(b ? URL.createObjectURL(b) : null), 'image/png');
    });
    if (url) onBrushChange(region.id, url);
  };

  const fillBtn = 'px-1.5 py-0.5 text-[10px] font-bold border border-skin-border rounded hover:border-skin-primary hover:text-skin-primary transition-colors';
  return (
    <>
      <button
        onClick={() => fillWholeRegion('#ffffff')}
        disabled={locked}
        className={`${fillBtn} disabled:opacity-40 disabled:cursor-not-allowed`}
        title={locked ? t(lang, 'editorBrushLockedByAi') : t(lang, 'editorBrushFillTip')}
      >
        {t(lang, 'editorBrushFillWhite')}
      </button>
      <button
        onClick={() => fillWholeRegion('#000000')}
        disabled={locked}
        className={`${fillBtn} disabled:opacity-40 disabled:cursor-not-allowed`}
        title={locked ? t(lang, 'editorBrushLockedByAi') : t(lang, 'editorBrushFillTip')}
      >
        {t(lang, 'editorBrushFillBlack')}
      </button>
      <button
        onClick={() => onBrushChange(region.id, null)}
        disabled={!region.editorBrushUrl || locked}
        className="px-1.5 py-0.5 text-[10px] border border-skin-border rounded text-skin-muted hover:text-rose-500 hover:border-rose-400 disabled:opacity-40 disabled:hover:text-skin-muted disabled:hover:border-skin-border transition-colors"
        title={locked ? t(lang, 'editorBrushLockedByAi') : t(lang, 'editorBrushClearTip')}
      >
        {t(lang, 'editorBrushClear')}
      </button>
    </>
  );
};

// ---------------------------------------------------------------------------
// Brush painter (low-frequency manual touch-up on the selected region)
// ---------------------------------------------------------------------------
const BrushPainter: React.FC<{
  region: Region;
  image: UploadedImage;
  lang: 'zh' | 'en';
  /** Writing direction used while the region has no explicit style yet. */
  preferVerticalDefault: boolean;
  buildBrushBase: (regionId: string) => Promise<string | null>;
  onBrushChange: (regionId: string, url: string | null) => void;
  /** 笔触尺寸 / 颜色由父级持有：一是要记忆在浏览器里，二是吸管取色在面板一级，
   *  画笔预览还没展开时也要能改。 */
  size: number;
  color: string;
  onSizeChange: (size: number) => void;
  /** AI「擦除」产物优先：本框的干净底图不许被笔画盖住。 */
  locked?: boolean;
}> = ({ region, image, lang, preferVerticalDefault, buildBrushBase, onBrushChange, size, color, onSizeChange, locked }) => {
  const displayRef = useRef<HTMLCanvasElement>(null);
  const brushCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseImgRef = useRef<HTMLImageElement | null>(null);
  const paintingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const ownUrlsRef = useRef<string[]>([]);
  /** Typeset text of the region, drawn ABOVE the strokes so the preview matches
   *  the composited patch (which draws the brush first, the text last). */
  const layoutRef = useRef<TextLayout | null>(null);
  /** Last layer URL this painter exported itself. Its echo must not re-seed the
   *  canvas — that would drop a stroke drawn in the meantime. */
  const selfExportedRef = useRef<string | null>(null);

  const [ready, setReady] = useState(false);

  const geomKey = `${region.x},${region.y},${region.width},${region.height}`;
  // Rebuild the base whenever editor content/geometry changes — but NOT on
  // brush strokes (the base excludes the brush layer by design).
  const baseDepsKey = `${region.id}|${geomKey}|${region.editorErased}|${region.editorText}|${JSON.stringify(region.editorStyle)}`;

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
    // Typeset text last: the composited patch draws the brush underneath it,
    // so the preview must too (otherwise 涂白 would look like it hides the
    // translation while the actual patch keeps it visible).
    const layout = layoutRef.current;
    if (layout) {
      ctx.save();
      drawTextLayout(ctx, layout, display.width, display.height);
      ctx.restore();
    }
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

  // (Re)initialize the brush layer canvas at crop resolution. Also re-seeds when
  // `editorBrushUrl` changes underneath us (the always-visible fill / clear
  // shortcuts write the layer directly); our own exports are skipped — their
  // pixels are already on the canvas.
  useEffect(() => {
    let active = true;
    (async () => {
      const base = baseImgRef.current;
      if (!base) return;
      if (region.editorBrushUrl && region.editorBrushUrl === selfExportedRef.current) return;
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
  }, [region.id, geomKey, ready, region.editorBrushUrl]);

  // Keep the preview's text overlay in sync with the typeset content/style.
  useEffect(() => {
    const base = baseImgRef.current;
    const text = getRegionEditorText(region);
    layoutRef.current = base && text.trim()
      ? layoutText(text, base.naturalWidth, base.naturalHeight, region.editorStyle, preferVerticalDefault)
      : null;
    redraw();
  }, [
    region.editorText, region.editorStyle, region.editorWhitedOut,
    ready, preferVerticalDefault, redraw,
  ]);

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
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
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
    // WebP (not PNG): the canvas is re-encoded on every pointer-up, and PNG's
    // encoder is slow enough to stall the brush. Alpha is preserved.
    const url = await new Promise<string | null>((resolve) => {
      brush.toBlob(b => resolve(b ? URL.createObjectURL(b) : null), 'image/webp', 0.94);
    });
    if (url) {
      // Remember it: the prop change this triggers must not re-seed the canvas.
      selfExportedRef.current = url;
      onBrushChange(region.id, url);
    }
  };

  const base = baseImgRef.current;
  const aspect = base ? base.naturalHeight / base.naturalWidth : 1;
  const displayW = 232;
  const displayH = Math.min(320, Math.max(60, Math.round(displayW * aspect)));

  return (
    <div className="flex flex-col gap-2">
      {/* 笔色（含吸管）已提到面板一级：收起时也能取色 / 换色。这里只留笔触大小
          滑块 + 预览画布 —— 大小记在浏览器里，下次打开还是它。 */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-skin-muted whitespace-nowrap">{t(lang, 'editor_brush_size')}</span>
        <input
          type="range" min={BRUSH_SIZE_MIN} max={BRUSH_SIZE_MAX} value={size}
          onChange={(e) => onSizeChange(Number(e.target.value))}
          className="flex-1 h-1 accent-skin-primary"
        />
        <span className="text-[10px] font-mono w-6 text-right">{size}</span>
      </div>

      <div className="border border-skin-border rounded overflow-hidden bg-checkerboard flex justify-center">
        {ready ? (
          <canvas
            ref={displayRef}
            width={base?.naturalWidth || 1}
            height={base?.naturalHeight || 1}
            style={{ width: displayW, height: displayH, touchAction: 'none', cursor: locked ? 'not-allowed' : 'crosshair' }}
            onPointerDown={(e) => {
              if (locked) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              const p = toCropCoords(e);
              if (!p) return;
              paintingRef.current = true;
              lastPointRef.current = null;
              strokeTo(p);
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
      <p className={`text-[9px] italic ${locked ? 'text-amber-600' : 'text-skin-muted'}`}>{t(lang, locked ? 'editorBrushLockedByAi' : 'editorBrushHint')}</p>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 原图吸管（字色从「未被编辑」的源图取）
// ---------------------------------------------------------------------------

/** 取样画布的长边上限：只是取色，颜色不随缩放变化，没必要为一个大框铺满整张原图。 */
const PICK_MAX_PX = 1024;
/** 放大镜：source 邻域 = 64/8 = 8px（原图裁剪像素）。 */
const LOUPE_ZOOM = 8;
const LOUPE_SIZE = 64;

/**
 * 从**原图**吸取文字颜色。
 *
 * 为什么不在画布上取：编辑标签页显示的底图上面盖着「已擦除 / 已嵌字」的贴图，
 * 文字像素早被抹掉了，在渲染结果上点只会点到气泡底色。而区域框对应的原图裁剪
 * 始终还在（UploadedImage.originalUrl 是未被编辑的源文件），在它上面取色既拿得到
 * 真实墨色，也看得见文字 —— 用户才知道该点哪儿。
 *
 * 放大镜把指针周围的像素 8× 铺开、中间套一个 1px 方框标出「会取走哪一颗」，
 * 免得在细笔画上点偏。
 */
const OriginalColorPicker: React.FC<{
  region: Region;
  image: UploadedImage;
  lang: 'zh' | 'en';
  onPick: (hex: string) => void;
  /** 标题 / 说明覆盖项：画笔吸管吸的是「画笔颜色」，文案与字色吸管不同。 */
  label?: string;
  labelTip?: string;
}> = ({ region, image, lang, onPick, label, labelTip }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  /** 原图裁剪（离屏 canvas，1:1 像素）。取色只读它，与显示尺寸/DPR 无关。 */
  const cropRef = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setReady(false);
    (async () => {
      try {
        const img = await loadImage(image.originalUrl);
        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        const x = Math.max(0, Math.floor((region.x / 100) * iw));
        const y = Math.max(0, Math.floor((region.y / 100) * ih));
        const w = Math.max(1, Math.min(iw - x, Math.round((region.width / 100) * iw)));
        const h = Math.max(1, Math.min(ih - y, Math.round((region.height / 100) * ih)));
        const scale = Math.min(1, PICK_MAX_PX / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const crop = document.createElement('canvas');
        crop.width = cw;
        crop.height = ch;
        const cctx = crop.getContext('2d');
        if (!cctx) return;
        cctx.drawImage(img, x, y, w, h, 0, 0, cw, ch);
        if (!active) return;
        cropRef.current = crop;
        setReady(true);
      } catch (e) {
        console.error('Failed to load the original image for the colour picker', e);
      }
    })();
    return () => { active = false; };
  }, [image.originalUrl, region.x, region.y, region.width, region.height]);

  // 把裁剪图铺到显示 canvas 上。
  //
  // 必须单独一个 effect：ready=false 时渲染的是 loading 骨架，`<canvas>` 还不存在
  // ——在加载的 effect 里直接画会被 canvasRef.current === null 静默跳过，等 ready
  // 翻过来 canvas 才挂上，尺寸停在默认的 300×150 且全透明（只看得见棋盘格底）。
  // 取色读的是离屏 cropRef，不受这里影响；这一笔纯粹是让人看得见。
  useEffect(() => {
    const crop = cropRef.current;
    const display = canvasRef.current;
    if (!ready || !crop || !display) return;
    display.width = crop.width;
    display.height = crop.height;
    display.getContext('2d')?.drawImage(crop, 0, 0);
  }, [ready]);

  /** 指针位置 → 原图裁剪里的像素坐标 + 该点颜色；越界返回 null。 */
  const sampleAt = (e: { clientX: number; clientY: number }) => {
    const crop = cropRef.current;
    const display = canvasRef.current;
    if (!crop || !display) return null;
    const rect = display.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const px = Math.floor(((e.clientX - rect.left) / rect.width) * crop.width);
    const py = Math.floor(((e.clientY - rect.top) / rect.height) * crop.height);
    if (px < 0 || py < 0 || px >= crop.width || py >= crop.height) return null;
    const d = crop.getContext('2d')?.getImageData(px, py, 1, 1).data;
    if (!d) return null;
    const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    return { px, py, hex };
  };

  const handleMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = sampleAt(e);
    if (!s) {
      setHover(null);
      return;
    }
    setHover(s.hex);
    const crop = cropRef.current;
    const loupe = loupeRef.current;
    const lctx = loupe?.getContext('2d');
    if (!crop || !loupe || !lctx) return;
    const src = LOUPE_SIZE / LOUPE_ZOOM;
    lctx.imageSmoothingEnabled = false;
    lctx.clearRect(0, 0, loupe.width, loupe.height);
    lctx.drawImage(crop, s.px - src / 2, s.py - src / 2, src, src, 0, 0, loupe.width, loupe.height);
    // 中心方框 = 会被取走的那一颗像素
    const c = loupe.width / 2 - LOUPE_ZOOM / 2;
    lctx.imageSmoothingEnabled = true;
    lctx.strokeStyle = 'rgba(0,0,0,0.85)';
    lctx.lineWidth = 3;
    lctx.strokeRect(c, c, LOUPE_ZOOM, LOUPE_ZOOM);
    lctx.strokeStyle = '#ffffff';
    lctx.lineWidth = 1;
    lctx.strokeRect(c, c, LOUPE_ZOOM, LOUPE_ZOOM);
  };

  const crop = cropRef.current;
  const aspect = crop ? crop.height / crop.width : 1;
  const displayW = 232;
  const displayH = Math.min(240, Math.max(48, Math.round(displayW * aspect)));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <span className="text-[9px] font-bold text-skin-muted shrink-0">{label ?? t(lang, 'editorPickColor')}</span>
        <span className="text-[9px] text-skin-muted italic truncate" title={labelTip ?? t(lang, 'editorPickColorHint')}>
          {labelTip ?? t(lang, 'editorPickColorHint')}
        </span>
      </div>
      <div className="border border-skin-border rounded overflow-hidden bg-checkerboard flex justify-center">
        {ready ? (
          <canvas
            ref={canvasRef}
            style={{ width: displayW, height: displayH, touchAction: 'none', cursor: 'crosshair' }}
            onPointerMove={handleMove}
            onPointerLeave={() => setHover(null)}
            onClick={(e) => {
              const s = sampleAt(e);
              if (s) onPick(s.hex);
            }}
          />
        ) : (
          <div className="w-full h-16 animate-pulse bg-skin-fill flex items-center justify-center text-[9px] text-skin-muted">
            {t(lang, 'editorPickColorLoading')}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <canvas
          ref={loupeRef}
          width={LOUPE_SIZE}
          height={LOUPE_SIZE}
          className="rounded border border-skin-border shrink-0 bg-skin-fill"
          style={{ width: LOUPE_SIZE, height: LOUPE_SIZE, imageRendering: 'pixelated' }}
        />
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="w-5 h-5 rounded border border-skin-border shrink-0"
            style={{ backgroundColor: hover ?? 'transparent' }}
          />
          <span className="text-[10px] font-mono truncate">{hover ?? '—'}</span>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Font picker (per-region override of the global 「编辑器字体」)
// ---------------------------------------------------------------------------

/** 下拉项：显式指定系统字体 —— 覆盖全局字体，即使全局选了某个艺术字体。 */
const EXPLICIT_SYSTEM = '__system__';

/**
 * 字体选择：默认跟随全局设置，也可以单独指定——漫画里同一个页面经常需要给拟声
 * 词换一套字体，也需要把某个框单独打回系统字体。
 *
 * 选中某个字体时先把文件从后端取回来（后端首次会下载并缓存），再写入配置：
 * 字体没就位时 canvas 量不出正确字宽，自动字号会算错，贴图也会先用兜底字体
 * 画一遍。取字体的过程是异步的，所以用一个 loading 状态挡住重复点击。
 */
const RegionFontPicker: React.FC<{
  region: Region;
  lang: 'zh' | 'en';
  backendBaseUrl: string;
  disabled?: boolean;
  onUpdateRegion: EditorDockProps['onUpdateRegion'];
}> = ({ region, lang, backendBaseUrl, disabled, onUpdateRegion }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = region.editorStyle?.fontFamily ?? '';
  // 上一版「系统默认」写进去的是泛型族 'sans-serif'，一并认作系统字体，否则
  // 会被当成一个 unknown 的自定义项显示。
  const isSystemStack = current === SYSTEM_FONT_STACK || current === 'sans-serif';
  const matched = EDITOR_FONTS.find(f => editorFontStack(f.id) === current);
  const selectValue =
    current === '' ? ''
      : isSystemStack ? EXPLICIT_SYSTEM
        : (matched?.id ?? 'custom');

  const apply = (fontFamily: string | undefined) => {
    onUpdateRegion(
      region.id,
      { editorStyle: { fontFamily } },
      { debounceMs: DISCRETE_RECOMPOSITE_DEBOUNCE_MS }
    );
  };

  const handleChange = async (value: string) => {
    setError(null);
    if (value === '') {
      apply(undefined);
      return;
    }
    if (value === EXPLICIT_SYSTEM) {
      apply(SYSTEM_FONT_STACK);
      return;
    }
    const meta = EDITOR_FONTS.find(f => f.id === value);
    if (!meta) return;
    setLoading(true);
    try {
      await ensureEditorFontLoaded(meta.id, backendBaseUrl);
    } catch (e) {
      console.error('Editor font load failed', e);
      setError(t(lang, 'editorFontLoadFailed', { name: meta.label[lang] }));
      setLoading(false);
      return;
    }
    setLoading(false);
    apply(editorFontStack(meta.id));
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] font-bold text-skin-muted w-8 shrink-0">{t(lang, 'editorFont')}</span>
        <select
          value={selectValue}
          disabled={disabled || loading}
          onChange={(e) => handleChange(e.target.value)}
          title={t(lang, 'editorFontTip')}
          className="flex-1 min-w-0 px-1 py-1 text-[10px] border border-skin-border rounded bg-skin-surface text-skin-text disabled:opacity-50"
        >
          <option value="">{t(lang, 'editorFontDefault')}</option>
          <option value={EXPLICIT_SYSTEM}>{t(lang, 'editorFontSystem')}</option>
          {EDITOR_FONTS.map(f => (
            <option key={f.id} value={f.id}>{f.label[lang]}</option>
          ))}
          {selectValue === 'custom' && <option value="custom">{current}</option>}
        </select>
        {loading && <span className="text-[9px] text-skin-primary whitespace-nowrap">{t(lang, 'editorFontDownloading')}</span>}
      </div>
      {error && <p className="text-[9px] text-rose-500 leading-tight">{error}</p>}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Dock
// ---------------------------------------------------------------------------
const EditorDock: React.FC<EditorDockProps> = ({
  image, images, config, selectedRegionId, onSelectRegion, busy, computedFontSizes,
  onConfigChange, onUpdateRegion, buildBrushBase, onBrushChange,
  onErase, onEraseAllImages, onRestoreErase, onRestoreEraseAllImages,
  onTranslate, onTranslateAll,
  translating, translatingImageId, onStopTranslate,
  onUnfreeze, onFreeze, onWhitenFrozenTextFree, onWhitenFrozenTextFreeAll,
  onRefreezeWhitedTextFree, onRefreezeWhitedTextFreeAll,
  onUndoFreezeFix, freezeUndoDepth, onRevealAiBase,
  onDownload, onApplyAsOriginal, onReorderRegion,
}) => {
  const lang = config.language;
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1'; } catch { return false; }
  });
  const [brushOpen, setBrushOpen] = useState(false);
  /** 画笔吸管（一级按钮）的取色面板是否展开。 */
  const [brushPickOpen, setBrushPickOpen] = useState(false);
  /** 画笔尺寸 / 颜色：浏览器本地记忆，重开页面、换框都不再回到默认值。 */
  const [brushSize, setBrushSize] = useState(loadBrushSize);
  const [brushColor, setBrushColor] = useState(loadBrushColor);
  /** 原图吸管面板是否展开（选中的框一变就收起）。 */
  const [pickColorOpen, setPickColorOpen] = useState(false);
  /** Batch scope of the no-selection actions: the current image only, or every
   *  loaded image (erase / restore / translate / 涂白 all respect it). */
  const [imageScope, setImageScope] = useState<'current' | 'all'>('current');
  /** Two-click arm for the 涂白 / 再次冻结 quick-fix when 作用范围 is 「所有图片」
   *  — same guard as the gallery's 清空 button, since a mis-click there rewrites
   *  every page at once. */
  const [whitenConfirm, setWhitenConfirm] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed]);

  // 画笔手感落盘：调一次就一直记住。
  useEffect(() => {
    try { localStorage.setItem(BRUSH_SIZE_STORAGE_KEY, String(brushSize)); } catch { /* ignore */ }
  }, [brushSize]);
  useEffect(() => {
    try { localStorage.setItem(BRUSH_COLOR_STORAGE_KEY, brushColor); } catch { /* ignore */ }
  }, [brushColor]);

  // Switching scope re-arms the confirmation: 「所有图片」must be confirmed again.
  useEffect(() => { setWhitenConfirm(false); }, [imageScope]);

  const editableRegions = image.regions.filter(r => !r.contextOnly);
  const idx = editableRegions.findIndex(r => r.id === selectedRegionId);
  const region = idx >= 0 ? editableRegions[idx] : null;

  // 吸管是「这一个框」的工具：换框就收起，免得在上一个框的原图裁剪上取色。
  useEffect(() => { setPickColorOpen(false); setBrushPickOpen(false); }, [selectedRegionId, image.id]);

  // Result gating for the collapsed rail (same rule as the pinned footer, so the
  // icon rail and the footer can never disagree about what is available).
  const gating = useRunGating({
    config, images, currentImage: image, processAll: imageScope === 'all', resultOnly: true,
  });

  // Collapsed: rail with an expand handle plus the two result actions as icons.
  // Save actions are the one thing this dock owns that has no equivalent
  // elsewhere, so they must survive collapsing — same treatment as WorkflowDock.
  if (collapsed) {
    return (
      <div className="h-full shrink-0 w-7 bg-skin-surface border-l border-skin-border shadow-lg flex flex-col items-center">
        <button
          onClick={() => setCollapsed(false)}
          className="w-full h-8 flex items-center justify-center text-skin-muted hover:text-skin-primary hover:bg-skin-fill transition-colors"
          title={t(lang, 'editorDockProps')}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
        </button>

        {gating.hasResult && (
          <div className="w-full border-t border-skin-border px-0.5 py-2 flex flex-col items-center gap-1.5">
            <button
              onClick={() => onApplyAsOriginal(imageScope === 'all')}
              title={imageScope === 'all' ? t(lang, 'applyAsOriginalAllHint') : t(lang, 'applyAsOriginal')}
              className="w-6 h-6 rounded-md border border-skin-border text-skin-muted hover:text-skin-primary hover:bg-skin-fill flex items-center justify-center transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path></svg>
            </button>
            <button
              onClick={() => onDownload(imageScope === 'all')}
              title={imageScope === 'all' ? t(lang, 'downloadResultAllHint') : t(lang, 'downloadResult')}
              className="w-6 h-6 rounded-md border border-skin-border text-skin-muted hover:text-skin-primary hover:bg-skin-fill flex items-center justify-center transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
            </button>
          </div>
        )}

        <span className="mt-auto mb-3 text-[9px] font-bold tracking-widest text-skin-muted" style={{ writingMode: 'vertical-rl' }}>
          {t(lang, 'editorDockProps')}
        </span>
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
    // Whiten quick-fix scope: the current image, or every loaded image when 作用
    // 范围 is 「所有图片」. Counts cover the SAME set the button will rewrite, so
    // the (n) badge never lies.
    const scopedImages = imageScope === 'all' ? images : [image];
    // Frozen text_free awaiting AI redraw — the whiten quick-fix targets these.
    // Boxes the user froze / unfroze by hand are included: the quick fix is a
    // page-wide batch (the undo button below is the safety net).
    const frozenFreeCount = scopedImages.reduce((n, img) => n + img.regions.filter(r =>
      !r.contextOnly && !isAiOwned(r) &&
      r.detectedClass === 'text_free' && !!r.editorFrozenText?.trim()
    ).length, 0);
    // The reverse direction: text_free boxes this quick-fix whitened and
    // unfroze earlier (editorWhitedOut is only ever set by it).
    const whitedFreeCount = scopedImages.reduce((n, img) => n + img.regions.filter(r =>
      !r.contextOnly && !isAiOwned(r) &&
      r.detectedClass === 'text_free' && !!r.editorWhitedOut && !!r.editorText?.trim()
    ).length, 0);
    // One button, two directions: 涂白解冻 when there is anything still frozen,
    // otherwise 再次冻结 undoes what the button did before. The direction is
    // decided over the WHOLE scope, so a batch run never mixes directions.
    const whitenDirection = frozenFreeCount > 0;
    const whitenCount = whitenDirection ? frozenFreeCount : whitedFreeCount;
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
    // 涂白 / 再次冻结 over the whole scope. On 「所有图片」it is destructive and
    // hard to eyeball, so it arms first and runs on the second click (3 s
    // window) — same guard as the gallery's 清空 button.
    const runWhiten = () => {
      const isAll = imageScope === 'all';
      if (isAll && !whitenConfirm) {
        setWhitenConfirm(true);
        setTimeout(() => setWhitenConfirm(false), 3000);
        return;
      }
      setWhitenConfirm(false);
      if (whitenDirection) {
        isAll ? onWhitenFrozenTextFreeAll() : onWhitenFrozenTextFree();
      } else {
        isAll ? onRefreezeWhitedTextFreeAll() : onRefreezeWhitedTextFree();
      }
    };

    return (
      <aside className="h-full w-[272px] shrink-0 bg-skin-surface border-l border-skin-border shadow-2xl flex flex-col animate-in fade-in slide-in-from-right-4">
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
                onClick={runWhiten}
                disabled={busy || whitenCount === 0}
                className={`w-full px-2 py-1.5 text-[10px] font-bold rounded transition-colors disabled:opacity-50 ${
                  whitenConfirm
                    ? 'border border-rose-500 text-white bg-rose-500 hover:bg-rose-600 animate-pulse'
                    : 'border border-violet-300 text-violet-600 bg-violet-500/10 hover:bg-violet-500/20'
                }`}
                title={
                  whitenConfirm
                    ? t(lang, 'editorWhitenConfirmTip')
                    : imageScope === 'all'
                      ? t(lang, 'editorWhitenFreeAllTip')
                      : whitenDirection ? t(lang, 'editorWhitenFreeTip') : t(lang, 'editorRefreezeFreeTip')
                }
              >
                {whitenConfirm
                  ? t(lang, 'editorConfirmTwice')
                  : <>{t(lang, whitenDirection ? 'editorWhitenFree' : 'editorRefreezeFree')}{whitenCount > 0 ? ` (${whitenCount})` : ''}</>}
              </button>
              {freezeUndoDepth > 0 && (
                <button
                  onClick={onUndoFreezeFix}
                  disabled={busy}
                  className="w-full px-2 py-1.5 text-[10px] font-bold border border-skin-border rounded text-skin-muted hover:text-skin-primary hover:border-skin-primary hover:bg-skin-fill disabled:opacity-50 transition-colors flex items-center justify-center gap-1"
                  title={t(lang, 'editorUndoFreezeTip')}
                >
                  <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"></path></svg>
                  {t(lang, 'editorUndoFreeze')}
                </button>
              )}
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

        {/* Result actions pinned to the dock's bottom edge — the editor's own
            save path. They follow the 作用范围 control at the top of this dock:
            「全部」applies every image that has a result, and ZIPs the finished
            ones for download. */}
        <DockActions
          resultOnly
          config={config}
          images={images}
          currentImage={image}
          processAll={imageScope === 'all'}
          onDownload={onDownload}
          onApplyAsOriginal={onApplyAsOriginal}
        />
      </aside>
    );
  }

  // AI-owned: completed by the image-generation pipeline — read-only here.
  // aiErasedBase boxes are deliberately NOT locked: they are AI-cleaned bases
  // the user still typesets into (see isAiOwned).
  const aiLocked = isAiOwned(region);
  /**
   * Lock for THIS region's edit controls.
   *
   * `busy` is global, but translation is not: during a batch run only the page
   * actually being translated must be frozen (the AI is about to overwrite its
   * regions), while the pages already finished — or not started yet — stay
   * editable, so the user can keep polishing a completed box (字色 / 字体 / 字号
   * …) while the next page renders. Non-translation work (erase) still
   * locks globally through `busy`.
   */
  const regionEditLocked =
    aiLocked || translatingImageId === image.id || (busy && !translating);
  const text = region.editorText ?? '';
  const vertical = region.editorStyle?.isVertical;
  /** 整块文字的旋转角（度，顺时针为正）。0 = 不旋转。 */
  const rotation = region.editorStyle?.rotation ?? 0;

  // Auto-fit size, resolved on the spot when neither an explicit size nor the
  // compositor-published one exists — after a reload `computedFontSizes`
  // (in-memory) starts empty, so without this the field showed a bare "自动"
  // and ±5 stepped from a hard-coded 16 instead of the size on screen.
  const autoFontSize = region.editorStyle?.fontSize || computedFontSizes?.[region.id]
    ? undefined
    : resolveAutoFontSize(
        region,
        image.originalWidth,
        image.originalHeight,
        !!config.enableVerticalTextDefault,
        image.previewUrl !== image.originalUrl
      );
  /** Size shown as the field's placeholder reference (only while auto). */
  const referenceFontSize = region.editorStyle?.fontSize
    ? undefined
    : (computedFontSizes?.[region.id] ?? autoFontSize);

  const stepFontSize = (delta: number) => {
    // Base = explicit size → the size the compositor resolved → the auto-fit
    // size resolved above; 16 only if the box has no typesettable text at all.
    const base = region.editorStyle?.fontSize ?? computedFontSizes?.[region.id] ?? autoFontSize ?? 16;
    // Round so an auto-fit start (e.g. 17.4) doesn't leave fractions in the field.
    const next = Math.min(400, Math.max(6, Math.round(base + delta)));
    const probeStart = performance.now();
    onUpdateRegion(region.id, { editorStyle: { fontSize: next } }, { debounceMs: DISCRETE_RECOMPOSITE_DEBOUNCE_MS });
    perfProbe('字号步进', probeStart);
  };

  const gotoRegion = (delta: number) => {
    const len = editableRegions.length;
    if (len === 0) return;
    onSelectRegion(editableRegions[(idx + delta + len) % len].id);
  };

  // 叠放次序：regions 数组下标越大越靠上（编辑画布按数组顺序叠 DOM，拼接也是按
  // 数组顺序 drawImage）。只有贴图互相重叠时看得出差别。
  const layerIdx = image.regions.findIndex(r => r.id === region.id);
  const canLayerUp = layerIdx >= 0 && layerIdx < image.regions.length - 1;
  const canLayerDown = layerIdx > 0;

  return (
    <aside className="h-full w-[272px] shrink-0 bg-skin-surface border-l border-skin-border shadow-2xl flex flex-col animate-in fade-in slide-in-from-right-4">
      {/* Header: region identity + navigation + collapse */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-skin-border">
        {/* 徽标区可以截断，按钮区永不收缩 —— 面板只有 272px 宽。 */}
        <div className="flex items-center gap-1 min-w-0 overflow-hidden">
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
        {(() => {
          // 显示态由数据推导（AI 意图 + 编辑器字段）：翻译→已冻结 / 擦除→已擦除 /
          // 嵌字完成→已完成。和画布上的徽标共用同一条规则。
          const display = editorRegionDisplay(region, config.defaultRedrawIntent ?? 'translate');
          if (display === 'completed') {
            return <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-emerald-100 text-emerald-700">{t(lang, 'status_completed')}</span>;
          }
          if (display === 'erased') {
            return <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-sky-100 text-sky-700">{t(lang, 'editorErasedBadge')}</span>;
          }
          if (display === 'frozen') {
            return <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-violet-100 text-violet-700">{t(lang, 'editorFrozenBadge')}</span>;
          }
          return null;
        })()}
        </div>
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          {/* 叠放次序：⤒ 一键到最顶 / ↑ 上移一层 / ↓ 下移一层 / ⤓ 一键到最底 */}
          <LayerOrderButtons
            lang={lang}
            canUp={canLayerUp}
            canDown={canLayerDown}
            onChange={(dir) => onReorderRegion(region.id, dir)}
          />
          <span className="w-px h-3.5 bg-skin-border mx-0.5 shrink-0" />
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
          onChange={(e) => {
            const probeStart = performance.now();
            onUpdateRegion(region.id, { editorText: e.target.value });
            perfProbe('按键', probeStart);
          }}
          rows={4}
          disabled={regionEditLocked}
          placeholder={t(lang, 'editorTextPlaceholder')}
          className="w-full p-2 text-xs border border-skin-border rounded-lg bg-skin-surface focus:ring-1 focus:ring-skin-primary focus:border-skin-primary transition-all resize-none shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
        />

        {/* 整页 AI 翻译一并识别出的原文 —— 只读参考，不参与排版 */}
        {region.sourceText?.trim() && (
          <div className="flex items-start gap-1.5">
            <span className="text-[9px] font-bold text-skin-muted shrink-0 mt-0.5">{t(lang, 'editorSourceLabel')}</span>
            <span className="text-[10px] text-skin-muted whitespace-pre-wrap break-words leading-snug flex-1">{region.sourceText}</span>
            <button
              onClick={() => navigator.clipboard.writeText(region.sourceText || '')}
              className="text-skin-muted hover:text-skin-primary shrink-0 mt-0.5"
              title={t(lang, 'copyCrop')}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
            </button>
          </div>
        )}

        {/* Direction + font size */}
        <div className="flex items-center gap-1.5">
          <div className="flex bg-skin-fill p-0.5 rounded border border-skin-border">
            {([undefined, true, false] as const).map((v, i) => (
              <button
                key={i}
                onClick={() => onUpdateRegion(region.id, { editorStyle: { isVertical: v } }, { debounceMs: DISCRETE_RECOMPOSITE_DEBOUNCE_MS })}
                disabled={regionEditLocked}
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
                referenceFontSize
                  ? `${t(lang, 'editorFontSizeAuto')} ${referenceFontSize}px`
                  : t(lang, 'editorFontSizeAuto')
              }
              disabled={regionEditLocked}
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
                  onUpdateRegion(region.id, { editorStyle: { fontSize: clamped } }, { debounceMs: DISCRETE_RECOMPOSITE_DEBOUNCE_MS });
                }
              }}
              title={t(lang, 'editorFontSizeAutoTip')}
              className="flex-1 min-w-0 px-1 py-0.5 text-[10px] text-center border border-skin-border rounded-l bg-skin-surface disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:hidden [&::-webkit-inner-spin-button]:hidden"
            />
            <div className="flex flex-col border border-l-0 border-skin-border rounded-r overflow-hidden bg-skin-fill">
              <button
                onClick={() => stepFontSize(5)}
                disabled={regionEditLocked}
                title="+5"
                className="flex-1 px-1.5 flex items-center justify-center text-skin-muted hover:text-skin-primary hover:bg-skin-surface disabled:opacity-40 transition-all"
              >
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 6.5 L20.5 19 H3.5 Z" /></svg>
              </button>
              <button
                onClick={() => stepFontSize(-5)}
                disabled={regionEditLocked}
                title="-5"
                className="flex-1 px-1.5 flex items-center justify-center text-skin-muted hover:text-skin-primary hover:bg-skin-surface disabled:opacity-40 transition-all border-t border-skin-border"
              >
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 17.5 L3.5 5 H20.5 Z" /></svg>
              </button>
            </div>
          </div>
        </div>

        {/* Rotation: 整块文字绕框中心旋转（-180..180°，顺时针为正）。
            斜排原文 / 艺术字用它对位；0 = 不旋转，行为与以前完全一致。 */}
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-bold text-skin-muted w-8 shrink-0">{t(lang, 'editorRotation')}</span>
          <input
            type="range"
            min={-180}
            max={180}
            step={1}
            value={rotation}
            disabled={regionEditLocked}
            // 拖动要能即时看到效果 —— 传 0 走"立即合成"：防抖层只在合成器忙时
            // 排队，并按最新值合并，不会积压出一串合成。
            onChange={(e) => onUpdateRegion(region.id, { editorStyle: { rotation: Number(e.target.value) } }, { debounceMs: 0 })}
            title={t(lang, 'editorRotationTip')}
            className="flex-1 min-w-0 accent-skin-primary disabled:opacity-50"
          />
          <input
            type="number"
            min={-180}
            max={180}
            value={rotation}
            disabled={regionEditLocked}
            onChange={(e) => {
              // 同字号输入框：打字时不夹取、不改写，否则 "-" 和首位数字会被吃掉。
              const raw = e.target.value;
              if (raw === '' || raw === '-') return;
              const n = Number(raw);
              if (Number.isFinite(n)) onUpdateRegion(region.id, { editorStyle: { rotation: n } });
            }}
            onBlur={(e) => {
              // 空值 / 非法值归零，其余夹到 ±180 并取整；结果与当前值不同才写回，
              // 顺带把输入框里的 "-" / 空串纠正成规范值。
              const n = Number(e.target.value);
              const clamped = e.target.value.trim() === '' || !Number.isFinite(n)
                ? 0
                : Math.max(-180, Math.min(180, Math.round(n)));
              if (clamped !== rotation) {
                onUpdateRegion(region.id, { editorStyle: { rotation: clamped } }, { debounceMs: DISCRETE_RECOMPOSITE_DEBOUNCE_MS });
              }
            }}
            title={t(lang, 'editorRotationTip')}
            className="w-11 shrink-0 px-1 py-0.5 text-[10px] text-center border border-skin-border rounded bg-skin-surface disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:hidden [&::-webkit-inner-spin-button]:hidden"
          />
          <span className="text-[9px] text-skin-muted shrink-0">°</span>
          <button
            onClick={() => onUpdateRegion(region.id, { editorStyle: { rotation: 0 } }, { debounceMs: DISCRETE_RECOMPOSITE_DEBOUNCE_MS })}
            disabled={regionEditLocked || !rotation}
            title={t(lang, 'editorRotationReset')}
            className="shrink-0 p-1 rounded text-skin-muted hover:text-skin-primary hover:bg-skin-fill disabled:opacity-30 transition-colors"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
          </button>
        </div>

        {/* Text colour: auto (AI-chosen / measured ink) or manual override.
            The outline auto-derives as the opposite colour and its width
            scales with the resolved font size.
            手动选的会打上 colorSource 'manual' —— 开启「自动取色」时，擦除量到的
            实测墨色只会覆盖非 manual 的值，所以这里点过的颜色钉得住。 */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-bold text-skin-muted w-8 shrink-0">{t(lang, 'editorTextColor')}</span>
            <div className="flex border border-skin-border rounded overflow-hidden">
              {(['auto', 'black', 'white'] as const).map(v => (
                <button
                  key={v}
                  onClick={() => onUpdateRegion(region.id, {
                    editorStyle: v === 'auto'
                      ? { color: undefined, outlineColor: undefined, outlineWidth: undefined, colorSource: undefined }
                      : v === 'black'
                        ? { color: '#000000', outlineColor: '#ffffff', outlineWidth: undefined, colorSource: 'manual' }
                        : { color: '#ffffff', outlineColor: '#000000', outlineWidth: undefined, colorSource: 'manual' },
                  })}
                  disabled={regionEditLocked}
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
            <button
              onClick={() => setPickColorOpen(o => !o)}
              disabled={regionEditLocked}
              title={t(lang, 'editorPickColorTip')}
              className={`ml-auto px-1.5 py-1 rounded border text-[9px] font-bold transition-colors disabled:opacity-50 ${
                pickColorOpen
                  ? 'border-skin-primary text-skin-primary bg-skin-primary/10'
                  : 'border-skin-border text-skin-muted hover:text-skin-primary hover:border-skin-primary'
              }`}
            >
              {t(lang, 'editorPickColor')}
            </button>
            {/* 生效中的字色。三态按钮读不出「自动取色量到的墨色」（既不是纯黑也
                不是纯白），所以再放一个色块 + 来源说明。 */}
            <span
              className="w-4 h-4 rounded border border-skin-border shrink-0"
              style={{ backgroundColor: region.editorStyle?.color ?? '#000000' }}
              title={`${region.editorStyle?.color ?? '#000000'} · ${
                region.editorStyle?.colorSource === 'manual'
                  ? t(lang, 'editorColorSourceManual')
                  : t(lang, 'editorColorSourceAuto')
              }`}
            />
          </div>
          {pickColorOpen && (
            <div className="border border-skin-border rounded-lg p-2 bg-skin-fill/20">
              <OriginalColorPicker
                region={region}
                image={image}
                lang={lang}
                onPick={(hex) => {
                  onUpdateRegion(
                    region.id,
                    { editorStyle: { color: hex, outlineColor: undefined, outlineWidth: undefined, colorSource: 'manual' } },
                    { debounceMs: DISCRETE_RECOMPOSITE_DEBOUNCE_MS }
                  );
                  setPickColorOpen(false);
                }}
              />
            </div>
          )}
        </div>

        {/* Font: follow the global editor font, or override it for this box. */}
        <RegionFontPicker
          region={region}
          lang={lang}
          backendBaseUrl={config.pythonBackendUrl}
          disabled={regionEditLocked}
          onUpdateRegion={onUpdateRegion}
        />

        {/* Erase toggle */}
        <button
          onClick={() => onUpdateRegion(region.id, { editorErased: !region.editorErased }, { debounceMs: DISCRETE_RECOMPOSITE_DEBOUNCE_MS })}
          // aiErasedBase = 本框贴图就是 AI「擦除」产出的干净底图：编辑器不许再擦
          // （AI 产物绝对优先），按钮直接锁掉。
          disabled={regionEditLocked || !!region.aiErasedBase}
          title={region.aiErasedBase ? t(lang, 'editorEraseLockedByAi') : undefined}
          className={`w-full px-2 py-1.5 text-[10px] font-bold rounded border transition-colors disabled:opacity-50 ${
            region.editorErased
              ? 'border-sky-300 text-sky-600 bg-sky-500/10 hover:bg-sky-500/20'
              : 'bg-skin-primary/10 text-skin-primary border-skin-primary/20 hover:bg-skin-primary/20'
          }`}
        >
          {region.editorErased ? t(lang, 'editorRestoreRegion') : t(lang, 'editorEraseRegion')}
        </button>

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
                disabled={regionEditLocked}
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
            disabled={regionEditLocked || !region.editorText?.trim()}
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

        {/* Brush touch-up. 涂白 / 涂黑 / 清空 stay clickable while the section is
            collapsed — covering a box is the common case, brushing is the
            exception. 笔色（含吸管取色）同样常驻一级：取色不该藏进二级面板里；
            展开后才是笔触大小 + 预览画布。 */}
        {!aiLocked && (
          <div className="border border-skin-border rounded-lg overflow-hidden">
            <div className="flex items-center gap-1 px-2 py-1.5 bg-skin-fill/50">
              <button
                onClick={() => setBrushOpen(o => !o)}
                className="flex items-center gap-1 text-[10px] font-bold text-skin-muted hover:text-skin-text transition-colors shrink-0"
                title={t(lang, 'editorBrushSection')}
              >
                <span>{t(lang, 'editorBrushSection')}</span>
                <svg className={`w-3 h-3 transition-transform ${brushOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
              </button>
              <div className="ml-auto flex items-center gap-1">
                <BrushActions region={region} lang={lang} onBrushChange={onBrushChange} locked={!!region.aiErasedBase} />
              </div>
            </div>

            {/* 一级的笔色行（不需要展开画笔面板）：吸管 + 常用色 + 自定义色。
                吸管取的是本框**原图**的颜色（擦过字也能取到底色），取到就作为画笔
                颜色，并记进浏览器。 */}
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-skin-border bg-skin-fill/30">
              <button
                onClick={() => setBrushPickOpen(o => !o)}
                title={t(lang, 'editorBrushPickColorTip')}
                className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold border rounded shrink-0 transition-colors ${
                  brushPickOpen
                    ? 'border-skin-primary text-skin-primary bg-skin-primary/10'
                    : 'border-skin-border text-skin-muted hover:text-skin-primary hover:border-skin-primary'
                }`}
              >
                <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.66 5.41l.92.92-2.69 2.69-.92-.92 2.69-2.69M17.67 3c-.26 0-.51.1-.71.29l-3.12 3.12-1.93-1.91-1.41 1.41 1.42 1.42L4.16 14.9c-.39.39-.59.9-.59 1.41V19h2.69c.53 0 1.04-.21 1.41-.59l7.78-7.78 1.42 1.41 1.41-1.41-1.91-1.91 3.12-3.12c.38-.38.38-1.02 0-1.41l-1.42-1.42C18.17 3.1 17.92 3 17.67 3z" /></svg>
                {t(lang, 'editorBrushPickColor')}
              </button>
              {['#ffffff', '#000000', '#f8fafc', '#1e293b'].map(c => (
                <button
                  key={c}
                  onClick={() => setBrushColor(c)}
                  title={c}
                  className={`w-5 h-5 rounded-full border border-skin-border shadow-sm shrink-0 ${brushColor === c ? 'ring-2 ring-skin-primary ring-offset-1' : ''}`}
                  style={{ backgroundColor: c }}
                />
              ))}
              <input
                type="color" value={brushColor}
                onChange={(e) => setBrushColor(e.target.value)}
                title={t(lang, 'editor_brush_color')}
                className="w-5 h-5 p-0 border-0 rounded-full overflow-hidden shrink-0"
              />
            </div>

            {brushPickOpen && (
              <div className="p-2 border-t border-skin-border">
                <OriginalColorPicker
                  region={region}
                  image={image}
                  lang={lang}
                  label={t(lang, 'editorBrushPickColor')}
                  labelTip={t(lang, 'editorBrushPickColorTip')}
                  onPick={(hex) => {
                    setBrushColor(hex);
                    setBrushPickOpen(false);
                  }}
                />
              </div>
            )}

            {brushOpen && (
              <div className="p-2 border-t border-skin-border">
                <BrushPainter
                  key={region.id}
                  region={region}
                  image={image}
                  lang={lang}
                  preferVerticalDefault={!!config.enableVerticalTextDefault}
                  buildBrushBase={buildBrushBase}
                  onBrushChange={onBrushChange}
                  size={brushSize}
                  color={brushColor}
                  onSizeChange={setBrushSize}
                  locked={!!region.aiErasedBase}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Same pinned result actions as the global view — see the note there. */}
      <DockActions
        resultOnly
        config={config}
        images={images}
        currentImage={image}
        processAll={imageScope === 'all'}
        onDownload={onDownload}
        onApplyAsOriginal={onApplyAsOriginal}
      />
    </aside>
  );
};

export default React.memo(EditorDock);
