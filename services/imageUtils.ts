
import { Region, UploadedImage, RestoreBox } from '../types';

export interface PaddingInfo {
    originalWidth: number;
    originalHeight: number;
}

// =====================================================================
// MEMORY MANAGEMENT UTILITIES
// =====================================================================

const releaseCanvas = (canvas: HTMLCanvasElement) => {
    canvas.width = 0;
    canvas.height = 0;
};

/**
 * Convert a canvas to a Blob Object URL (memory-efficient).
 * Replaces canvas.toDataURL('image/png') — the resulting Object URL
 * is a 20-byte pointer instead of a 40-60MB base64 string.
 * Call URL.revokeObjectURL() when no longer needed.
 */
const canvasToObjectURL = (canvas: HTMLCanvasElement, type: string = 'image/png', quality?: number): Promise<string> => {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(URL.createObjectURL(blob));
            } else {
                reject(new Error('canvas.toBlob returned null'));
            }
        }, type, quality);
    });
};

/**
 * Convert a canvas to a Blob (for API upload without string overhead).
 */
const canvasToBlob = (canvas: HTMLCanvasElement, type: string = 'image/png', quality?: number): Promise<Blob> => {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('canvas.toBlob returned null'));
        }, type, quality);
    });
};

/**
 * Convert an Object URL or Blob URL back to a base64 data URL.
 * Use this ONLY when an API call requires base64 input.
 * This is expensive — avoid calling it unnecessarily.
 */
export const urlToBase64 = (url: string): Promise<string> => {
    // Already a base64 data URL — return as-is
    if (url.startsWith('data:')) return Promise.resolve(url);
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        fetch(url)
            .then(r => r.blob())
            .then(blob => reader.readAsDataURL(blob))
            .catch(reject);
    });
};

/**
 * Convert a base64 data URL to an Object URL (Blob-backed).
 * The original base64 string can then be set to null for GC.
 */
export const base64ToObjectURL = (base64: string): string => {
    if (base64.startsWith('blob:')) return base64; // Already an Object URL
    const [header, data] = base64.split(',');
    const mimeMatch = header.match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
};

/**
 * Async variant: decode base64 data URL → Object URL via the browser's
 * native fetch+blob pipeline (C++), avoiding a JS `atob` + `charCodeAt` loop.
 * Roughly 5-10× faster than `base64ToObjectURL` for multi-MB images.
 * Falls back to the sync version on fetch error (non-data URLs).
 */
export const base64ToObjectURLAsync = async (base64: string): Promise<string> => {
    if (base64.startsWith('blob:')) return base64;
    if (!base64.startsWith('data:')) return base64;
    const blob = await (await fetch(base64)).blob();
    return URL.createObjectURL(blob);
};

/**
 * Release an Object URL. Safe to call on any string (no-op if not a blob URL).
 */
export const releaseObjectURL = (url: string | undefined | null) => {
    if (url && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
    }
};

/**
 * Release all Object URLs on an UploadedImage object.
 * Call this before removing an image from state or when replacing URLs.
 */
export const cleanupImageUrls = (img: UploadedImage) => {
    releaseObjectURL(img.previewUrl);
    releaseObjectURL(img.originalUrl);
    releaseObjectURL(img.thumbnailUrl);
    releaseObjectURL(img.finalResultUrl);
    releaseObjectURL(img.fullAiResultUrl);
    img.regions.forEach(r => {
        releaseObjectURL(r.processedImageUrl);
        releaseObjectURL(r.restoreMaskUrl);
    });
    img.history.forEach(h => {
        releaseObjectURL(h.previewUrl);
        releaseObjectURL(h.fullAiResultUrl);
        releaseObjectURL(h.finalResultUrl);
        h.regions.forEach(r => {
            releaseObjectURL(r.processedImageUrl);
            releaseObjectURL(r.restoreMaskUrl);
        });
    });
};

/**
 * Maximum number of undo history entries per image.
 * Each entry stores full image data, so keep this small.
 */
export const MAX_HISTORY_ENTRIES = 3;

// =====================================================================
// IMAGE LOADING
// =====================================================================

