import { Region, UploadedImage } from '../types';

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
      const regionImg = await loadImage(region.processedImageBase64);
      
      const x = (region.x / 100) * baseImg.naturalWidth;
      const y = (region.y / 100) * baseImg.naturalHeight;
      const w = (region.width / 100) * baseImg.naturalWidth;
      const h = (region.height / 100) * baseImg.naturalHeight;

      ctx.drawImage(regionImg, x, y, w, h);
    }
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