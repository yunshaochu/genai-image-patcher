

import { AppConfig, Region } from "../types";
import { loadImage } from "./imageUtils";

// API Response Types based on API.md
interface ApiTextBlock {
  xyxy: [number, number, number, number]; // [x1, y1, x2, y2]
  prob: number;
}

interface ApiDetectionResponse {
  success: boolean;
  image_size: {
    width: number;
    height: number;
  };
  text_blocks: ApiTextBlock[];
  error?: string;
}

interface ApiOcrResponse {
    text: string;
    success: boolean;
    error?: string;
}

/**
 * Resizes an image (from Base64/URL) to a target maximum dimension and returns a Blob.
 * Client-side optimization: Reduces network payload and server processing time.
 */
const prepareImageForUpload = async (imageUrl: string, maxDimension: number = 1500): Promise<Blob> => {
  const img = await loadImage(imageUrl);
  
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  
  // Downscale if too large to save bandwidth
  if (w > maxDimension || h > maxDimension) {
     const ratio = Math.min(maxDimension / w, maxDimension / h);
     w = Math.round(w * ratio);
     h = Math.round(h * ratio);
  }
  
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("Could not get canvas context for resizing");
  
  ctx.drawImage(img, 0, 0, w, h);
  
  return new Promise<Blob>((resolve, reject) => {
    // Convert to JPEG with 0.85 quality for optimal balance between size and quality
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Failed to create image blob"));
    }, 'image/jpeg', 0.85);
  });
};

/**
 * Calls the Python backend to recognize text in a cropped region.
 */
export const recognizeText = async (
    imageBase64: string,
    config: AppConfig
): Promise<string> => {
    const apiUrl = config.ocrApiUrl;
    if (!apiUrl) throw new Error("OCR API URL is not configured.");

    // 1. Prepare Image
    // Use smaller max dimension for OCR crops usually
    const imageBlob = await prepareImageForUpload(imageBase64, 1024);

    // 2. Build FormData
    const formData = new FormData();
    formData.append('image', imageBlob, 'crop.jpg');

    // 3. Send Request
    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: formData,
        mode: 'cors'
    });

    if (!response.ok) {
        throw new Error(`OCR API Error: ${response.statusText}`);
    }

    const data: ApiOcrResponse = await response.json();
    if (!data.success) {
        throw new Error(data.error || "OCR failed");
    }

    return data.text;
};

/**
 * Calls the Python backend to detect text bubbles in the image.
 * Uses standard Multipart/FormData upload (Method 1 in API docs).
 */
export const detectBubbles = async (
  imageBase64: string,
  config: AppConfig
): Promise<Region[]> => {
  const apiUrl = config.detectionApiUrl;

  if (!apiUrl) {
     throw new Error("Detection API URL is not configured.");
  }

  try {
    // 1. Prepare Image (Resize & Compress)
    const imageBlob = await prepareImageForUpload(imageBase64);
    
    // 2. Build FormData
    const formData = new FormData();
    formData.append('image', imageBlob, 'image.jpg');
    formData.append('return_mask', 'false');

    // 3. Send Request
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json', // Explicitly expect JSON response
      },
      body: formData,
      mode: 'cors' // Standard CORS request
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Detection Service Error (${response.status}): ${errorText}`);
    }

    const data: ApiDetectionResponse = await response.json();

    if (!data.success) {
      throw new Error(data.error || "Detection service reported failure");
    }

    const { width, height } = data.image_size;
    
    // Safety check
    if (!width || !height) {
        console.warn("Detection API returned invalid image size", data.image_size);
        return [];
    }
    
    // Configuration for adjustments
    const inflation = (config.detectionInflationPercent ?? 0) / 100;
    const offX = (config.detectionOffsetXPercent ?? 0) / 100;
    const offY = (config.detectionOffsetYPercent ?? 0) / 100;
    const confThreshold = (config.detectionConfidenceThreshold ?? 0) / 100;

    // Map API result to internal Region format
    const regions: Region[] = [];
    
    data.text_blocks.forEach((block) => {
      // 1. Check Confidence
      if (block.prob < confThreshold) {
          return;
      }

      // API returns absolute pixel coordinates [left, top, right, bottom]
      const [x1, y1, x2, y2] = block.xyxy;
      
      let wPx = x2 - x1;
      let hPx = y2 - y1;
      
      // Calculate Center
      let cx = x1 + wPx / 2;
      let cy = y1 + hPx / 2;

      // 2. Apply Inflation (Scale width/height)
      // Inflation applies to the box size relative to its center
      const newWPx = wPx * (1 + inflation);
      const newHPx = hPx * (1 + inflation);
      
      // 3. Apply Offset (Shift center based on *original* box size percentage)
      // Standard practice: offset is percentage of the dimension
      cx = cx + (wPx * offX);
      cy = cy + (hPx * offY);

      // Re-calculate Top/Left based on new Center and new Size
      const newX1 = cx - newWPx / 2;
      const newY1 = cy - newHPx / 2;

      // Convert to percentages (0-100) relative to the processed image size
      // We clamp negative values to 0 to prevent issues, but allow >100 if the UI handles it (usually better to clamp)
      const x = Math.max(0, Math.min(100, (newX1 / width) * 100));
      const y = Math.max(0, Math.min(100, (newY1 / height) * 100));
      
      // For Width/Height, ensure they don't exceed image bounds starting from X/Y
      // But simple calculation is usually enough:
      let w = (newWPx / width) * 100;
      let h = (newHPx / height) * 100;
      
      // Clamp W/H so x+w <= 100 and y+h <= 100
      if (x + w > 100) w = 100 - x;
      if (y + h > 100) h = 100 - y;

      if (w > 0.5 && h > 0.5) { // Filter out tiny boxes
        regions.push({
            id: crypto.randomUUID(),
            x,
            y,
            width: w,
            height: h,
            type: 'rect',
            status: 'pending',
            source: 'auto'
        });
      }
    });

    return regions;

  } catch (error: any) {
    console.error("Auto-detection error:", error);
    
    const msg = error.message || "";
    if (msg.includes('Failed to fetch') || error.name === 'TypeError') {
       throw new Error(`Unable to connect to Detection API.\nPlease ensure the backend is running and CORS allows the request.`);
    }
    
    throw error;
  }
};