/**
 * Loads an image from a URL (base64 or Object URL) into an HTMLImageElement.
 */
export const loadImage = (url: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
};

// =====================================================================
// CORE IMAGE PROCESSING FUNCTIONS
// All functions now return Object URLs (blob:) instead of base64 strings.
// Only convert to base64 at the API boundary (see urlToBase64).
// =====================================================================

/**
 * Pads an image to a 1:1 square canvas ("补方生图" method).
 * The original is scaled proportionally into the square center; the
 * background is the original stretched to the square and Gaussian-blurred,
 * giving the model natural context instead of hard black bars.
 * Returns an Object URL and padding info.
 */
export const padImageToSquare = async (
    imageUrl: string,
    size: number = 1024
): Promise<{ url: string; info: PaddingInfo }> => {
    const img = await loadImage(imageUrl);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    // Never downscale the content: a configured size below the original's
    // longest edge is bumped up so the centered copy keeps its resolution.
    const S = Math.max(Math.round(size), w, h);

    // Scale original proportionally into the square (centered)
    let fw: number, fh: number;
    if (h >= w) { // tall image → vertical strip in the center
        fw = Math.round((w * S) / h);
        fh = S;
    } else { // wide image → horizontal strip in the center
        fh = Math.round((h * S) / w);
        fw = S;
    }

    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Could not get canvas context for padding");

    // Background: original stretched to the square + Gaussian blur.
    // The blur radius scales with the canvas (16px at 1024, like the
    // reference implementation) and has a floor of 16px.
    const blurRadius = Math.max(16, Math.round(S / 64));
    // Overshoot by the blur radius so the blur's soft edge falls outside
    // the canvas — no faded/transparent rim is left at the borders.
    ctx.filter = `blur(${blurRadius}px)`;
    ctx.drawImage(
        img,
        -blurRadius, -blurRadius,
        S + blurRadius * 2, S + blurRadius * 2
    );
    ctx.filter = 'none';

    // Paste the scaled original centered on top
    ctx.drawImage(img, Math.floor((S - fw) / 2), Math.floor((S - fh) / 2), fw, fh);

    const result = await canvasToObjectURL(canvas);
    releaseCanvas(canvas);
    return {
        url: result,
        info: {
            originalWidth: w,
            originalHeight: h
        }
    };
};

/**
 * Crops the centered region with the original aspect ratio back out of a
 * (square) generated result ("裁回原比例"). Keeps the result's resolution —
 * no downscale back to the original pixel size.
 *
 * `cropInset` trims that many extra pixels off every side of the centered box,
 * to shave off residual Gaussian-blur bleed left by the AI result. The output
 * canvas KEEPS the full original-ratio box: the inset crop is drawn centered
 * at its natural pixel size and the trimmed margin stays transparent, so
 * downstream compositing fills the margin with the original image — the
 * smaller crop is never stretched back to fill the box (which also distorted
 * the aspect ratio). 0 keeps the exact previous behavior (fully opaque box).
 */
export const depadImageByRatio = async (
    squareUrl: string,
    info: PaddingInfo,
    cropInset: number = 0
): Promise<string> => {
    if (info.originalWidth === info.originalHeight) {
        return squareUrl;
    }

    const img = await loadImage(squareUrl);
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;

    const ratio = info.originalWidth / info.originalHeight;

    // Decide the crop direction, then take the centered box
    let cropW: number, cropH: number;
    if (ratio < iw / ih) {
        // result wider than target → crop left/right
        cropH = ih;
        cropW = Math.round(ih * ratio);
    } else {
        // result taller than target → crop top/bottom
        cropW = iw;
        cropH = Math.round(iw / ratio);
    }

    // Inset box: trimmed on every side, still centered. The output canvas
    // keeps the FULL original-ratio box (cropW×cropH); the inset crop is
    // drawn centered at its natural size, leaving the margin transparent.
    const inset = Math.max(0, Math.round(cropInset));
    const innerW = Math.max(1, cropW - inset * 2);
    const innerH = Math.max(1, cropH - inset * 2);

    const left = Math.floor((iw - innerW) / 2);
    const top = Math.floor((ih - innerH) / 2);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = cropW;
    outCanvas.height = cropH;
    const outCtx = outCanvas.getContext('2d');
    if (!outCtx) throw new Error("Could not get canvas context for depadding");

    const dx = Math.floor((cropW - innerW) / 2);
    const dy = Math.floor((cropH - innerH) / 2);
    outCtx.drawImage(img, left, top, innerW, innerH, dx, dy, innerW, innerH);

    const result = await canvasToObjectURL(outCanvas);
    releaseCanvas(outCanvas);
    return result;
};

