
import { Region, UploadedImage, RestoreBox } from '../types';

export interface PaddingInfo {
    originalWidth: number;
    originalHeight: number;
}

/**
 * Loads an image from a URL into an HTMLImageElement
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

/**
 * Pads an image (from base64) to a 1:1 square canvas.
 * The original image is centered.
 * The extra space is transparent (or white if format enforces it, but we use PNG).
 */
export const padImageToSquare = async (
    base64: string
): Promise<{ base64: string; info: PaddingInfo }> => {
    const img = await loadImage(base64);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const maxDim = Math.max(w, h);

    const canvas = document.createElement('canvas');
    canvas.width = maxDim;
    canvas.height = maxDim;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Could not get canvas context for padding");

    // Clear canvas (transparent)
    ctx.clearRect(0, 0, maxDim, maxDim);

    // Calculate center position
    const x = (maxDim - w) / 2;
    const y = (maxDim - h) / 2;

    ctx.drawImage(img, x, y);

    return {
        base64: canvas.toDataURL('image/png'),
        info: {
            originalWidth: w,
            originalHeight: h
        }
    };
};

/**
 * Extracts the center content from a (potentially resized) square image 
 * and resizes it back to the original dimensions.
 */
export const depadImageFromSquare = async (
    squareBase64: string,
    info: PaddingInfo
): Promise<string> => {
    const img = await loadImage(squareBase64);
    const squareSize = Math.max(img.naturalWidth, img.naturalHeight); // It should be square, but take max just in case
    
    // We assume the content is centered and scaled proportionally to fill the square 
    // in one dimension, matching the logic in padImageToSquare.
    
    // Determine the aspect ratio of the original content
    const origW = info.originalWidth;
    const origH = info.originalHeight;
    
    // Calculate the size of the content *inside* the square image
    // If origW >= origH, contentWidth = squareSize, contentHeight = squareSize * (origH/origW)
    // If origH > origW, contentHeight = squareSize, contentWidth = squareSize * (origW/origH)
    
    let contentW, contentH;
    
    if (origW >= origH) {
        contentW = squareSize;
        contentH = squareSize * (origH / origW);
    } else {
        contentH = squareSize;
        contentW = squareSize * (origW / origH);
    }
    
    // Calculate start position (centered)
    const startX = (squareSize - contentW) / 2;
    const startY = (squareSize - contentH) / 2;
    
    // Draw onto a new canvas of ORIGINAL dimensions
    const canvas = document.createElement('canvas');
    canvas.width = origW;
    canvas.height = origH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Could not get canvas context for depadding");
    
    ctx.drawImage(
        img,
        startX, startY, contentW, contentH, // Source Crop
        0, 0, origW, origH                  // Destination Scale
    );
    
    return canvas.toDataURL('image/png');
};

/**
 * Crops a specific region from the original image
 */
export const cropRegion = async (
  imageElement: HTMLImageElement,
  region: Region
): Promise<string> => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  
  if (!ctx) throw new Error('Could not get canvas context');

  // Convert percentage to pixels
  const x = (region.x / 100) * imageElement.naturalWidth;
  const y = (region.y / 100) * imageElement.naturalHeight;
  const w = (region.width / 100) * imageElement.naturalWidth;
  const h = (region.height / 100) * imageElement.naturalHeight;

  canvas.width = w;
  canvas.height = h;

  ctx.drawImage(
    imageElement,
    x, y, w, h, // Source
    0, 0, w, h  // Destination
  );

  return canvas.toDataURL('image/png');
};

/**
 * Creates a full-size image where only the specified region is visible, 
 * and the rest is masked with white.
 */
export const createMaskedFullImage = (
  imageElement: HTMLImageElement,
  region: Region
): string => {
  const canvas = document.createElement('canvas');
  canvas.width = imageElement.naturalWidth;
  canvas.height = imageElement.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  // Fill white
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Calculate coordinates in pixels
  const x = (region.x / 100) * imageElement.naturalWidth;
  const y = (region.y / 100) * imageElement.naturalHeight;
  const w = (region.width / 100) * imageElement.naturalWidth;
  const h = (region.height / 100) * imageElement.naturalHeight;

  // Draw the specific region from original image onto the white canvas at the same position
  ctx.drawImage(
    imageElement,
    x, y, w, h, // Source rect
    x, y, w, h  // Dest rect (same position)
  );

  return canvas.toDataURL('image/png');
};

/**
 * Creates a full-size image where ALL specified regions are visible, 
 * and the rest is masked with white.
 */
