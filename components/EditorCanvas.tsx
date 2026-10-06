
import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { UploadedImage, Region, Language, RestoreBox, RedrawIntent, ViewMode, isRegionPaintable, isWorkView } from '../types';
import { t } from '../services/translations';
import { useCanvasInteraction } from '../hooks/useCanvasInteraction';
import { renderRegionWithRestore, loadImage, releaseObjectURL, resolvePatchWindowInsets } from '../services/imageUtils';
import { editorRegionDisplay } from '../services/mangaEditor';

// Helper: convert a canvas to a Blob-backed Object URL (memory-efficient,
// avoids the giant base64 string that toDataURL produces).
const canvasToObjectURL = (canvas: HTMLCanvasElement, type: string = 'image/png'): Promise<string> => {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(URL.createObjectURL(blob));
            else reject(new Error('canvas.toBlob returned null'));
        }, type);
    });
};

/**
 * 拖线测角：线段 (ax,ay)→(bx,by) 对应的 rotation（度，顺时针为正 —— 图像坐标
 * y 向下，atan2 天然匹配 rotation 定义）。用户沿文字的**阅读方向**拖线：
 * 横排沿线 ≈ 基线（≈0°），竖排沿线 ≈ 列方向（≈90°）；rotation 是相对文字
 * 固有方向的倾角，所以竖排要减 90°（不减的话字跟线正好垂直）。
 * 归一化到 (-90, 90]：反方向拖得到 +180° 的等效角（字倒过来），几乎从来不是
 * 意图；真有 >90° 的需求可以在面板上手输。返回 0.1° 取整。
 */
const measureLineAngle = (ax: number, ay: number, bx: number, by: number, verticalText = false): number => {
    let deg = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    if (verticalText) deg -= 90;
    if (deg > 90) deg -= 180;
    else if (deg <= -90) deg += 180;
    return Math.round(deg * 10) / 10;
};

interface EditorCanvasProps {
  image: UploadedImage;
  onUpdateRegions: (imageId: string, regions: Region[]) => void;
  disabled?: boolean;
  language: Language;
  selectedRegionId: string | null;
  onSelectRegion: (regionId: string | null) => void;
  onAdjustRegionSize?: (regionId: string, isExpand: boolean) => void;
  onInteractionStart?: () => void;
  viewMode?: ViewMode;
  restoreMode?: boolean;
  onUpdateRestoreBoxes?: (regionId: string, boxes: RestoreBox[]) => void;
  onUpdateRestoreMask?: (regionId: string, maskBase64: string | null) => void;
  restoreBrushMode?: boolean;
  restoreBrushSize?: number;
  restoreSelectedRegionId?: string | null;
  onSelectRestoreRegion?: (regionId: string | null) => void;
  showRetryDiagnostics?: boolean;
  /** Editor workflow shows text regions (contextOnly bubbles hidden);
   *  generation workflows show the paintable (text) regions.
   *  Default 'editor' preserves historical behavior. */
  regionDisplay?: 'editor' | 'generation';
  /** 全局默认重绘场景：框没单独设过场景时，编辑器的显示态（已冻结/已擦除）按它判定。 */
  defaultRedrawIntent?: RedrawIntent;
  /**
   * Editor workflow only. When provided, Ctrl+wheel with the cursor over the
   * SELECTED box steps its font size by `delta` px (passed as ±5) instead of
   * zooming the canvas; anywhere else Ctrl+wheel keeps zooming. Undefined in
   * the other workflows, where Ctrl+wheel always zooms.
   */
  onStepSelectedFontSize?: (delta: number) => void;
  /**
   * Editor workflow only. Same gesture convention as onStepSelectedFontSize:
   * Shift+wheel with the cursor over the SELECTED box steps its text rotation
   * (degrees, CW) instead of scrolling; Alt additionally held = fine 1°
   * steps. Undefined in the other workflows.
   */
  onStepSelectedRotation?: (delta: number) => void;
  /**
   * Editor workflow only. 两点（拖线）测角模式：armed 时框层不再响应鼠标
   * （框仍可看见，但拖拽/缩放/选中全部让位），用户在画布上按住左键沿原文
   * 斜字拖出一条线，松手时把线的角度（度，顺时针为正，归一化到 (-90, 90]）
   * 经 onAngleMeasureComplete 提交给 SELECTED 框；Esc 取消。拖得太短
   * （<6 屏幕 px）视为误点：不提交、保持 armed 让用户重拖。
   */
  angleMeasureMode?: boolean;
  onAngleMeasureComplete?: (angle: number) => void;
  onAngleMeasureCancel?: () => void;
  /** 全局「默认竖排」设置 —— 测角时解析选中框的实际排版方向要用（与
   *  textLayout.resolveStyle 的自动规则同一来源）。 */
  preferVerticalDefault?: boolean;
  /**
   * Editor workflow only. When true, patch overlays may carry an overflow
   * margin (typeset text spilling out of the box) drawn UNCLIPPED so the
   * overflowing translation stays visible while typesetting. Default false:
   * AI 重绘 / 手动修补工坊 clip the patch back to its box.
   */
  allowPatchOverflow?: boolean;
  /**
   * Replacement for the Reset / Redo button's action. App routes it through the
   * editor engine so resetting a `bubble` ALSO resets the text boxes inside it
   * (freezing their typeset text instead of wiping it) — without that the
   * bubble ⇄ text status sync would immediately re-derive the completion the
   * user just cleared. Undefined = the canvas' own plain reset.
   */
  onResetRegion?: (regionId: string) => void;
}

/**
 * NEW ARCHITECTURE: Pure transform-based zoom & pan
 *
 * Old approach (BROKEN):
 *   viewport(overflow:auto) > centering-wrapper(flex center) > sizing-div(w*zoom,h*zoom) > content-div(transform:scale)
 *   Problems: ResizeObserver resets zoom, flex centering misaligns scroll coords, scroll+transform conflict
 *
 * New approach:
 *   viewport(overflow:hidden) > content-div(transform: translate + scale)
 *   - No scroll container, no flex centering, no sizing wrapper
 *   - Zoom & pan are a single CSS transform on the content div
 *   - Pan via mouse drag (middle button, Alt+left, or Space+left)
 *   - Zoom via Ctrl+Wheel, zooming towards cursor
 *   - ResizeObserver only resets zoom on actual viewport resize, not on zoom changes
 *   - Coordinate calculation uses the content div's getBoundingClientRect which is always correct
 */