/**
 * Crops a specific region from the original image.
 * Returns an Object URL.
 */
export const cropRegion = async (
  imageElement: HTMLImageElement,
  region: Region
): Promise<string> => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  
  if (!ctx) throw new Error('Could not get canvas context');

  const x = (region.x / 100) * imageElement.naturalWidth;
  const y = (region.y / 100) * imageElement.naturalHeight;
  const w = (region.width / 100) * imageElement.naturalWidth;
  const h = (region.height / 100) * imageElement.naturalHeight;

  canvas.width = w;
  canvas.height = h;

  ctx.drawImage(
    imageElement,
    x, y, w, h,
    0, 0, w, h
  );

  const result = await canvasToObjectURL(canvas);
  releaseCanvas(canvas);
  return result;
};

/**
 * Creates a full-size image where only the specified region is visible,
 * and the rest is masked with white.
 * Returns an Object URL.
 */
export const createMaskedFullImage = (
  imageElement: HTMLImageElement,
  region: Region
): Promise<string> => {
  const canvas = document.createElement('canvas');
  canvas.width = imageElement.naturalWidth;
  canvas.height = imageElement.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const x = (region.x / 100) * imageElement.naturalWidth;
  const y = (region.y / 100) * imageElement.naturalHeight;
  const w = (region.width / 100) * imageElement.naturalWidth;
  const h = (region.height / 100) * imageElement.naturalHeight;

  ctx.drawImage(
    imageElement,
    x, y, w, h,
    x, y, w, h
  );

  return canvasToObjectURL(canvas).then(result => {
    releaseCanvas(canvas);
    return result;
  });
};

/**
 * Creates a full-size image where ALL specified regions are visible,
 * and the rest is masked with white.
 * Returns an Object URL.
 */
export const createMultiMaskedFullImage = (
  imageElement: HTMLImageElement,
  regions: Region[]
): Promise<string> => {
  const canvas = document.createElement('canvas');
  canvas.width = imageElement.naturalWidth;
  canvas.height = imageElement.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  regions.forEach(region => {
      const x = (region.x / 100) * imageElement.naturalWidth;
      const y = (region.y / 100) * imageElement.naturalHeight;
      const w = (region.width / 100) * imageElement.naturalWidth;
      const h = (region.height / 100) * imageElement.naturalHeight;

      ctx.drawImage(
        imageElement,
        x, y, w, h,
        x, y, w, h
      );
  });

  return canvasToObjectURL(canvas).then(result => {
    releaseCanvas(canvas);
    return result;
  });
};

/**
 * REVERSE MASKING MODE:
 * Creates a full-size image where the original background is visible,
 * but the selected regions are masked out (White).
 * Returns an Object URL.
 */
export const createInvertedMultiMaskedFullImage = (
  imageElement: HTMLImageElement,
  regions: Region[]
): Promise<string> => {
  const canvas = document.createElement('canvas');
  canvas.width = imageElement.naturalWidth;
  canvas.height = imageElement.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  ctx.drawImage(imageElement, 0, 0);

  ctx.fillStyle = '#FFFFFF';
  regions.forEach(region => {
      const x = (region.x / 100) * imageElement.naturalWidth;
      const y = (region.y / 100) * imageElement.naturalHeight;
      const w = (region.width / 100) * imageElement.naturalWidth;
      const h = (region.height / 100) * imageElement.naturalHeight;

      ctx.fillRect(x, y, w, h);
  });

  return canvasToObjectURL(canvas).then(result => {
    releaseCanvas(canvas);
    return result;
  });
};