export const createMultiMaskedFullImage = (
  imageElement: HTMLImageElement,
  regions: Region[]
): string => {
  const canvas = document.createElement('canvas');
  canvas.width = imageElement.naturalWidth;
  canvas.height = imageElement.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  // Fill white
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw all regions
  regions.forEach(region => {
      const x = (region.x / 100) * imageElement.naturalWidth;
      const y = (region.y / 100) * imageElement.naturalHeight;
      const w = (region.width / 100) * imageElement.naturalWidth;
      const h = (region.height / 100) * imageElement.naturalHeight;

      ctx.drawImage(
        imageElement,
        x, y, w, h, // Source
        x, y, w, h  // Dest
      );
  });

  return canvas.toDataURL('image/png');
};

/**
 * REVERSE MASKING MODE:
 * Creates a full-size image where the original background is visible,
 * but the selected regions are masked out (White).
 * This tells the AI: "Here is the context (bg), please fill these white boxes."
 * But since our goal is to REPLACE the background, we might be abusing this.
 * However, based on user request: "Only user circled is blank, others are original".
 */
export const createInvertedMultiMaskedFullImage = (
  imageElement: HTMLImageElement,
  regions: Region[]
): string => {
  const canvas = document.createElement('canvas');
  canvas.width = imageElement.naturalWidth;
  canvas.height = imageElement.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  // 1. Draw the Full Original Image
  ctx.drawImage(imageElement, 0, 0);

  // 2. Erase (Fill White) the selected regions
  ctx.fillStyle = '#FFFFFF';
  regions.forEach(region => {
      const x = (region.x / 100) * imageElement.naturalWidth;
      const y = (region.y / 100) * imageElement.naturalHeight;
      const w = (region.width / 100) * imageElement.naturalWidth;
      const h = (region.height / 100) * imageElement.naturalHeight;

      ctx.fillRect(x, y, w, h);
  });

  return canvas.toDataURL('image/png');
};

/**
 * Extracts the crop corresponding to the region from a full-size returned image
 * Applies feathering (alpha blending) to the edges to ensure seamless stitching.
 */
export const extractCropFromFullImage = async (
  fullImageBase64: string,
  region: Region,
  originalWidth: number,
  originalHeight: number,
  opaquePercent: number = 99 // Percentage of the center that remains fully opaque
): Promise<string> => {
  const fullImg = await loadImage(fullImageBase64);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  // We want the resulting crop to be the size specified by the region percentages
  // relative to the *original* image size (which is what the stitching expects).
  const w = (region.width / 100) * originalWidth;
  const h = (region.height / 100) * originalHeight;

  canvas.width = w;
  canvas.height = h;

  // However, the returned image might have been resized by the AI.
  // We assume the AI preserves aspect ratio and the region position percentages are still valid relative to the *returned* image size.
  const resultW = fullImg.naturalWidth;
  const resultH = fullImg.naturalHeight;
  
  const rx = (region.x / 100) * resultW;
  const ry = (region.y / 100) * resultH;
  const rw = (region.width / 100) * resultW;
  const rh = (region.height / 100) * resultH;

  // 1. Draw the raw crop
  ctx.drawImage(
    fullImg,
    rx, ry, rw, rh, // Source from result
    0, 0, w, h // Dest (original expected dimensions)
  );

  // 2. Apply Feathering (Blending Mask) if opaquePercent < 100
  // This uses 'destination-in' composite operation.
  if (opaquePercent < 100) {
      ctx.globalCompositeOperation = 'destination-in';

      // Calculate the start point of the feathering
      // If opaquePercent is 99, we keep center 99% opaque.
      // The remaining 1% is distributed to the edges (0.5% each side).
      
      const p = Math.max(0, Math.min(100, opaquePercent)) / 100;
      const featherRatio = (1 - p) / 2; 
      
      // Horizontal Gradient Mask (Left/Right edges)
      const hGrad = ctx.createLinearGradient(0, 0, w, 0);
      hGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');               // Edge: Transparent
      hGrad.addColorStop(featherRatio, 'rgba(0, 0, 0, 1)');    // Start of content: Opaque
      hGrad.addColorStop(1 - featherRatio, 'rgba(0, 0, 0, 1)'); // End of content: Opaque
      hGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');               // Edge: Transparent

      ctx.fillStyle = hGrad;
      ctx.fillRect(0, 0, w, h);

      // Vertical Gradient Mask (Top/Bottom edges)
      // Applied ON TOP of the horizontal mask result. Since destination-in acts like an intersection,
      // this effectively feathers all 4 sides and corners.
      const vGrad = ctx.createLinearGradient(0, 0, 0, h);
      vGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vGrad.addColorStop(featherRatio, 'rgba(0, 0, 0, 1)');
      vGrad.addColorStop(1 - featherRatio, 'rgba(0, 0, 0, 1)');
      vGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx.fillStyle = vGrad;
      ctx.fillRect(0, 0, w, h);

      // Reset composite operation
      ctx.globalCompositeOperation = 'source-over';
  }

  return canvas.toDataURL('image/png');
};


