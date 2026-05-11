
import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { UploadedImage, Region, Language, RestoreBox } from '../types';
import { t } from '../services/translations';
import { useCanvasInteraction } from '../hooks/useCanvasInteraction';
import { renderRegionWithRestore, loadImage, releaseObjectURL } from '../services/imageUtils';

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

interface EditorCanvasProps {
  image: UploadedImage;
  onUpdateRegions: (imageId: string, regions: Region[]) => void;
  disabled?: boolean;
  language: Language;
  onOpenEditor: (regionId: string) => void;
  selectedRegionId: string | null;
  onSelectRegion: (regionId: string | null) => void;
  onOcrRegion?: (regionId: string) => void;
  showOcrButton?: boolean;
  showEditorButton?: boolean;
  onAdjustRegionSize?: (regionId: string, isExpand: boolean) => void;
  onInteractionStart?: () => void;
  viewMode?: 'original' | 'result';
  restoreMode?: boolean;
  onUpdateRestoreBoxes?: (regionId: string, boxes: RestoreBox[]) => void;
  onUpdateRestoreMask?: (regionId: string, maskBase64: string | null) => void;
  restoreBrushMode?: boolean;
  restoreBrushSize?: number;
  restoreSelectedRegionId?: string | null;
  onSelectRestoreRegion?: (regionId: string | null) => void;
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
    onOpenEditor,
    selectedRegionId,
    onSelectRegion,
    onOcrRegion,
    showOcrButton = false,
    showEditorButton = false,
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
}) => {
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
  const calculateFitZoom = useCallback(() => {
    if (!viewportRef.current || !image.originalWidth) return 1;
    const vw = viewportRef.current.clientWidth;
    const vh = viewportRef.current.clientHeight;
    if (vw <= 0 || vh <= 0) return 1;
    // fit zoom: scale image to fit within viewport, but never exceed 1 (don't upscale small images)
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
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || restoreMode) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
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
      }
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, [restoreMode, image.originalWidth, image.originalHeight]);

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
      viewMode as 'original' | 'result',
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
      .filter(r => r.status === 'completed' && r.processedImageBase64)
      .map(r => `${r.id}|${r.processedImageBase64}|${r.restoreMaskBase64 || ''}|${(r.restoreBoxes || []).length}`)
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
        if (region.status === 'completed' && region.processedImageBase64) {
          const hasRestore = (region.restoreBoxes && region.restoreBoxes.length > 0) || !!region.restoreMaskBase64;
          if (hasRestore) {
            try {
              newCache[region.id] = await renderRegionWithRestore(
                region.processedImageBase64,
                region.restoreBoxes,
                region.restoreMaskBase64
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
    if (!region || !region.processedImageBase64) return;

    const initMask = async () => {
      const img = await loadImage(region.processedImageBase64!);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = w;
      maskCanvas.height = h;
      const mctx = maskCanvas.getContext('2d');
      if (!mctx) return;
      if (region.restoreMaskBase64) {
        const maskImg = await loadImage(region.restoreMaskBase64);
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

  // --- Region actions ---
  const toggleContextOnly = (regionId: string) => {
    if (disabled) return;
    const newRegions = image.regions.map(r =>
      r.id === regionId ? { ...r, contextOnly: !r.contextOnly } : r
    );
    onUpdateRegions(image.id, newRegions);
  };

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
        return { ...r, status: 'pending', processedImageBase64: undefined, restoreBoxes: undefined } as Region;
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

  const isOriginalMode = viewMode === 'original';
  const isRestoreActive = restoreMode && viewMode === 'result';

  const imgW = image.originalWidth || 800;
  const imgH = image.originalHeight || 600;

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
          className={`absolute shadow-xl ${isOriginalMode && !restoreMode ? '' : 'cursor-default'}`}
          onMouseDown={isRestoreActive ? handleRestoreContainerMouseDown : (e) => {
            // Block left-click background interaction when panning with space or alt
            if (e.button === 0 && (e.altKey || spaceHeldRef.current)) return;
            handleBackgroundMouseDown(e);
          }}
          style={{
            width: imgW,
            height: imgH,
            transformOrigin: '0 0',
            transform: `translate(${(vpW - imgW * zoom) / 2 + panX}px, ${(vpH - imgH * zoom) / 2 + panY}px) scale(${zoom})`,
            cursor: isRestoreActive ? 'crosshair' : (isOriginalMode && interaction.type === 'drawing' ? 'crosshair' : 'default'),
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

          {/* RESULT MODE: Processed image overlays */}
          {!isOriginalMode && image.regions.filter(r => r.status === 'completed' && r.processedImageBase64).map((region) => {
            const ax = region.anchorX ?? region.x;
            const ay = region.anchorY ?? region.y;
            const aw = region.anchorWidth ?? region.width;
            const ah = region.anchorHeight ?? region.height;
            const hasRestore = (region.restoreBoxes && region.restoreBoxes.length > 0) || region.restoreMaskBase64;
            const clipTop    = aw > 0 && ah > 0 ? Math.max(0, ((region.y - ay) / ah) * 100) : 0;
            const clipRight  = aw > 0 && ah > 0 ? Math.max(0, ((ax + aw - region.x - region.width) / aw) * 100) : 0;
            const clipBottom = aw > 0 && ah > 0 ? Math.max(0, ((ay + ah - region.y - region.height) / ah) * 100) : 0;
            const clipLeft   = aw > 0 && ah > 0 ? Math.max(0, ((region.x - ax) / aw) * 100) : 0;
            return (
              <img
                key={`overlay-${region.id}`}
                src={hasRestore ? (restoreCompositedCacheRef.current[region.id] || region.processedImageBase64) : region.processedImageBase64}
                className="absolute pointer-events-none select-none"
                style={{
                  left: `${ax}%`,
                  top: `${ay}%`,
                  width: `${aw}%`,
                  height: `${ah}%`,
                  objectFit: 'contain',
                  objectPosition: 'center center',
                  clipPath: `inset(${clipTop}% ${clipRight}% ${clipBottom}% ${clipLeft}%)`,
                  zIndex: 5,
                }}
                alt=""
              />
            );
          })}

          {/* Regions */}
          {image.regions.map((region) => {
            const isSelected = selectedRegionId === region.id && isOriginalMode;
            const isEditable = isOriginalMode && !disabled && region.status !== 'processing';

            const isManipulating = (interaction.type === 'moving' || interaction.type === 'resizing') && interaction.regionId === region.id;

            const x = isManipulating && interaction.currentRect?.x !== undefined ? interaction.currentRect.x : region.x;
            const y = isManipulating && interaction.currentRect?.y !== undefined ? interaction.currentRect.y : region.y;
            const width = isManipulating && interaction.currentRect?.width !== undefined ? interaction.currentRect.width : region.width;
            const height = isManipulating && interaction.currentRect?.height !== undefined ? interaction.currentRect.height : region.height;

            let styleClasses = '';

            if (!isOriginalMode) {
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
                     if (isSelected) {
                         styleClasses = 'border-2 border-emerald-500 bg-emerald-500/20 shadow-[0_0_0_2px_rgba(255,255,255,0.8),0_0_0_4px_#10b981] z-30 cursor-move';
                     } else {
                         styleClasses = 'border-2 border-emerald-500 bg-emerald-500/10 z-10 cursor-pointer';
                     }
                } else {
                    if (isSelected) {
                        styleClasses = 'border-2 border-skin-primary bg-skin-primary/10 shadow-[0_0_0_1px_rgba(255,255,255,0.5)] z-20 cursor-move';
                    } else {
                        styleClasses = 'border-2 border-skin-primary hover:border-skin-primary bg-skin-primary/5 z-10 cursor-pointer';
                    }
                }
            }

            if (region.contextOnly) {
                styleClasses = isSelected
                  ? 'border-2 border-dashed border-amber-400 bg-amber-400/10 shadow-[0_0_0_1px_rgba(251,191,36,0.5)] z-20 cursor-move'
                  : 'border-2 border-dashed border-gray-400 bg-gray-400/5 z-10 cursor-pointer hover:border-amber-400/50';
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
              const toolbarScreenHeight = 28; // approx button height
              const margin = 4; // gap between toolbar and region edge
              if (regionScreenTop - vRect.top < toolbarScreenHeight + margin) {
                return 'below';
              }
              return 'above';
            };
            const toolbarPlacement = (isSelected && !isManipulating && !restoreMode)
              ? getToolbarPlacement()
              : 'above';
            const toolbarGap = 28 * invZoom; // fixed 28 screen-pixel gap between region and toolbar
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
                  cursor: isOriginalMode || isRestoreActive ? cursorStyle : 'default',
                  overflow: (isRestoreActive || !isOriginalMode) ? 'hidden' : 'visible'
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
                       {!disabled && onOcrRegion && showOcrButton && (
                           <button
                             onClick={(e) => {
                               e.stopPropagation();
                               onOcrRegion(region.id);
                             }}
                             className={`w-6 h-6 bg-skin-primary text-skin-primary-fg border border-transparent rounded-full flex items-center justify-center shadow-md hover:shadow-lg transition-all ${region.isOcrLoading ? 'opacity-70 cursor-wait' : ''}`}
                             title={t(language, 'ocrBtn')}
                             disabled={region.isOcrLoading}
                           >
                            {region.isOcrLoading ? (
                               <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                            ) : (
                               <span className="text-[9px] font-bold tracking-tighter">OCR</span>
                            )}
                          </button>
                      )}
                      {!disabled && showEditorButton && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenEditor(region.id);
                            }}
                             className="w-6 h-6 bg-skin-primary text-skin-primary-fg border border-transparent rounded-full flex items-center justify-center shadow-md hover:shadow-lg transition-all"
                             title="Edit Patch (Brush/Text)"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                          </button>
                      )}
                      {!disabled && (region.status === 'completed' || region.status === 'failed') && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              resetRegion(region.id);
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
                              toggleContextOnly(region.id);
                            }}
                             className={`w-6 h-6 border rounded-full flex items-center justify-center shadow-md hover:shadow-lg transition-all ${region.contextOnly ? 'bg-amber-100 text-amber-600 border-amber-400' : 'bg-skin-surface text-skin-muted border-skin-border'}`}
                            title={region.contextOnly ? 'Context Only (click to enable translation)' : 'Mark as Context Only'}
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
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

                {/* ORIGINAL MODE: Status Badge */}
                {isOriginalMode && region.status !== 'pending' && !isManipulating && (
                  <div
                    className={`absolute text-[8px] font-bold px-1 py-0.5 rounded backdrop-blur-md shadow-sm border pointer-events-none select-none z-10 ${
                      region.status === 'completed' ? 'bg-emerald-100/90 text-emerald-700 border-emerald-200' :
                      region.status === 'processing' ? 'bg-amber-100/90 text-amber-700 border-amber-200' :
                      'bg-rose-100/90 text-rose-700 border-rose-200'
                    }`}
                    style={{
                      top: 2 * invZoom,
                      left: 2 * invZoom,
                      transform: `scale(${invZoom})`,
                      transformOrigin: 'top left',
                    }}
                  >
                    {t(language, `status_${region.status}` as any)}
                  </div>
                )}
              </div>
            );
          })}

          {/* Drawing preview rectangle */}
          {isOriginalMode && interaction.type === 'drawing' && interaction.currentRect && !restoreMode && (
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
      {isOriginalMode && !restoreMode && (
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