/**
 * Extracts the crop corresponding to the region from a full-size returned image.
 * Applies feathering (alpha blending) to the edges to ensure seamless stitching.
 * Returns an Object URL.
 */
export const extractCropFromFullImage = async (
  fullImageUrl: string,
  region: Region,
  originalWidth: number,
  originalHeight: number,
  opaquePercent: number = 99
): Promise<string> => {
  const fullImg = await loadImage(fullImageUrl);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  const w = (region.width / 100) * originalWidth;
  const h = (region.height / 100) * originalHeight;

  canvas.width = w;
  canvas.height = h;

  const resultW = fullImg.naturalWidth;
  const resultH = fullImg.naturalHeight;
  
  const rx = (region.x / 100) * resultW;
  const ry = (region.y / 100) * resultH;
  const rw = (region.width / 100) * resultW;
  const rh = (region.height / 100) * resultH;

  ctx.drawImage(
    fullImg,
    rx, ry, rw, rh,
    0, 0, w, h
  );

  if (opaquePercent < 100) {
      ctx.globalCompositeOperation = 'destination-in';

      const p = Math.max(0, Math.min(100, opaquePercent)) / 100;
      const featherRatio = (1 - p) / 2; 
      
      const hGrad = ctx.createLinearGradient(0, 0, w, 0);
      hGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      hGrad.addColorStop(featherRatio, 'rgba(0, 0, 0, 1)');
      hGrad.addColorStop(1 - featherRatio, 'rgba(0, 0, 0, 1)');
      hGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx.fillStyle = hGrad;
      ctx.fillRect(0, 0, w, h);

      const vGrad = ctx.createLinearGradient(0, 0, 0, h);
      vGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vGrad.addColorStop(featherRatio, 'rgba(0, 0, 0, 1)');
      vGrad.addColorStop(1 - featherRatio, 'rgba(0, 0, 0, 1)');
      vGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx.fillStyle = vGrad;
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = 'source-over';
  }

  const result = await canvasToObjectURL(canvas);
  releaseCanvas(canvas);
  return result;
};


/**
 * Re-crops a processed region image when the region has been resized.
 * Returns an Object URL.
 */
export const reCropProcessedImage = async (
  processedImageUrl: string,
  oldRegion: { x: number; y: number; width: number; height: number },
  newRegion: { x: number; y: number; width: number; height: number },
  originalWidth: number,
  originalHeight: number
): Promise<string> => {
  const img = await loadImage(processedImageUrl);

  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = originalWidth;
  fullCanvas.height = originalHeight;
  const fullCtx = fullCanvas.getContext('2d');
  if (!fullCtx) throw new Error('Could not get canvas context');

  const px = (oldRegion.x / 100) * originalWidth;
  const py = (oldRegion.y / 100) * originalHeight;
  const pw = (oldRegion.width / 100) * originalWidth;
  const ph = (oldRegion.height / 100) * originalHeight;

  fullCtx.drawImage(img, px, py, pw, ph);

  const nx = (newRegion.x / 100) * originalWidth;
  const ny = (newRegion.y / 100) * originalHeight;
  const nw = (newRegion.width / 100) * originalWidth;
  const nh = (newRegion.height / 100) * originalHeight;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = nw;
  outCanvas.height = nh;
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) throw new Error('Could not get canvas context');

  outCtx.drawImage(fullCanvas, nx, ny, nw, nh, 0, 0, nw, nh);

  releaseCanvas(fullCanvas);
  const result = await canvasToObjectURL(outCanvas);
  releaseCanvas(outCanvas);
  return result;
};

/**
 * Renders a processed region image with restore boxes applied.
 * Returns an Object URL, or the input URL unchanged if no restore operations.
 */
