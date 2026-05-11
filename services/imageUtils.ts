
import { Region, UploadedImage, RestoreBox } from '../types';

export interface PaddingInfo {
    originalWidth: number;
    originalHeight: number;
    /** Which side(s) received black padding.
     *  'right'  = image wider than tall → black on the right
     *  'bottom' = image taller than wide → black on the bottom
     *  'none'   = already square
     */
    paddedSide: 'right' | 'bottom' | 'none';
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
        releaseObjectURL(r.processedImageBase64);
        releaseObjectURL(r.restoreMaskBase64);
    });
    img.history.forEach(h => {
        releaseObjectURL(h.previewUrl);
        releaseObjectURL(h.fullAiResultUrl);
        releaseObjectURL(h.finalResultUrl);
        h.regions.forEach(r => {
            releaseObjectURL(r.processedImageBase64);
            releaseObjectURL(r.restoreMaskBase64);
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
 * Pads an image to a 1:1 square canvas.
 * Returns an Object URL and padding info.
 */
export const padImageToSquare = async (
    imageUrl: string
): Promise<{ url: string; info: PaddingInfo }> => {
    const img = await loadImage(imageUrl);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const maxDim = Math.max(w, h);

    const canvas = document.createElement('canvas');
    canvas.width = maxDim;
    canvas.height = maxDim;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Could not get canvas context for padding");

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, maxDim, maxDim);
    ctx.drawImage(img, 0, 0);

    let paddedSide: PaddingInfo['paddedSide'] = 'none';
    if (w > h) paddedSide = 'bottom';
    else if (h > w) paddedSide = 'right';

    const result = await canvasToObjectURL(canvas);
    releaseCanvas(canvas);
    return {
        url: result,
        info: {
            originalWidth: w,
            originalHeight: h,
            paddedSide
        }
    };
};

/**
 * De-pads by simply cropping the known padding proportion.
 */
export const depadImageByRatio = async (
    squareUrl: string,
    info: PaddingInfo
): Promise<string> => {
    if (info.paddedSide === 'none') {
        return squareUrl;
    }

    const img = await loadImage(squareUrl);
    const w = img.naturalWidth;
    const h = img.naturalHeight;

    let sx: number, sy: number, sw: number, sh: number;

    if (info.paddedSide === 'bottom') {
        sw = w;
        sh = w * (info.originalHeight / info.originalWidth);
        sx = 0;
        sy = 0;
    } else {
        sh = h;
        sw = h * (info.originalWidth / info.originalHeight);
        sx = 0;
        sy = 0;
    }

    const outCanvas = document.createElement('canvas');
    outCanvas.width = info.originalWidth;
    outCanvas.height = info.originalHeight;
    const outCtx = outCanvas.getContext('2d');
    if (!outCtx) throw new Error("Could not get canvas context for depadding");

    outCtx.drawImage(img, sx, sy, sw, sh, 0, 0, info.originalWidth, info.originalHeight);

    const result = await canvasToObjectURL(outCanvas);
    releaseCanvas(outCanvas);
    return result;
};

/**
 * Extracts the original content from a square image by detecting black padding
 * bars. Scans each edge inward, falls back to ratio-based if detection fails.
 */
export const depadImageFromSquare = async (
    squareUrl: string,
    info: PaddingInfo,
    margin: number = 2
): Promise<string> => {
    const img = await loadImage(squareUrl);
    const w = img.naturalWidth;
    const h = img.naturalHeight;

    if (info.originalWidth === info.originalHeight) {
        return squareUrl;
    }

    const scanCanvas = document.createElement('canvas');
    scanCanvas.width = w;
    scanCanvas.height = h;
    const scanCtx = scanCanvas.getContext('2d');
    if (!scanCtx) throw new Error("Could not get canvas context for depadding");
    scanCtx.drawImage(img, 0, 0);
    const imageData = scanCtx.getImageData(0, 0, w, h);
    const pixels = imageData.data;

    const isDark = (r: number, g: number, b: number) => (r + g + b) <= 40;
    const ROW_DARK_RATIO = 0.90;

    let topCrop = 0;
    for (let y = 0; y < h; y++) {
        let darkCount = 0;
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (isDark(pixels[i], pixels[i + 1], pixels[i + 2])) darkCount++;
        }
        if (darkCount / w < ROW_DARK_RATIO) break;
        topCrop = y + 1;
    }

    let bottomCrop = 0;
    for (let y = h - 1; y >= 0; y--) {
        let darkCount = 0;
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (isDark(pixels[i], pixels[i + 1], pixels[i + 2])) darkCount++;
        }
        if (darkCount / w < ROW_DARK_RATIO) break;
        bottomCrop = h - y;
    }

    let leftCrop = 0;
    for (let x = 0; x < w; x++) {
        let darkCount = 0;
        for (let y = 0; y < h; y++) {
            const i = (y * w + x) * 4;
            if (isDark(pixels[i], pixels[i + 1], pixels[i + 2])) darkCount++;
        }
        if (darkCount / h < ROW_DARK_RATIO) break;
        leftCrop = x + 1;
    }

    let rightCrop = 0;
    for (let x = w - 1; x >= 0; x--) {
        let darkCount = 0;
        for (let y = 0; y < h; y++) {
            const i = (y * w + x) * 4;
            if (isDark(pixels[i], pixels[i + 1], pixels[i + 2])) darkCount++;
        }
        if (darkCount / h < ROW_DARK_RATIO) break;
        rightCrop = w - x;
    }

    topCrop = Math.min(topCrop + margin, h);
    bottomCrop = Math.min(bottomCrop + margin, h);
    leftCrop = Math.min(leftCrop + margin, w);
    rightCrop = Math.min(rightCrop + margin, w);

    const contentW = w - leftCrop - rightCrop;
    const contentH = h - topCrop - bottomCrop;

    const origAspect = info.originalWidth / info.originalHeight;
    const detectedAspect = contentW / Math.max(contentH, 1);
    const aspectDrift = Math.abs(detectedAspect - origAspect) / origAspect;

    let sx: number, sy: number, sw: number, sh: number;

    if (contentW > 0 && contentH > 0 && aspectDrift < 0.3) {
        sx = leftCrop;
        sy = topCrop;
        sw = contentW;
        sh = contentH;
    } else {
        if (info.paddedSide === 'bottom') {
            sw = w;
            sh = w * (info.originalHeight / info.originalWidth);
        } else {
            sh = h;
            sw = h * (info.originalWidth / info.originalHeight);
        }
        sx = 0;
        sy = 0;
    }

    // Free scan data early — it's the biggest transient allocation
    releaseCanvas(scanCanvas);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = info.originalWidth;
    outCanvas.height = info.originalHeight;
    const outCtx = outCanvas.getContext('2d');
    if (!outCtx) throw new Error("Could not get canvas context for depadding");

    outCtx.drawImage(img, sx, sy, sw, sh, 0, 0, info.originalWidth, info.originalHeight);

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
 * Stitches processed regions back onto the original image.
 * Returns an Object URL.
 */
export const stitchImage = async (
  originalImageUrl: string,
  regions: Region[]
): Promise<string> => {
  const baseImg = await loadImage(originalImageUrl);
  
  const canvas = document.createElement('canvas');
  canvas.width = baseImg.naturalWidth;
  canvas.height = baseImg.naturalHeight;
  
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  ctx.drawImage(baseImg, 0, 0);

  for (const region of regions) {
    if (region.processedImageBase64 && region.status === 'completed') {
      const hasRestore = (region.restoreBoxes && region.restoreBoxes.length > 0) || !!region.restoreMaskBase64;
      const displayUrl = hasRestore
        ? await renderRegionWithRestore(region.processedImageBase64, region.restoreBoxes, region.restoreMaskBase64)
        : region.processedImageBase64;
      const regionImg = await loadImage(displayUrl);
      
      const x = (region.x / 100) * baseImg.naturalWidth;
      const y = (region.y / 100) * baseImg.naturalHeight;
      const w = (region.width / 100) * baseImg.naturalWidth;
      const h = (region.height / 100) * baseImg.naturalHeight;

      const ax = ((region.anchorX ?? region.x) / 100) * baseImg.naturalWidth;
      const ay = ((region.anchorY ?? region.y) / 100) * baseImg.naturalHeight;
      const aw = ((region.anchorWidth ?? region.width) / 100) * baseImg.naturalWidth;
      const ah = ((region.anchorHeight ?? region.height) / 100) * baseImg.naturalHeight;

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.drawImage(regionImg, ax, ay, aw, ah);
      ctx.restore();

      // Release the temporary restore render if we created one
      if (hasRestore) releaseObjectURL(displayUrl);
    }
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