const EditorCanvas: React.FC<EditorCanvasProps> = React.memo(({
    image,
    onUpdateRegions,
    disabled = false,
    language,
    selectedRegionId,
    onSelectRegion,
    onAdjustRegionSize,
    onInteractionStart,
    viewMode = 'original',
    restoreMode = false,
    onUpdateRestoreBoxes,
    onUpdateRestoreMask,
    restoreBrushMode = false,
    restoreBrushSize = 8,
    restoreSelectedRegionId = null,
    onSelectRestoreRegion,
    showRetryDiagnostics = false,
    regionDisplay = 'editor',
    defaultRedrawIntent = 'translate',
    onStepSelectedFontSize,
    onStepSelectedRotation,
    angleMeasureMode = false,
    onAngleMeasureComplete,
    onAngleMeasureCancel,
    preferVerticalDefault = false,
    allowPatchOverflow = false,
    onResetRegion,
}: EditorCanvasProps) => {
  // --- Refs ---
  const viewportRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedRegionRef = useRef<HTMLDivElement>(null);

  // --- Zoom & Pan State ---
  // zoom: scale factor (1 = fit-to-screen, >1 = zoomed in)
  // panX/panY: offset in screen pixels from the "centered" position
  const [zoom, setZoom] = useState(0.01); // Start tiny to avoid flash of oversized image
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);

  // Track whether the initial fit-to-screen has been applied
  const [isZoomReady, setIsZoomReady] = useState(false);

  // Viewport dimensions as state (so transform re-renders when viewport resizes)
  const [vpW, setVpW] = useState(0);
  const [vpH, setVpH] = useState(0);

  // Track whether user has manually changed zoom (to prevent ResizeObserver from resetting it)
  const userZoomedRef = useRef(false);

  // --- Pan interaction refs ---
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ mouseX: 0, mouseY: 0, panX: 0, panY: 0 });
  const spaceHeldRef = useRef(false);

  // --- Fit-to-screen calculation ---
  // Subtract padding so the fitted image is slightly smaller than the viewport,
  // leaving room for region action buttons (toolbar) to be visible even when
  // a region sits at the image edge.
  const FIT_PADDING = 80; // px — enough for toolbar buttons (24px) + gap (12px)
  const calculateFitZoom = useCallback(() => {
    if (!viewportRef.current || !image.originalWidth) return 1;
    const vw = viewportRef.current.clientWidth - FIT_PADDING;
    const vh = viewportRef.current.clientHeight - FIT_PADDING;
    if (vw <= 0 || vh <= 0) return 1;
    // fit zoom: scale image to fit within viewport (minus padding), but never exceed 1
    return Math.min(vw / image.originalWidth, vh / image.originalHeight, 1);
  }, [image.originalWidth, image.originalHeight]);

  // Initialize: fit to screen and center
  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const fit = calculateFitZoom();
        setZoom(fit);
        setPanX(0);
        setPanY(0);
        userZoomedRef.current = false;
        setIsZoomReady(true);
      });
    });
  }, [calculateFitZoom]);

  // ResizeObserver: track viewport size, only reset zoom on genuine resize when user hasn't manually zoomed
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      const w = viewport.clientWidth;
      const h = viewport.clientHeight;
      setVpW(w);
      setVpH(h);
      if (!userZoomedRef.current) {
        const fit = calculateFitZoom();
        setZoom(fit);
        setPanX(0);
        setPanY(0);
      }
      // If user has manually zoomed, we respect their zoom/pan. They can click "fit" to reset.
    });
    // Record initial size
    setVpW(viewport.clientWidth);
    setVpH(viewport.clientHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [calculateFitZoom]);

  // --- Zoom handlers ---
  const handleZoomIn = useCallback(() => {
    userZoomedRef.current = true;
    setZoom(z => Math.min(z * 1.25, 10));
  }, []);

  const handleZoomOut = useCallback(() => {
    userZoomedRef.current = true;
    setZoom(z => Math.max(z / 1.25, 0.1));
  }, []);

  const handleZoomReset = useCallback(() => {
    userZoomedRef.current = false;
    const fit = calculateFitZoom();
    setZoom(fit);
    setPanX(0);
    setPanY(0);
  }, [calculateFitZoom]);

  // --- Ctrl+Wheel zoom (zoom towards cursor) ---
  // In the editor workflow the same gesture over the SELECTED box steps its
  // font size instead (see onStepSelectedFontSize); everywhere else it zooms.
  // Shift+wheel over the selected box steps its text rotation (±5°, Alt = ±1°).
  /** Fractional wheel delta accumulated for font-size stepping. */
  const fontSizeWheelAccumRef = useRef(0);
  /** Same accumulator for rotation stepping. */
  const rotationWheelAccumRef = useRef(0);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || restoreMode) return;

    /** Region id under a screen point, via the DOM (data-region-id is set on
     *  every box) — immune to stale zoom/pan values in this closure. */
    const regionIdAt = (clientX: number, clientY: number): string | null => {
      const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      return el?.closest('[data-region-id]')?.getAttribute('data-region-id') ?? null;
    };

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        // Font-size stepping: ONE mouse notch = ONE ±5 step. Trackpads fire
        // dozens of small-delta events per gesture, so deltas are normalised to
        // pixels and accumulated; a step is emitted once a notch worth has
        // built up. Chrome sends ~100px per notch, Firefox ~3 lines
        // (deltaMode 1) — 34px/line makes both land on the same threshold.
        if (onStepSelectedFontSize && selectedRegionId && regionIdAt(e.clientX, e.clientY) === selectedRegionId) {
          e.preventDefault();
          e.stopPropagation();
          const unit = e.deltaMode === 1 ? 34 : e.deltaMode === 2 ? 100 : 1;
          fontSizeWheelAccumRef.current += e.deltaY * unit;
          const STEP_UNITS = 100;
          const STEP_PX = 5;
          while (Math.abs(fontSizeWheelAccumRef.current) >= STEP_UNITS) {
            const up = fontSizeWheelAccumRef.current < 0; // wheel up = bigger
            fontSizeWheelAccumRef.current -= up ? -STEP_UNITS : STEP_UNITS;
            onStepSelectedFontSize(up ? STEP_PX : -STEP_PX);
          }
          return;
        }

        e.preventDefault();
        e.stopPropagation();

        const delta = -e.deltaY;
        const factor = delta > 0 ? 1.1 : 1 / 1.1;

        // Mouse position relative to viewport
        const rect = viewport.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // We need to compute the adjustment so the image point under the cursor stays fixed.
        // Use functional updates to get the latest state.
        setZoom(prevZoom => {
          const newZoom = Math.max(0.1, Math.min(10, prevZoom * factor));

          // The offset of the image's top-left corner from the viewport's top-left:
          //   offsetX = (vpW - imgW * zoom) / 2 + panX
          //   offsetY = (vpH - imgH * zoom) / 2 + panY
          // The image point under cursor: (mouseX - offsetX) / zoom  (in image pixels)
          // After zoom change, we want same image point under cursor:
          //   mouseX = newOffsetX + imgPointX * newZoom
          //   newOffsetX = mouseX - imgPointX * newZoom
          //             = mouseX - (mouseX - offsetX) / prevZoom * newZoom
          //   newPanX = newOffsetX - (vpW - imgW * newZoom) / 2

          const imgW = image.originalWidth || 800;
          const imgH = image.originalHeight || 600;

          // We need current panX/panY — read from refs to avoid stale closure
          // But since setZoom and setPanX are batched, we can use a ref for pan.
          // Actually, let's use the zoom effect handler with a layout effect instead.
          // Simpler: store the mouse position and adjust pan in a layout effect.

          // Store info for the layout effect to adjust pan:
          wheelAdjustRef.current = {
            mouseX, mouseY, prevZoom, newZoom, imgW, imgH, vpW: rect.width, vpH: rect.height
          };

          return newZoom;
        });

        userZoomedRef.current = true;
      } else if (e.shiftKey && onStepSelectedRotation && selectedRegionId && regionIdAt(e.clientX, e.clientY) === selectedRegionId) {
        // Shift+wheel 悬停选中框 = 旋转 ±5°（Alt 加持 = ±1° 微调）。与字号
        // 同一套"一档滚轮 = 一步"的累积逻辑；滚轮向上 = 角度增大（与"上=大"一致）。
        // 不在选中框上时保持默认（viewport overflow:hidden，本就不会滚动）。
        e.preventDefault();
        e.stopPropagation();
        const unit = e.deltaMode === 1 ? 34 : e.deltaMode === 2 ? 100 : 1;
        rotationWheelAccumRef.current += e.deltaY * unit;
        const STEP_UNITS = 100;
        const stepDeg = e.altKey ? 1 : 5;
        while (Math.abs(rotationWheelAccumRef.current) >= STEP_UNITS) {
          const up = rotationWheelAccumRef.current < 0;
          rotationWheelAccumRef.current -= up ? -STEP_UNITS : STEP_UNITS;
          onStepSelectedRotation(up ? stepDeg : -stepDeg);
        }
      }
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, [restoreMode, image.originalWidth, image.originalHeight, onStepSelectedFontSize, onStepSelectedRotation, selectedRegionId]);

  // Ref for wheel zoom adjustment data
  const wheelAdjustRef = useRef<{
    mouseX: number; mouseY: number; prevZoom: number; newZoom: number;
    imgW: number; imgH: number; vpW: number; vpH: number;
  } | null>(null);

  // After zoom changes (from wheel), adjust pan to keep cursor point fixed
  useLayoutEffect(() => {
    const adj = wheelAdjustRef.current;
    if (!adj) return;
    wheelAdjustRef.current = null;

    const { mouseX, mouseY, prevZoom, newZoom, imgW, imgH, vpW, vpH } = adj;

    setPanX(prevPanX => {
      const oldOffsetX = (vpW - imgW * prevZoom) / 2 + prevPanX;
      const newOffsetX = mouseX - (mouseX - oldOffsetX) * (newZoom / prevZoom);
      return newOffsetX - (vpW - imgW * newZoom) / 2;
    });
    setPanY(prevPanY => {
      const oldOffsetY = (vpH - imgH * prevZoom) / 2 + prevPanY;
      const newOffsetY = mouseY - (mouseY - oldOffsetY) * (newZoom / prevZoom);
      return newOffsetY - (vpH - imgH * newZoom) / 2;
    });
  }, [zoom]);

  // --- Pan: middle-mouse, Alt+Left, Space+Left ---
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 1 || (e.button === 0 && e.altKey) || (e.button === 0 && spaceHeldRef.current)) {
        e.preventDefault();
        // Use currentPanRef to get latest pan values (avoids stale closure)
        panStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, panX: currentPanRef.current.x, panY: currentPanRef.current.y };
        isPanningRef.current = true;
        viewport.style.cursor = 'grabbing';
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isPanningRef.current) return;
      const dx = e.clientX - panStartRef.current.mouseX;
      const dy = e.clientY - panStartRef.current.mouseY;
      setPanX(panStartRef.current.panX + dx);
      setPanY(panStartRef.current.panY + dy);
    };

    const handleMouseUp = () => {
      if (isPanningRef.current) {
        isPanningRef.current = false;
        viewport.style.cursor = spaceHeldRef.current ? 'grab' : '';
      }
    };

    viewport.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      viewport.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Ref to keep current pan values in sync for the pan mousedown handler
  const currentPanRef = useRef({ x: 0, y: 0 });
  currentPanRef.current = { x: panX, y: panY };

  // --- Space key for pan mode ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        // Don't capture space if user is in an input
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        e.preventDefault();
        spaceHeldRef.current = true;
        if (viewportRef.current) viewportRef.current.style.cursor = 'grab';
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeldRef.current = false;
        if (viewportRef.current && !isPanningRef.current) viewportRef.current.style.cursor = '';
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // --- Interaction hook ---
  const {
      interaction,
      handleBackgroundMouseDown,
      handleRegionMouseDown,
      handleResizeMouseDown
  } = useCanvasInteraction(
      containerRef,
      image,
      onUpdateRegions,
      onSelectRegion,
      onInteractionStart,
      viewMode,
      disabled
  );

  // --- Restore mode state ---
  const [restoreBoxDrawing, setRestoreBoxDrawing] = useState(false);
  const [restoreBoxStart, setRestoreBoxStart] = useState<{ x: number; y: number } | null>(null);
  const [restoreBoxCurrent, setRestoreBoxCurrent] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  // Cache of composited URLs per region. Stored in a ref so reads in JSX
  // don't trigger React reconciliation, plus a counter to opt-in to re-render
  // when the cache actually changes.
  const restoreCompositedCacheRef = useRef<Record<string, string>>({});
  const [restoreCacheVersion, setRestoreCacheVersion] = useState(0);
  const [isInverseMode, setIsInverseMode] = useState(false);

  // --- Brush restore state ---
  const [isPainting, setIsPainting] = useState(false);
  const [maskReady, setMaskReady] = useState(false);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const brushOverlayRef = useRef<HTMLCanvasElement | null>(null);

  // Signature that captures only the fields we care about for the restore composite.
  // Identity of `image.regions` changes on every drag/prompt edit, but the signature
  // stays stable unless the restore-relevant data actually changes.
  const restoreSignature = useMemo(
    () => image.regions
      .filter(r => r.status === 'completed' && r.processedImageUrl)
      .map(r => `${r.id}|${r.processedImageUrl}|${r.restoreMaskUrl || ''}|${(r.restoreBoxes || []).length}`)
      .join('||'),
    [image.regions]
  );

  // Update composited cache when restore boxes or mask actually change.
  useEffect(() => {
    let cancelled = false;
    const updateCache = async () => {
      const oldCache = restoreCompositedCacheRef.current;
      const newCache: Record<string, string> = {};
      for (const region of image.regions) {
        if (region.status === 'completed' && region.processedImageUrl) {
          const hasRestore = (region.restoreBoxes && region.restoreBoxes.length > 0) || !!region.restoreMaskUrl;
          if (hasRestore) {
            try {
              newCache[region.id] = await renderRegionWithRestore(
                region.processedImageUrl,
                region.restoreBoxes,
                region.restoreMaskUrl
              );
            } catch (e) {
              console.error('Failed to render restore for region', region.id, e);
            }
          }
        }
      }
      if (cancelled) {
        // Component unmounted or signature changed again — release what we just built.
        Object.values(newCache).forEach(releaseObjectURL);
        return;
      }
      // Swap atomically and release the previous generation.
      restoreCompositedCacheRef.current = newCache;
      Object.values(oldCache).forEach(releaseObjectURL);
      setRestoreCacheVersion(v => v + 1);
    };
    updateCache();
    return () => { cancelled = true; };
  }, [restoreSignature]);

  // Final unmount: release any URLs still held in the cache ref.
  useEffect(() => {
    return () => {
      Object.values(restoreCompositedCacheRef.current).forEach(releaseObjectURL);
      restoreCompositedCacheRef.current = {};
    };
  }, []);

  // Initialize brush mask canvas when entering brush mode on a selected region
  useEffect(() => {
    if (!restoreBrushMode || !restoreSelectedRegionId) {
      maskCanvasRef.current = null;
      setMaskReady(false);
      return;
    }
    const region = image.regions.find(r => r.id === restoreSelectedRegionId);
    if (!region || !region.processedImageUrl) return;

    const initMask = async () => {
      const img = await loadImage(region.processedImageUrl!);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = w;
      maskCanvas.height = h;
      const mctx = maskCanvas.getContext('2d');
      if (!mctx) return;
      if (region.restoreMaskUrl) {
        const maskImg = await loadImage(region.restoreMaskUrl);
        mctx.drawImage(maskImg, 0, 0);
      } else {
        mctx.fillStyle = 'white';
        mctx.fillRect(0, 0, w, h);
      }
      maskCanvasRef.current = maskCanvas;
      setMaskReady(true);
    };
    setMaskReady(false);
    initMask();
  }, [restoreBrushMode, restoreSelectedRegionId, image.regions]);

  // Sync brush overlay with mask when mask is ready
  useEffect(() => {
    if (!restoreBrushMode || !brushOverlayRef.current || !maskCanvasRef.current || !maskReady) return;
    const overlay = brushOverlayRef.current;
    const mask = maskCanvasRef.current;
    overlay.width = mask.width;
    overlay.height = mask.height;
    const octx = overlay.getContext('2d');
    if (octx) {
      octx.drawImage(mask, 0, 0);
      octx.globalCompositeOperation = 'source-atop';
      octx.fillStyle = 'rgba(255, 0, 0, 0.25)';
      octx.fillRect(0, 0, overlay.width, overlay.height);
    }
  }, [restoreBrushMode, maskReady]);

  // --- Coordinate helpers ---
  // Since containerRef has transform applied, getBoundingClientRect returns the visual (scaled) rect.
  // This means (clientX - rect.left) / rect.width * 100 gives correct percentage regardless of zoom.
  const getRelativeCoords = useCallback((clientX: number, clientY: number) => {
    if (!containerRef.current) return { x: 0, y: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    return { x, y };
  }, []);

  const getRegionRelativeCoords = useCallback((clientX: number, clientY: number, region: Region) => {
    const container = getRelativeCoords(clientX, clientY);
    const rx = ((container.x - region.x) / region.width) * 100;
    const ry = ((container.y - region.y) / region.height) * 100;
    return { x: Math.max(0, Math.min(100, rx)), y: Math.max(0, Math.min(100, ry)) };
  }, [getRelativeCoords]);

  // --- 拖线测角（两点测角）：沿原文斜字拖一条线，线的角度 = rotation ---
  const imgW = image.originalWidth || 800;
  const imgH = image.originalHeight || 600;

  /** 进行中的拖线（图像像素坐标；null = 还没按下）。 */
  const [angleDrag, setAngleDrag] = useState<{ ax: number; ay: number; bx: number; by: number } | null>(null);

  const toImagePx = useCallback((clientX: number, clientY: number) => {
    // getRelativeCoords 走 getBoundingClientRect，缩放免疫；角度必须在
    // 图像像素空间算（% 空间 x/y 不同刻度，atan2 会歪）。
    const c = getRelativeCoords(clientX, clientY);
    return { x: (c.x / 100) * imgW, y: (c.y / 100) * imgH };
  }, [getRelativeCoords, imgW, imgH]);

  const handleAngleMeasureMouseDown = (e: React.MouseEvent) => {
    if (!angleMeasureMode) return;
    // Alt / Space 按住 = 平移画布，让位给 viewport 层的 pan。
    if (e.button !== 0 || e.altKey || spaceHeldRef.current) return;
    e.preventDefault();
    const p = toImagePx(e.clientX, e.clientY);
    setAngleDrag({ ax: p.x, ay: p.y, bx: p.x, by: p.y });
  };

  // 测角提交对象（选中框）实际采用的排版方向：显式 isVertical 优先，否则按
  // textLayout.resolveStyle 的自动规则（全局默认竖排，或框高 > 框宽 × 1.5）。
  // 竖排时拖线沿的是列方向（≈90°），rotation 要减 90°（见 measureLineAngle）。
  const measureRegion = angleMeasureMode
    ? image.regions.find(r => r.id === selectedRegionId)
    : undefined;
  const measureVertical = !!measureRegion && (
    measureRegion.editorStyle?.isVertical ??
    (preferVerticalDefault || ((measureRegion.height / 100) * imgH) > ((measureRegion.width / 100) * imgW) * 1.5)
  );

  // 拖动 / 松手走 window 监听（指针可能甩出画布）—— 与 restore 框拉拽同一模式。
  useEffect(() => {
    if (!angleMeasureMode || !angleDrag) return;
    const handleMove = (e: MouseEvent) => {
      const p = toImagePx(e.clientX, e.clientY);
      setAngleDrag(d => (d ? { ...d, bx: p.x, by: p.y } : d));
    };
    const handleUp = (e: MouseEvent) => {
      const p = toImagePx(e.clientX, e.clientY);
      // 太短 = 误点：不提交、保持 armed（用户在原位置重拖即可）。
      if (Math.hypot(p.x - angleDrag.ax, p.y - angleDrag.ay) * zoom >= 6) {
        onAngleMeasureComplete?.(measureLineAngle(angleDrag.ax, angleDrag.ay, p.x, p.y, measureVertical));
      }
      setAngleDrag(null);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [angleMeasureMode, angleDrag, toImagePx, zoom, onAngleMeasureComplete, measureVertical]);

  // Esc 取消测角（输入框里的 Esc 不抢）。
  useEffect(() => {
    if (!angleMeasureMode) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      onAngleMeasureCancel?.();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [angleMeasureMode, onAngleMeasureCancel]);

  // 解除 armed 时清掉半截拖拽（Esc、切视图、换图等外部路径都会走这里）。
  useEffect(() => { if (!angleMeasureMode) setAngleDrag(null); }, [angleMeasureMode]);

  // --- Region actions ---
  const removeRegion = (regionId: string) => {
    if (disabled) return;
    onUpdateRegions(
      image.id,
      image.regions.filter((r) => r.id !== regionId)
    );
    if (selectedRegionId === regionId) onSelectRegion(null);
  };

  const resetRegion = (regionId: string) => {
    if (disabled) return;
    const newRegions = image.regions.map((r) => {
      if (r.id === regionId) {
        return { ...r, status: 'pending', processedImageUrl: undefined, restoreBoxes: undefined } as Region;
      }
      return r;
    });
    onUpdateRegions(image.id, newRegions);
  };

  // --- Restore box mouse handlers ---
  const handleRestoreContainerMouseDown = (e: React.MouseEvent) => {
    if (!restoreMode || !onUpdateRestoreBoxes) return;
    if (e.button !== 0) return;

    const target = e.target as HTMLElement;
    if (target.closest('[data-restore-handle]')) return;

    if (!target.closest('[data-region-id]')) {
      onSelectRestoreRegion?.(null);
      return;
    }
  };

  const handleRestoreRegionClick = (e: React.MouseEvent, region: Region) => {
    if (!restoreMode || !onUpdateRestoreBoxes) return;
    if (region.status !== 'completed') return;
    e.stopPropagation();
    onSelectRestoreRegion?.(region.id === restoreSelectedRegionId ? null : region.id);
  };

  const handleRestoreBoxMouseDown = (e: React.MouseEvent, region: Region) => {
    if (!restoreMode || !onUpdateRestoreBoxes || region.id !== restoreSelectedRegionId) return;
    if (e.button !== 0) return;
    e.stopPropagation();

    const coords = getRegionRelativeCoords(e.clientX, e.clientY, region);
    setRestoreBoxDrawing(true);
    setRestoreBoxStart(coords);
    setRestoreBoxCurrent({ x: coords.x, y: coords.y, width: 0, height: 0 });
  };

  // --- Brush painting callbacks ---
  const saveBrushMask = useCallback(async () => {
    if (!maskCanvasRef.current || !restoreSelectedRegionId || !onUpdateRestoreMask) return;
    const url = await canvasToObjectURL(maskCanvasRef.current);
    onUpdateRestoreMask(restoreSelectedRegionId, url);
  }, [restoreSelectedRegionId, onUpdateRestoreMask]);

  const handleClearBrushMask = useCallback(() => {
    if (!restoreSelectedRegionId || !onUpdateRestoreMask) return;
    onUpdateRestoreMask(restoreSelectedRegionId, null);
    maskCanvasRef.current = null;
    setMaskReady(false);
  }, [restoreSelectedRegionId, onUpdateRestoreMask]);

  // Window-level mouse handlers for restore box drawing
  useEffect(() => {
    if (!restoreMode || !onUpdateRestoreBoxes) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      if (!restoreBoxDrawing || !restoreBoxStart || !restoreSelectedRegionId) return;
      const region = image.regions.find(r => r.id === restoreSelectedRegionId);
      if (!region) return;

      const coords = getRegionRelativeCoords(e.clientX, e.clientY, region);
      const x = Math.min(restoreBoxStart.x, coords.x);
      const y = Math.min(restoreBoxStart.y, coords.y);
      const width = Math.abs(coords.x - restoreBoxStart.x);
      const height = Math.abs(coords.y - restoreBoxStart.y);

      setRestoreBoxCurrent({ x, y, width, height });
    };

    const handleWindowMouseUp = () => {
      if (!restoreBoxDrawing || !restoreBoxStart || !restoreBoxCurrent || !restoreSelectedRegionId) {
        setRestoreBoxDrawing(false);
        setRestoreBoxStart(null);
        setRestoreBoxCurrent(null);
        return;
      }

      const { width, height } = restoreBoxCurrent;
      if (width > 0.5 && height > 0.5) {
        const region = image.regions.find(r => r.id === restoreSelectedRegionId);
        if (region && onUpdateRestoreBoxes) {
          const newBox: RestoreBox = {
            id: crypto.randomUUID(),
            x: restoreBoxCurrent.x,
            y: restoreBoxCurrent.y,
            width: restoreBoxCurrent.width,
            height: restoreBoxCurrent.height,
            inverse: isInverseMode,
          };
          onUpdateRestoreBoxes(restoreSelectedRegionId, [...(region.restoreBoxes || []), newBox]);
        }
      }

      setRestoreBoxDrawing(false);
      setRestoreBoxStart(null);
      setRestoreBoxCurrent(null);
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [restoreMode, restoreBoxDrawing, restoreBoxStart, restoreBoxCurrent, restoreSelectedRegionId, image.regions, onUpdateRestoreBoxes, getRegionRelativeCoords, isInverseMode]);

  // Window-level mouse handlers for brush painting
  useEffect(() => {
    if (!restoreMode || !restoreBrushMode) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      if (!isPainting || !brushOverlayRef.current || !maskCanvasRef.current || !restoreSelectedRegionId) return;
      const overlay = brushOverlayRef.current;
      const mask = maskCanvasRef.current;
      const mctx = mask.getContext('2d');
      if (!mctx) return;

      const rect = overlay.getBoundingClientRect();
      const scaleX = mask.width / Math.max(1, rect.width);
      const scaleY = mask.height / Math.max(1, rect.height);
      const mx = (e.clientX - rect.left) * scaleX;
      const my = (e.clientY - rect.top) * scaleY;

      const region = image.regions.find(r => r.id === restoreSelectedRegionId);
      const brushRadius = region ? (restoreBrushSize / 100) * Math.max(mask.width, mask.height) : 10;

      mctx.globalCompositeOperation = 'destination-out';
      mctx.beginPath();
      mctx.arc(mx, my, brushRadius, 0, Math.PI * 2);
      mctx.fill();

      const octx = overlay.getContext('2d');
      if (octx) {
        octx.clearRect(0, 0, overlay.width, overlay.height);
        octx.drawImage(mask, 0, 0);
        octx.globalCompositeOperation = 'source-atop';
        octx.fillStyle = 'rgba(255, 0, 0, 0.25)';
        octx.fillRect(0, 0, overlay.width, overlay.height);
        octx.globalCompositeOperation = 'source-over';
        octx.beginPath();
        octx.arc(mx, my, brushRadius, 0, Math.PI * 2);
        octx.strokeStyle = 'rgba(255,255,255,0.8)';
        octx.lineWidth = 2;
        octx.stroke();
      }
    };

    const handleWindowMouseUp = () => {
      if (isPainting) {
        setIsPainting(false);
        if (maskCanvasRef.current && restoreSelectedRegionId && onUpdateRestoreMask) {
          canvasToObjectURL(maskCanvasRef.current)
            .then(url => onUpdateRestoreMask(restoreSelectedRegionId, url))
            .catch(e => console.error('Failed to persist brush mask', e));
        }
      }
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [restoreMode, restoreBrushMode, isPainting, restoreSelectedRegionId, image.regions, restoreBrushSize, onUpdateRestoreMask]);

  const handleClearRestoreBoxes = () => {
    if (!restoreSelectedRegionId || !onUpdateRestoreBoxes) return;
    onUpdateRestoreBoxes(restoreSelectedRegionId, []);
    onSelectRestoreRegion?.(null);
  };

  const handleDeleteRestoreBox = (regionId: string, boxId: string) => {
    if (!onUpdateRestoreBoxes) return;
    const region = image.regions.find(r => r.id === regionId);
    if (!region) return;
    onUpdateRestoreBoxes(regionId, (region.restoreBoxes || []).filter(b => b.id !== boxId));
  };

  const isEditMode = viewMode === 'edit';
  // 工作页（编辑 / 重绘 / 修补）= 结果页的贴图叠加 + 框交互（选中/移动/缩放/画框），
  // 所以能一边改一边看框内的实时结果。准备页与已完成页是纯查看页：不画框。
  const isWorkTab = isWorkView(viewMode);
  const boxesInteractive = isWorkTab;
  const showPatchOverlays = isWorkTab || viewMode === 'result';
  const isRestoreActive = restoreMode && viewMode === 'result';
  /** 框只在工作页出现；已完成页只有开启「框选还原」时才临时把框放出来。 */
  const showRegionBoxes = isWorkTab || isRestoreActive;

  // Which region boxes are drawn at all. Editor workflow: text regions
  // (bubble outlines stay hidden visual context). Generation workflows:
  // only paintable regions (text boxes + manual).
  const isRegionVisible = (region: Region): boolean =>
    regionDisplay === 'editor'
      ? !region.contextOnly
      : isRegionPaintable(region);

  // Zoom compensation: inverse scale factor so overlay UI elements maintain
  // consistent screen-pixel size regardless of zoom level.
  const invZoom = 1 / zoom;

  // Build the combined transform: center the image, then apply pan offset
  // The content div is sized to the image's native dimensions.
  // transform: translate centers the image in the viewport, then panX/panY offset it.
  // The order matters: translate first (centering), then scale (zoom).
  // CSS transform applies right-to-left, so we write scale first then translate.
  // But we want: final_pos = center_offset + pan + scale * local_pos
  // So: transform: translate(centerX + panX, centerY + panY) scale(zoom)
  // Actually the easiest is to compute the top-left corner position:
  //   left = (viewportW - imgW * zoom) / 2 + panX
  //   top  = (viewportH - imgH * zoom) / 2 + panY
  // Then: transform: translate(left, top) scale(zoom)
  // But we need transformOrigin: '0 0' so scale applies from top-left.

  return (
    <div className="relative w-full h-full flex flex-col select-none">
      {/* Viewport: overflow hidden, no scrollbars. All pan/zoom via transform. */}
      <div
        ref={viewportRef}
        className="flex-1 overflow-hidden relative"
        style={{ cursor: spaceHeldRef.current ? 'grab' : undefined }}
      >
        {/* Content container: sized to original image dimensions, positioned via transform */}
        <div
          ref={containerRef}
          className={`absolute shadow-xl ${boxesInteractive && !restoreMode ? '' : 'cursor-default'}`}
          onMouseDown={
            isRestoreActive ? handleRestoreContainerMouseDown
            : angleMeasureMode ? handleAngleMeasureMouseDown
            : (e) => {
              // Block left-click background interaction when panning with space or alt
              if (e.button === 0 && (e.altKey || spaceHeldRef.current)) return;
              handleBackgroundMouseDown(e);
            }
          }
          style={{
            width: imgW,
            height: imgH,
            transformOrigin: '0 0',
            transform: `translate(${(vpW - imgW * zoom) / 2 + panX}px, ${(vpH - imgH * zoom) / 2 + panY}px) scale(${zoom})`,
            cursor: isRestoreActive || angleMeasureMode ? 'crosshair' : (boxesInteractive && interaction.type === 'drawing' ? 'crosshair' : 'default'),
            visibility: isZoomReady ? 'visible' : 'hidden',
          }}
        >
          {/* Base Image */}
          <img
            src={image.previewUrl}
            alt="Workarea"
            className="block pointer-events-none select-none rounded bg-skin-surface ring-1 ring-skin-border"
            style={{ width: '100%', height: '100%', display: 'block', objectFit: 'fill' }}
            draggable={false}
          />

          {/* RESULT/EDIT MODE: Processed image overlays. Result shows only
              finalized (completed) patches; edit additionally shows editor
              intermediate patches (erase/brush-only, still pending).
              Z-order: AI patches first, editor-composited patches last so
              typeset text always sits on top of the AI-redrawn base. */}
          {showPatchOverlays && image.regions.filter(r =>
            r.status === 'completed' && r.processedImageUrl ||
            (isWorkTab && r.editorComposited && r.processedImageUrl)
          ).sort((a, b) =>
            Number(a.editorComposited ?? false) - Number(b.editorComposited ?? false)
          ).map((region) => {
            const ax = region.anchorX ?? region.x;
            const ay = region.anchorY ?? region.y;
            const aw = region.anchorWidth ?? region.width;
            const ah = region.anchorHeight ?? region.height;
            // Editor patches may carry an overflow margin (text spilling out
            // of the box) — the patch box is the anchor enlarged by it. The
            // visible window is the patch cropped per side (shared with
            // stitchImage, see resolvePatchWindowInsets):
            //   - sides the user SHRANK past the anchor box are cropped, so
            //     narrowing the frame reveals the untouched original underneath
            //     instead of leaving the (larger) patch covering it;
            //   - the other sides keep the overflow spill so typeset overflow
            //     stays visible while adjusting the font size — but only in the
            //     EDITOR workflow (AI 重绘 / 手动修补工坊 drop the margin).
            // Insets are percent-of-image, so they convert to the element's own
            // box by dividing by ew / eh.
            const mx = region.patchMarginX ?? 0;
            const my = region.patchMarginY ?? 0;
            const ex = ax - mx;
            const ey = ay - my;
            const ew = aw + 2 * mx;
            const eh = ah + 2 * my;
            const insets = resolvePatchWindowInsets(
              { x: ex, y: ey, w: ew, h: eh },
              { x: ax, y: ay, w: aw, h: ah },
              { x: region.x, y: region.y, w: region.width, h: region.height },
              allowPatchOverflow
            );
            const clipped = insets.left > 0 || insets.top > 0 || insets.right > 0 || insets.bottom > 0;
            const hasRestore = (region.restoreBoxes && region.restoreBoxes.length > 0) || region.restoreMaskUrl;
            return (
              <img
                key={`overlay-${region.id}`}
                src={hasRestore ? (restoreCompositedCacheRef.current[region.id] || region.processedImageUrl) : region.processedImageUrl}
                className="absolute pointer-events-none select-none"
                style={{
                  left: `${ex}%`,
                  top: `${ey}%`,
                  width: `${ew}%`,
                  height: `${eh}%`,
                  objectFit: 'contain',
                  objectPosition: 'center center',
                  zIndex: 5,
                  ...(clipped
                    ? {
                        clipPath: `inset(${(insets.top / eh) * 100}% ${(insets.right / ew) * 100}% ${(insets.bottom / eh) * 100}% ${(insets.left / ew) * 100}%)`,
                      }
                    : {}),
                }}
                alt=""
              />
            );
          })}

          {/* Regions — 只在工作页（编辑 / 重绘 / 修补）和「框选还原」时出现 */}
          {showRegionBoxes && image.regions.map((region) => {
            // Only the boxes relevant to this display context are drawn —
            // editor: text regions; generation: paintable classes per source.
            if (!isRegionVisible(region)) return null;
            const isSelected = selectedRegionId === region.id && boxesInteractive;
            const isEditable = boxesInteractive && !disabled && region.status !== 'processing';

            const isManipulating = (interaction.type === 'moving' || interaction.type === 'resizing') && interaction.regionId === region.id;

            const x = isManipulating && interaction.currentRect?.x !== undefined ? interaction.currentRect.x : region.x;
            const y = isManipulating && interaction.currentRect?.y !== undefined ? interaction.currentRect.y : region.y;
            const width = isManipulating && interaction.currentRect?.width !== undefined ? interaction.currentRect.width : region.width;
            const height = isManipulating && interaction.currentRect?.height !== undefined ? interaction.currentRect.height : region.height;

            let styleClasses = '';

            if (!boxesInteractive) {
                if (isRestoreActive) {
                    const isRestoreSelected = region.id === restoreSelectedRegionId;
                    styleClasses = isRestoreSelected
                      ? 'border-2 border-amber-400 bg-amber-400/10 shadow-[0_0_0_2px_rgba(251,191,36,0.5)] z-30 cursor-crosshair'
                      : 'border border-white/30 bg-transparent z-10 cursor-pointer hover:border-amber-400/50';
                } else {
                    styleClasses = 'z-10 border-0';
                }
            } else {
                if (region.status === 'processing') {
                    styleClasses = 'border-2 border-amber-500 bg-amber-500/10 animate-pulse z-20';
                } else if (region.status === 'failed') {
                    styleClasses = 'border-2 border-rose-500 bg-rose-500/10 z-10';
                } else if (region.status === 'completed') {
                     // Editor mode: colour the box by its derived display, so an
                     // AI「擦除」box reads blue (已擦除) and an AI「翻译」box reads
                     // violet (已冻结) instead of the generic green "completed".
                     const display = isEditMode ? editorRegionDisplay(region, defaultRedrawIntent) : 'completed';
                     styleClasses = display === 'frozen'
                       ? (isSelected
                           ? 'border-2 border-violet-500 bg-violet-500/20 shadow-[0_0_0_2px_rgba(255,255,255,0.8),0_0_0_4px_#8b5cf6] z-30 cursor-move'
                           : 'border-2 border-violet-500 bg-violet-500/10 z-10 cursor-pointer')
                       : display === 'erased'
                         ? (isSelected
                             ? 'border-2 border-sky-500 bg-sky-500/20 shadow-[0_0_0_2px_rgba(255,255,255,0.8),0_0_0_4px_#0ea5e9] z-30 cursor-move'
                             : 'border-2 border-sky-500 bg-sky-500/10 z-10 cursor-pointer')
                         : (isSelected
                             ? 'border-2 border-emerald-500 bg-emerald-500/20 shadow-[0_0_0_2px_rgba(255,255,255,0.8),0_0_0_4px_#10b981] z-30 cursor-move'
                             : 'border-2 border-emerald-500 bg-emerald-500/10 z-10 cursor-pointer');
                } else {
                    if (isSelected) {
                        styleClasses = 'border-2 border-skin-primary bg-skin-primary/10 shadow-[0_0_0_1px_rgba(255,255,255,0.5)] z-20 cursor-move';
                    } else {
                        styleClasses = 'border-2 border-skin-primary hover:border-skin-primary bg-skin-primary/5 z-10 cursor-pointer';
                    }
                }
            }

            // Compute the region's screen position to decide if action buttons
            // should be placed above or below the region. If the top of the
            // region is too close to the viewport top edge, buttons go below.
            const getToolbarPlacement = () => {
              if (!containerRef.current || !viewportRef.current) return 'above';
              const cRect = containerRef.current.getBoundingClientRect();
              const vRect = viewportRef.current.getBoundingClientRect();
              // Region top edge in screen coords
              const regionScreenTop = cRect.top + (y / 100) * cRect.height;
              const toolbarScreenHeight = 24; // button height (w-6 h-6)
              const margin = 2; // small extra margin for flipping decision
              if (regionScreenTop - vRect.top < toolbarScreenHeight + margin) {
                return 'below';
              }
              return 'above';
            };
            const toolbarPlacement = (isSelected && !isManipulating && !restoreMode)
              ? getToolbarPlacement()
              : 'above';
            const toolbarGap = 12 * invZoom; // fixed 12 screen-pixel gap between region and toolbar
            const cursorStyle = isRestoreActive ? (region.id === restoreSelectedRegionId ? 'crosshair' : 'pointer') : (isEditable ? (interaction.type === 'moving' ? 'grabbing' : 'move') : 'default');
            const handleBaseStyle = "absolute bg-white border border-skin-primary rounded-full z-30 transition-transform shadow-sm hover:shadow-lg hover:border-skin-primary/80";
            const handleSize = 14;
            // Resize handles: positioned at percentage points on the region,
            // then centered with translate(-50%,-50%) and zoom-compensated with scale(1/zoom).
            // transformOrigin must be center so the position doesn't shift.
            const handleStyle = (left: string, top: string) => ({
              left, top,
              width: handleSize,
              height: handleSize,
              transform: `translate(-50%, -50%) scale(${invZoom})`,
              transformOrigin: 'center',
            });

            // Status badge placement. The badge must never cover the text it sits
            // over, so it hangs OUTSIDE the box and only drops into the corner when
            // the box all but fills the image — same strategy (above → below →
            // right → left) as the numbered badges drawn by buildAnnotatedImage
            // (services/editorTranslate.ts) for editor whole-page translation.
            const badgePlacement = (() => {
              const rx = (x / 100) * imgW;
              const ry = (y / 100) * imgH;
              const rw = (width / 100) * imgW;
              const rh = (height / 100) * imgH;
              // The badge keeps a constant SCREEN size (scale(invZoom)); measured
              // in the image's own pixel space it therefore shrinks by invZoom.
              // Over-estimated on purpose so a tight box still prefers the outside.
              const bw = 40 * invZoom;
              const bh = 16 * invZoom;
              if (ry - bh >= 0) return 'above' as const;
              if (ry + rh + bh <= imgH) return 'below' as const;
              if (rx + rw + bw <= imgW) return 'right' as const;
              if (rx - bw >= 0) return 'left' as const;
              return 'inside' as const;
            })();
            const badgeGap = 2 * invZoom;
            const badgeStyle = (): React.CSSProperties => {
              switch (badgePlacement) {
                case 'above':
                  return { bottom: `calc(100% + ${badgeGap}px)`, left: 0, transform: `scale(${invZoom})`, transformOrigin: 'bottom left' };
                case 'below':
                  return { top: `calc(100% + ${badgeGap}px)`, left: 0, transform: `scale(${invZoom})`, transformOrigin: 'top left' };
                case 'right':
                  return { left: `calc(100% + ${badgeGap}px)`, top: 0, transform: `scale(${invZoom})`, transformOrigin: 'top left' };
                case 'left':
                  return { right: `calc(100% + ${badgeGap}px)`, top: 0, transform: `scale(${invZoom})`, transformOrigin: 'top right' };
                default:
                  return { top: badgeGap, left: badgeGap, transform: `scale(${invZoom})`, transformOrigin: 'top left' };
              }
            };

            return (
              <div
                key={region.id}
                ref={isSelected ? selectedRegionRef : null}
                data-region-id={region.id}
                onMouseDown={(e) => {
                  if (isRestoreActive) {
                    if (region.status === 'completed') {
                      handleRestoreRegionClick(e, region);
                    }
                  } else {
                    // Block region interaction when panning with space or alt
                    if (e.button === 0 && (e.altKey || spaceHeldRef.current)) return;
                    handleRegionMouseDown(e, region);
                  }
                }}
                className={`absolute transition-all duration-75 group ${styleClasses}`}
                style={{
                  left: `${x}%`,
                  top: `${y}%`,
                  width: `${width}%`,
                  height: `${height}%`,
                  transition: isManipulating ? 'none' : undefined,
                  cursor: boxesInteractive || isRestoreActive ? cursorStyle : 'default',
                  overflow: (isRestoreActive || !boxesInteractive) ? 'hidden' : 'visible',
                  // 测角模式：框仍可见，但拖拽/缩放/选中全部让位给拖线（mousedown
                  // 穿透到容器，由测角手势接管；提交对象在 armed 时就已锁定）。
                  pointerEvents: angleMeasureMode ? 'none' : undefined,
                }}
              >
                {/* RESTORE MODE: Overlay on selected region */}
                {isRestoreActive && region.id === restoreSelectedRegionId && (
                  <div className="absolute inset-0 z-40">
                    {restoreBrushMode ? (
                      <div className="absolute inset-0 cursor-crosshair"
                        onMouseDown={(e) => { e.stopPropagation(); setIsPainting(true); }}
                      >
                        <canvas ref={(c) => { brushOverlayRef.current = c; }} className="w-full h-full pointer-events-none absolute inset-0" />
                      </div>
                    ) : (
                      <div className="absolute inset-0 cursor-crosshair" onMouseDown={(e) => handleRestoreBoxMouseDown(e, region)}>
                        {(region.restoreBoxes || []).map(box => (
                          <div key={box.id} className={`absolute border-2 pointer-events-none ${box.inverse ? 'border-blue-400 bg-blue-400/10' : 'border-rose-400 bg-rose-400/10'}`}
                            style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.width}%`, height: `${box.height}%` }}>
                            <button data-restore-handle
                              className="absolute bg-rose-500 text-white rounded-full flex items-center justify-center text-[8px] leading-none pointer-events-auto hover:bg-rose-600 z-50"
                              style={{
                                top: -8 * invZoom,
                                right: -8 * invZoom,
                                width: 16 * invZoom,
                                height: 16 * invZoom,
                                transform: `scale(${invZoom})`,
                                transformOrigin: 'top right',
                              }}
                              onClick={(e) => { e.stopPropagation(); handleDeleteRestoreBox(region.id, box.id); }}
                            >✕</button>
                            <button data-restore-handle
                              className={`absolute rounded-full flex items-center justify-center text-[8px] leading-none pointer-events-auto z-50 ${box.inverse ? 'bg-blue-500 text-white hover:bg-blue-600' : 'bg-rose-500 text-white hover:bg-rose-600'}`}
                              style={{
                                bottom: -8 * invZoom,
                                right: -8 * invZoom,
                                width: 16 * invZoom,
                                height: 16 * invZoom,
                                transform: `scale(${invZoom})`,
                                transformOrigin: 'bottom right',
                              }}
                              onClick={(e) => { e.stopPropagation(); if (!onUpdateRestoreBoxes) return; const updated = (region.restoreBoxes || []).map(b => b.id === box.id ? { ...b, inverse: !b.inverse } : b); onUpdateRestoreBoxes(region.id, updated); }}
                            >{box.inverse ? '⊡' : '⊞'}</button>
                          </div>
                        ))}
                        {restoreBoxDrawing && restoreBoxCurrent && restoreBoxCurrent.width > 0 && restoreBoxCurrent.height > 0 && (
                          <div className={`absolute border-2 border-dashed pointer-events-none ${isInverseMode ? 'border-blue-400 bg-blue-400/10' : 'border-rose-400 bg-rose-400/10'}`}
                            style={{ left: `${restoreBoxCurrent.x}%`, top: `${restoreBoxCurrent.y}%`, width: `${restoreBoxCurrent.width}%`, height: `${restoreBoxCurrent.height}%` }} />
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* RESTORE MODE: Restore box indicators on non-selected regions */}
                {isRestoreActive && region.id !== restoreSelectedRegionId && region.status === 'completed' && region.restoreBoxes && region.restoreBoxes.length > 0 && (
                  <>
                    {(region.restoreBoxes || []).map(box => (
                      <div
                        key={box.id}
                        className={`absolute border pointer-events-none ${box.inverse ? 'border-blue-400/50' : 'border-rose-400/50'}`}
                        style={{
                          left: `${box.x}%`,
                          top: `${box.y}%`,
                          width: `${box.width}%`,
                          height: `${box.height}%`,
                        }}
                      />
                    ))}
                  </>
                )}

                {/* ORIGINAL MODE: Resize Handles */}
                {isSelected && isEditable && !restoreMode && (
                  <>
                    <div className={`${handleBaseStyle} cursor-nw-resize`} style={handleStyle('0%', '0%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 'nw')} />
                    <div className={`${handleBaseStyle} cursor-ne-resize`} style={handleStyle('100%', '0%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 'ne')} />
                    <div className={`${handleBaseStyle} cursor-sw-resize`} style={handleStyle('0%', '100%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 'sw')} />
                    <div className={`${handleBaseStyle} cursor-se-resize`} style={handleStyle('100%', '100%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 'se')} />

                    <div className={`${handleBaseStyle} cursor-n-resize`} style={handleStyle('50%', '0%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 'n')} />
                    <div className={`${handleBaseStyle} cursor-s-resize`} style={handleStyle('50%', '100%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 's')} />
                    <div className={`${handleBaseStyle} cursor-w-resize`} style={handleStyle('0%', '50%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 'w')} />
                    <div className={`${handleBaseStyle} cursor-e-resize`} style={handleStyle('100%', '50%')} onMouseDown={(e) => handleResizeMouseDown(e, region, 'e')} />
                  </>
                )}

                {/* ORIGINAL MODE: Action Buttons */}
                {isSelected && !isManipulating && !restoreMode && (
                   <div
                      className="absolute left-1/2 flex gap-1 z-50"
                      style={toolbarPlacement === 'above' ? {
                        top: -toolbarGap,
                        transform: `translateX(-50%) scale(${invZoom})`,
                        transformOrigin: 'bottom center',
                      } : {
                        bottom: -toolbarGap,
                        transform: `translateX(-50%) scale(${invZoom})`,
                        transformOrigin: 'top center',
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                   >
                      {!disabled && (region.status === 'completed' || region.status === 'failed') && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              // The engine's reset also clears a bubble's
                              // contained text boxes — see onResetRegion.
                              if (onResetRegion) onResetRegion(region.id);
                              else resetRegion(region.id);
                            }}
                             className="w-6 h-6 bg-skin-surface text-skin-text border border-skin-border rounded-full flex items-center justify-center shadow-md hover:shadow-lg hover:bg-skin-fill transition-all"
                             title="Reset / Redo"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                          </button>
                      )}
                      {!disabled && region.status !== 'processing' && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              removeRegion(region.id);
                            }}
                             className="w-6 h-6 bg-skin-surface text-rose-500 border border-skin-border rounded-full flex items-center justify-center shadow-md hover:shadow-lg hover:bg-rose-50 transition-all"
                             title="Delete Region"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                          </button>
                      )}
                   </div>
                )}

                {/* Status badge. Editor mode derives it from the data
                    (已完成 / 已擦除 / 已冻结 — see editorRegionDisplay), so the
                    three AI-result shapes (翻译/擦除/自定义) each read correctly;
                    in-flight / failed still show their own status. Generation
                    mode keeps the plain status badge. Positioned OUTSIDE the box
                    (see badgeStyle) so it never covers the text underneath. */}
                {boxesInteractive && !isManipulating && (() => {
                  if (region.status === 'processing' || region.status === 'failed') {
                    return (
                      <div
                        className={`absolute text-[8px] font-bold px-1 py-0.5 rounded backdrop-blur-md shadow-sm border pointer-events-none select-none z-10 ${
                          region.status === 'processing'
                            ? 'bg-amber-100/90 text-amber-700 border-amber-200'
                            : 'bg-rose-100/90 text-rose-700 border-rose-200'
                        }`}
                        style={badgeStyle()}
                        // 失败原因只有工坊那一行会列出文本，这里至少让鼠标悬停就
                        // 能看到最近一条（开了重试诊断才有）。
                        title={
                          showRetryDiagnostics && region.errorHistory?.length
                            ? region.errorHistory[region.errorHistory.length - 1]
                            : undefined
                        }
                      >
                        {t(language, `status_${region.status}` as any)}
                        {showRetryDiagnostics && (region.retryCount ?? 0) > 0 && (
                          <span className="ml-1 opacity-90">↻{region.retryCount}</span>
                        )}
                      </div>
                    );
                  }
                  const display = isEditMode
                    ? editorRegionDisplay(region, defaultRedrawIntent)
                    : (region.status === 'completed' ? 'completed' as const : 'pending' as const);
                  if (display === 'pending') return null;
                  const cls = display === 'completed'
                    ? 'bg-emerald-100/90 text-emerald-700 border-emerald-200'
                    : display === 'frozen'
                      ? 'bg-violet-100/90 text-violet-700 border-violet-200'
                      : 'bg-sky-100/90 text-sky-700 border-sky-200';
                  const labelKey = display === 'completed'
                    ? 'status_completed'
                    : display === 'frozen' ? 'editorFrozenBadge' : 'editorErasedBadge';
                  return (
                    <div
                      className={`absolute text-[8px] font-bold px-1 py-0.5 rounded backdrop-blur-md shadow-sm border pointer-events-none select-none z-10 ${cls}`}
                      style={badgeStyle()}
                    >
                      {t(language, labelKey as any)}
                    </div>
                  );
                })()}
              </div>
            );
          })}

          {/* 拖线测角 overlay：A·B 两点 + 虚线 + 实时角度。线宽/字号按 1/zoom
              补偿，屏幕上保持恒定粗细；角度显示的就是松手会提交的归一化值。 */}
          {angleMeasureMode && angleDrag && (
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none z-50 text-skin-primary"
              viewBox={`0 0 ${imgW} ${imgH}`}
              style={{ overflow: 'visible' }}
            >
              <line
                x1={angleDrag.ax} y1={angleDrag.ay} x2={angleDrag.bx} y2={angleDrag.by}
                stroke="currentColor" strokeWidth={2 * invZoom}
                strokeDasharray={`${7 * invZoom} ${5 * invZoom}`} strokeLinecap="round"
              />
              <circle cx={angleDrag.ax} cy={angleDrag.ay} r={3.5 * invZoom} fill="currentColor" />
              <circle cx={angleDrag.bx} cy={angleDrag.by} r={3.5 * invZoom} fill="currentColor" />
              <text
                x={angleDrag.bx + 10 * invZoom} y={angleDrag.by - 8 * invZoom}
                fontSize={13 * invZoom} fontWeight={700} fill="currentColor"
                stroke="#ffffff" strokeWidth={3 * invZoom} style={{ paintOrder: 'stroke' }}
              >
                {measureLineAngle(angleDrag.ax, angleDrag.ay, angleDrag.bx, angleDrag.by, measureVertical)}°
              </text>
            </svg>
          )}

          {/* Drawing preview rectangle */}
          {boxesInteractive && interaction.type === 'drawing' && interaction.currentRect && !restoreMode && (
            <div
              className="absolute border-2 border-dashed border-skin-primary bg-skin-primary/20 pointer-events-none z-50"
              style={{
                left: `${interaction.currentRect.x}%`,
                top: `${interaction.currentRect.y}%`,
                width: `${interaction.currentRect.width}%`,
                height: `${interaction.currentRect.height}%`,
              }}
            />
          )}
        </div>
      </div>

      {/* Zoom controls */}
      {boxesInteractive && !restoreMode && (
        <div className="absolute bottom-4 right-4 flex gap-1 z-40">
          <button onClick={handleZoomOut} className="w-7 h-7 bg-skin-surface border border-skin-border rounded flex items-center justify-center text-sm hover:bg-skin-fill transition" title="Zoom Out">−</button>
          <span className="w-12 h-7 bg-skin-surface border border-skin-border rounded flex items-center justify-center text-[10px] font-mono">{Math.round(zoom * 100)}%</span>
          <button onClick={handleZoomIn} className="w-7 h-7 bg-skin-surface border border-skin-border rounded flex items-center justify-center text-sm hover:bg-skin-fill transition" title="Zoom In">+</button>
          <button onClick={handleZoomReset} className="w-7 h-7 bg-skin-surface border border-skin-border rounded flex items-center justify-center text-[10px] hover:bg-skin-fill transition" title="Fit to Screen">⊡</button>
        </div>
      )}
    </div>
  );
});

export default EditorCanvas;