export const renderRegionWithRestore = async (
  processedImageUrl: string,
  restoreBoxes?: RestoreBox[],
  restoreMaskUrl?: string
): Promise<string> => {
  const hasBoxes = restoreBoxes && restoreBoxes.length > 0;
  const hasMask = !!restoreMaskUrl;

  if (!hasBoxes && !hasMask) return processedImageUrl;

  const img = await loadImage(processedImageUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  const w = canvas.width;
  const h = canvas.height;

  if (hasBoxes) {
    const nonInverse = restoreBoxes!.filter(b => !b.inverse);
    const inverse = restoreBoxes!.filter(b => b.inverse);

    if (inverse.length > 0) {
      ctx.globalCompositeOperation = 'source-over';
      for (const box of inverse) {
        const bx = (box.x / 100) * w;
        const by = (box.y / 100) * h;
        const bw = (box.width / 100) * w;
        const bh = (box.height / 100) * h;
        ctx.drawImage(img, bx, by, bw, bh, bx, by, bw, bh);
      }
      ctx.globalCompositeOperation = 'destination-out';
      for (const box of nonInverse) {
        const bx = (box.x / 100) * w;
        const by = (box.y / 100) * h;
        const bw = (box.width / 100) * w;
        const bh = (box.height / 100) * h;
        ctx.fillStyle = 'white';
        ctx.fillRect(bx, by, bw, bh);
      }
    } else {
      ctx.drawImage(img, 0, 0);
      ctx.globalCompositeOperation = 'destination-out';
      for (const box of nonInverse) {
        const bx = (box.x / 100) * w;
        const by = (box.y / 100) * h;
        const bw = (box.width / 100) * w;
        const bh = (box.height / 100) * h;
        ctx.fillStyle = 'white';
        ctx.fillRect(bx, by, bw, bh);
      }
    }
  } else {
    ctx.drawImage(img, 0, 0);
  }

  if (hasMask) {
    const maskImg = await loadImage(restoreMaskUrl!);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(maskImg, 0, 0, w, h);
  }

  const result = await canvasToObjectURL(canvas);
  releaseCanvas(canvas);
  return result;
};

/**
 * The visible window of a region patch, returned as per-side insets measured
 * from the patch box edges. Every input shares ONE coordinate space (percent of
 * image for the canvas overlay, pixels for the stitcher) — only deltas matter.
 *
 * `patchBox` is the anchor box enlarged by the overflow margin, `anchorBox` is
 * the box the patch was composited for, `regionRect` is the current (draggable)
 * frame.
 *
 * Per side: when the user SHRANK the frame past the anchor box, the window
 * stops at the frame edge — that is what reveals the untouched original
 * underneath once a box is narrowed. Otherwise the side keeps the overflow
 * margin, EXCEPT when `allowPatchOverflow` is false (AI 重绘 / 手动修补工坊),
 * where the margin is dropped so overflowing typeset text is never visible.
 *
 * Shared by the canvas overlay and `stitchImage`, so the 已完成 tab and the
 * exported file can never disagree.
 */
export const resolvePatchWindowInsets = (
  patchBox: { x: number; y: number; w: number; h: number },
  anchorBox: { x: number; y: number; w: number; h: number },
  regionRect: { x: number; y: number; w: number; h: number },
  allowPatchOverflow: boolean
): { top: number; right: number; bottom: number; left: number } => {
  const { x: ex, y: ey, w: ew, h: eh } = patchBox;
  const { x: ax, y: ay, w: aw, h: ah } = anchorBox;
  const { x, y, w, h } = regionRect;
  // The anchor holds the exact frame geometry from composite time, so an
  // untouched frame compares equal; the epsilon only absorbs float noise.
  const EPS = 1e-6;
  const left = x > ax + EPS
    ? x
    : (allowPatchOverflow ? ex : Math.max(ex, ax));
  const top = y > ay + EPS
    ? y
    : (allowPatchOverflow ? ey : Math.max(ey, ay));
  const right = x + w < ax + aw - EPS
    ? x + w
    : (allowPatchOverflow ? ex + ew : Math.min(ex + ew, ax + aw));
  const bottom = y + h < ay + ah - EPS
    ? y + h
    : (allowPatchOverflow ? ey + eh : Math.min(ey + eh, ay + ah));
  return {
    top: Math.max(0, top - ey),
    right: Math.max(0, ex + ew - right),
    bottom: Math.max(0, ey + eh - bottom),
    left: Math.max(0, left - ex),
  };
};

/**
 * Stitches processed regions back onto the original image.
 * Returns an Object URL.
 */
export const stitchImage = async (
  originalImageUrl: string,
  regions: Region[],
  /**
   * Honour the editor patch overflow margin (typeset text spilling out of the
   * box). Only the EDITOR workflow wants that; AI 重绘 / 手动修补工坊 crop the
   * patch back to its box so the overflow is not visible there. Default true
   * preserves the historical behaviour for any other caller.
   */
  honorPatchOverflow: boolean = true
): Promise<string> => {
  const baseImg = await loadImage(originalImageUrl);
  
  const canvas = document.createElement('canvas');
  canvas.width = baseImg.naturalWidth;
  canvas.height = baseImg.naturalHeight;
  
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  ctx.drawImage(baseImg, 0, 0);

  const eligible = regions.filter(r => r.processedImageUrl && r.status === 'completed');

  // Parallel: produce each region's displayUrl (optional restore render) and decode the
  // patch image. With N regions this collapses 2N sequential async waits into one barrier.
  const prepared = await Promise.all(eligible.map(async region => {
    const hasRestore = (region.restoreBoxes && region.restoreBoxes.length > 0) || !!region.restoreMaskUrl;
    const displayUrl = hasRestore
      ? await renderRegionWithRestore(region.processedImageUrl, region.restoreBoxes, region.restoreMaskUrl)
      : region.processedImageUrl;
    const regionImg = await loadImage(displayUrl);
    return { region, displayUrl, regionImg, hasRestore };
  }));

  // Serial draw to preserve z-order and clip state.
  for (const { region, displayUrl, regionImg, hasRestore } of prepared) {
    const x = (region.x / 100) * baseImg.naturalWidth;
    const y = (region.y / 100) * baseImg.naturalHeight;
    const w = (region.width / 100) * baseImg.naturalWidth;
    const h = (region.height / 100) * baseImg.naturalHeight;

    const ax = ((region.anchorX ?? region.x) / 100) * baseImg.naturalWidth;
    const ay = ((region.anchorY ?? region.y) / 100) * baseImg.naturalHeight;
    const aw = ((region.anchorWidth ?? region.width) / 100) * baseImg.naturalWidth;
    const ah = ((region.anchorHeight ?? region.height) / 100) * baseImg.naturalHeight;

    // Editor patches may carry an overflow margin (text spilling out of the
    // box) — the patch box is the anchor enlarged by it. Matches the
    // EditorCanvas overlay.
    const mx = ((region.patchMarginX ?? 0) / 100) * baseImg.naturalWidth;
    const my = ((region.patchMarginY ?? 0) / 100) * baseImg.naturalHeight;
    const ex = ax - mx;
    const ey = ay - my;
    const ew = aw + 2 * mx;
    const eh = ah + 2 * my;

    // Match CSS `object-fit: contain; object-position: center` used by EditorCanvas overlay.
    // Without this, pasted patches whose aspect ratio differs from the patch box get
    // stretched to fill ew×eh. Editor patches already match the box aspect, so
    // this branch is a no-op for them.
    const srcW = regionImg.naturalWidth;
    const srcH = regionImg.naturalHeight;
    const fitScale = srcW > 0 && srcH > 0 ? Math.min(ew / srcW, eh / srcH) : 1;
    const drawW = srcW * fitScale;
    const drawH = srcH * fitScale;
    const drawX = ex + (ew - drawW) / 2;
    const drawY = ey + (eh - drawH) / 2;

    // Same visible window as the overlay: sides the user shrank are cropped
    // (so the original underneath shows through), the rest keep the overflow
    // margin — dropped entirely in the AI 重绘 / 手动修补工坊 workflows.
    const insets = resolvePatchWindowInsets(
      { x: ex, y: ey, w: ew, h: eh },
      { x: ax, y: ay, w: aw, h: ah },
      { x, y, w, h },
      honorPatchOverflow
    );
    const clipped =
      insets.left > 0.5 || insets.top > 0.5 || insets.right > 0.5 || insets.bottom > 0.5;

    ctx.save();
    if (clipped) {
      ctx.beginPath();
      ctx.rect(
        ex + insets.left,
        ey + insets.top,
        Math.max(1, ew - insets.left - insets.right),
        Math.max(1, eh - insets.top - insets.bottom)
      );
      ctx.clip();
    }
    ctx.drawImage(regionImg, drawX, drawY, drawW, drawH);
    ctx.restore();

    if (hasRestore) releaseObjectURL(displayUrl);
  }

  const result = await canvasToObjectURL(canvas);
  releaseCanvas(canvas);
  return result;
};

/**
 * REVERSE STITCHING:
 * Base is the AI Generated Image (Full).
 * We paste the ORIGINAL image regions on top.
 * Returns an Object URL.
 */
export const stitchImageInverted = async (
  originalImageUrl: string,
  aiFullResultUrl: string,
  regions: Region[]
): Promise<string> => {
  const originalImg = await loadImage(originalImageUrl);
  const aiImg = await loadImage(aiFullResultUrl);
  
  const canvas = document.createElement('canvas');
  canvas.width = originalImg.naturalWidth;
  canvas.height = originalImg.naturalHeight;
  
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  // Base layer: the original image, so a transparent crop-inset margin in
  // the AI layer falls back to the original pixels instead of becoming a
  // hole. With a fully opaque AI layer this is visually identical to
  // drawing the AI layer alone.
  ctx.drawImage(originalImg, 0, 0, canvas.width, canvas.height);
  ctx.drawImage(aiImg, 0, 0, canvas.width, canvas.height);

  for (const region of regions) {
      const x = (region.x / 100) * originalImg.naturalWidth;
      const y = (region.y / 100) * originalImg.naturalHeight;
      const w = (region.width / 100) * originalImg.naturalWidth;
      const h = (region.height / 100) * originalImg.naturalHeight;

      ctx.drawImage(
        originalImg,
        x, y, w, h,
        x, y, w, h
      );
  }

  const result = await canvasToObjectURL(canvas);
  releaseCanvas(canvas);
  return result;
};

// =====================================================================
// FILE I/O UTILITIES
// =====================================================================

export const readFileAsDataURL = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

/**
 * Read a File as an Object URL (Blob-backed, memory-efficient).
 * Use this instead of readFileAsDataURL for display purposes.
 */
export const readFileAsObjectURL = (file: File): string => {
    return URL.createObjectURL(file);
};

// Helper to strip data:image/png;base64, prefix
export const extractBase64Data = (dataUrl: string): string => {
  return dataUrl.split(',')[1];
};

/**
 * Longest-edge cap of the display preview built on upload (see
 * `useImageManager`). Region patches — and therefore typeset font sizes — are
 * composited at the PREVIEW's resolution, so this is the single source of truth
 * when converting the full-size original's pixels to the preview's.
 */
export const PREVIEW_MAX_PX = 2048;

/**
 * Pixel size of the display preview for an `w`×`h` original. `compressImage`
 * only scales down to fit PREVIEW_MAX_PX, so the preview equals the original
 * when it already fits (or when the preview is the original itself).
 */
export const previewPixelSize = (
  w: number,
  h: number,
  previewIsCompressed: boolean
): { w: number; h: number } => {
  const safe = { w: Math.max(1, w || 1), h: Math.max(1, h || 1) };
  if (!previewIsCompressed) return safe;
  if (safe.w <= PREVIEW_MAX_PX && safe.h <= PREVIEW_MAX_PX) return safe;
  const ratio = Math.min(PREVIEW_MAX_PX / safe.w, PREVIEW_MAX_PX / safe.h);
  return { w: Math.round(safe.w * ratio), h: Math.round(safe.h * ratio) };
};

/**
 * Compresses an image for use as a lightweight reference/context image.
 * Returns an Object URL (JPEG, small).
 */
export const compressImage = async (
  imageUrl: string,
  options: { maxWidth?: number; maxHeight?: number; quality?: number } = {}
): Promise<string> => {
  const { maxWidth = 1024, maxHeight = 1024, quality = 0.7 } = options;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return imageUrl;

  const img = await loadImage(imageUrl);
  let w = img.naturalWidth;
  let h = img.naturalHeight;

  if (w === 0 || h === 0) return imageUrl;

  if (w > maxWidth || h > maxHeight) {
    const ratio = Math.min(maxWidth / w, maxHeight / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }

  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(img, 0, 0, w, h);

  const result = await canvasToObjectURL(canvas, 'image/jpeg', quality);
  releaseCanvas(canvas);
  return result;
};

/**
 * Compress to a target file size by binary-searching WebP quality.
 * Pixel dimensions are preserved (clarity > size), unless `maxDimension`
 * caps the longest edge. If the source is already small enough at the
 * high-quality probe (0.92), returns that without further work.
 *
 * Returns an Object URL. On environments without WebP encoder support,
 * falls back to JPEG.
 */
export const compressImageToTargetSize = async (
  imageUrl: string,
  options: { targetSizeKB: number; maxDimension?: number; mimeType?: 'image/webp' | 'image/jpeg' }
): Promise<string> => {
  const { targetSizeKB, maxDimension, mimeType = 'image/webp' } = options;
  const targetBytes = Math.max(1, targetSizeKB) * 1024;

  const img = await loadImage(imageUrl);
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (w === 0 || h === 0) return imageUrl;

  if (maxDimension && (w > maxDimension || h > maxDimension)) {
    const ratio = Math.min(maxDimension / w, maxDimension / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return imageUrl;
  ctx.drawImage(img, 0, 0, w, h);

  const encode = async (quality: number, type: string): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob && blob.size > 0) resolve(blob);
        else reject(new Error('toBlob returned empty blob'));
      }, type, quality);
    });
  };

  // Probe at high quality first. WebP at 0.92 is visually near-lossless
  // for photo/manga content but already much smaller than PNG. If it fits,
  // skip the binary search entirely — common case for region-level crops.
  let activeType = mimeType;
  let probe: Blob;
  try {
    probe = await encode(0.92, activeType);
  } catch {
    // WebP encoder missing → fall back to JPEG and re-probe.
    activeType = 'image/jpeg';
    probe = await encode(0.92, activeType);
  }
  if (probe.size <= targetBytes) {
    const url = URL.createObjectURL(probe);
    releaseCanvas(canvas);
    return url;
  }

  // Binary search quality in [0.05, 0.92]. 6 iterations → ~0.014 precision.
  // Track best-under (preferred) and best-over (fallback for tiny targets).
  let lo = 0.05;
  let hi = 0.92;
  let bestUnder: Blob | null = null;
  let bestOver: Blob = probe;
  for (let i = 0; i < 6; i++) {
    const mid = (lo + hi) / 2;
    const blob = await encode(mid, activeType);
    if (blob.size <= targetBytes) {
      bestUnder = blob;
      lo = mid;
    } else {
      bestOver = blob;
      hi = mid;
    }
  }

  const finalBlob = bestUnder ?? bestOver;
  const url = URL.createObjectURL(finalBlob);
  releaseCanvas(canvas);
  return url;
};

export const generateThumbnail = async (img: HTMLImageElement, maxDim: number = 256): Promise<string> => {
  const ratio = Math.min(maxDim / img.naturalWidth, maxDim / img.naturalHeight, 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * ratio);
  canvas.height = Math.round(img.naturalHeight * ratio);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const result = await canvasToObjectURL(canvas, 'image/jpeg', 0.7);
  releaseCanvas(canvas);
  return result;
};

export const fetchImageAsBase64 = async (url: string): Promise<string> => {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.error("Failed to fetch image from URL via proxy/cors", e);
    return url;
  }
};

/**
 * Comparator for Natural Sort Order (e.g., 1.png, 2.png, 10.png)
 */
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalSortCompare = (a: UploadedImage, b: UploadedImage) => {
  return naturalCollator.compare(a.file.name, b.file.name);
};