/**
 * Re-crops a processed region image when the region has been resized in default mode
 * (i.e., no fullAiResultUrl available).
 * Draws the processed image at its original position on a full-size canvas,
 * then crops the new region from that canvas.
 * Areas outside the original processed region become transparent.
 */
export const reCropProcessedImage = async (
  processedImageBase64: string,
  oldRegion: { x: number; y: number; width: number; height: number },
  newRegion: { x: number; y: number; width: number; height: number },
  originalWidth: number,
  originalHeight: number
): Promise<string> => {
  const img = await loadImage(processedImageBase64);

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

  return outCanvas.toDataURL('image/png');
};

/**
 * Renders a processed region image with restore boxes applied.
 * Restore boxes make portions of the processed image transparent,
 * allowing the original image to show through when overlaid.
 * Used for both display (EditorCanvas result mode) and stitching.
 */
export const renderRegionWithRestore = async (
  processedImageBase64: string,
  restoreBoxes?: RestoreBox[],
  restoreMaskBase64?: string
): Promise<string> => {
  const hasBoxes = restoreBoxes && restoreBoxes.length > 0;
  const hasMask = !!restoreMaskBase64;

  if (!hasBoxes && !hasMask) return processedImageBase64;

  const img = await loadImage(processedImageBase64);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  const w = canvas.width;
  const h = canvas.height;

  // Apply box restores
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

  // Apply brush mask (destination-in: mask alpha defines where processed is visible)
  if (hasMask) {
    const maskImg = await loadImage(restoreMaskBase64!);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(maskImg, 0, 0, w, h);
  }

  return canvas.toDataURL('image/png');
};

/**
 * Stitches processed regions back onto the original image
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

  // Draw original
  ctx.drawImage(baseImg, 0, 0);

  // Draw processed regions on top
  for (const region of regions) {
    if (region.processedImageBase64 && region.status === 'completed') {
      const hasRestore = (region.restoreBoxes && region.restoreBoxes.length > 0) || !!region.restoreMaskBase64;
      const displayBase64 = hasRestore
        ? await renderRegionWithRestore(region.processedImageBase64, region.restoreBoxes, region.restoreMaskBase64)
        : region.processedImageBase64;
      const regionImg = await loadImage(displayBase64);
      
      const x = (region.x / 100) * baseImg.naturalWidth;
      const y = (region.y / 100) * baseImg.naturalHeight;
      const w = (region.width / 100) * baseImg.naturalWidth;
      const h = (region.height / 100) * baseImg.naturalHeight;

      ctx.drawImage(regionImg, x, y, w, h);
    }
  }

  return canvas.toDataURL('image/png');
};

/**
 * REVERSE STITCHING:
 * Base is the AI Generated Image (Full).
 * We paste the ORIGINAL image regions on top.
 * This effectively keeps the original characters (regions) but accepts the AI's new background.
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

  // 1. Draw AI Result as Base (Background)
  // Assuming AI output matches original dimensions or we stretch it
  ctx.drawImage(aiImg, 0, 0, canvas.width, canvas.height);

  // 2. Draw Original Regions on top (Keeping them "Original")
  for (const region of regions) {
      const x = (region.x / 100) * originalImg.naturalWidth;
      const y = (region.y / 100) * originalImg.naturalHeight;
      const w = (region.width / 100) * originalImg.naturalWidth;
      const h = (region.height / 100) * originalImg.naturalHeight;

      ctx.drawImage(
        originalImg,
        x, y, w, h, // Source from Original
        x, y, w, h  // Dest on Canvas
      );
  }

  return canvas.toDataURL('image/png');
};

export const readFileAsDataURL = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

// Helper to strip data:image/png;base64, prefix
export const extractBase64Data = (dataUrl: string): string => {
  return dataUrl.split(',')[1];
};

// Helper to download an image from a remote URL and convert to Base64 (needed for OpenAI URL responses)
/**
 * Compresses an image (base64) for use as a lightweight reference/context image.
 * Reduces file size while keeping enough clarity for visual context.
 */
export const compressImage = async (
  base64: string,
  options: { maxWidth?: number; maxHeight?: number; quality?: number } = {}
): Promise<string> => {
  const { maxWidth = 1024, maxHeight = 1024, quality = 0.7 } = options;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return base64;

  const img = await loadImage(base64);
  let w = img.naturalWidth;
  let h = img.naturalHeight;

  if (w === 0 || h === 0) return base64;

  if (w > maxWidth || h > maxHeight) {
    const ratio = Math.min(maxWidth / w, maxHeight / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }

  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(img, 0, 0, w, h);

  return canvas.toDataURL('image/jpeg', quality);
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
    // Fallback: Return the URL itself if it can be used in an <img> tag directly
    return url;
  }
};

/**
 * Comparator for Natural Sort Order (e.g., 1.png, 2.png, 10.png)
 */
export const naturalSortCompare = (a: UploadedImage, b: UploadedImage) => {
  return new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare(a.file.name, b.file.name);
};