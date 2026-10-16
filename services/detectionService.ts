

import { AppConfig, Region, RegionTextMask, DETECTION_CONFIDENCE_FLOOR } from "../types";

// API Response Types based on comic-detector RT-DETR API (docs/API_RTDTR.md)
interface ApiDetection {
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
  class_id: number;
  class_name: 'bubble' | 'text_bubble' | 'text_free';
  confidence: number;
  /** comic-text-detector 像素掩码（后端开启文字掩码时才有）：base64 PNG +
   *  掩码在检测图里的位置/尺寸（检测图可能被缩放，单位是缩放后的像素）。 */
  text_mask?: string;
  mask_origin?: [number, number];
  mask_size?: [number, number];
}

interface ApiDetectionResponse {
  success: boolean;
  image_size: {
    width: number;
    height: number;
  };
  detections: ApiDetection[];
  error?: string;
}

/**
 * Resizes an image (from Base64/URL) to a target maximum dimension and returns a Blob.
 * Client-side optimization: Reduces network payload and server processing time.
 *
 * Uses createImageBitmap (with native resize) instead of HTMLImageElement +
 * canvas.drawImage. On Chrome this is roughly 30-50% faster and skips the
 * extra HTMLImageElement allocation.
 */
const prepareImageForUpload = async (imageUrl: string, maxDimension: number = 1500): Promise<Blob> => {
  const blob = await (await fetch(imageUrl)).blob();
  let bitmap = await createImageBitmap(blob);

  if (bitmap.width > maxDimension || bitmap.height > maxDimension) {
    const ratio = Math.min(maxDimension / bitmap.width, maxDimension / bitmap.height);
    const w = Math.round(bitmap.width * ratio);
    const h = Math.round(bitmap.height * ratio);
    bitmap.close();
    bitmap = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  }

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error("Could not get canvas context for resizing");
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  return new Promise<Blob>((resolve, reject) => {
    // Convert to JPEG with 0.85 quality for optimal balance between size and quality
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("Failed to create image blob"));
    }, 'image/jpeg', 0.85);
  });
};

/**
 * 丢弃「完全被另一个框包围」的外层框。
 *
 * 检测器经常吐出一颗松散的"外层框"套住一个或多个紧凑的"内层框"（典型是
 * `bubble` 气泡轮廓把它的 `text_bubble` 文字框整个包住）。外层框覆盖的是
 * 完全相同的内容、但边界更粗；一旦内部存在更精确的框，外层框就是冗余的；
 * 若它套住了两个以上内层框，那更说明它只是一个粗略的分组框，而不是一块独立
 * 的内容区域。因此这里只保留处于最内层的框。
 *
 * ⚠ 关键结论（改检测相关逻辑前先看这里）：**`bubble` 气泡框就是被这里当作
 * "外框"过滤掉的**。所以正常情况下带文字的 `bubble` 根本不会出现在结果里，
 * 也就永远不可能是 AI 重绘单元（见 types.ts 的 isRegionPaintable）——只有
 * "空气泡"（没套住任何文字框）才会残留下来，作为 contextOnly 上下文标记。
 * 这也正是当初去掉「AI 重绘区域 = 气泡框 / 文字框」选择器的原因：气泡框没有
 * 被画的余地。
 *
 * 检测坐标是近似值，所以判定"包围"时允许内层框最多探出外层框尺寸的一小部分；
 * 同时要求外层框面积严格更大，避免两个几乎重合的框（真正的重复框）被同时删掉。
 */
const dropEnclosingBoxes = (detections: ApiDetection[]): ApiDetection[] => {
  const TOLERANCE = 0.02; // 内层框允许探出外层框尺寸的 2%
  const area = (d: ApiDetection) => (d.bbox[2] - d.bbox[0]) * (d.bbox[3] - d.bbox[1]);
  const contains = (outer: ApiDetection, inner: ApiDetection): boolean => {
    const [ox1, oy1, ox2, oy2] = outer.bbox;
    const [ix1, iy1, ix2, iy2] = inner.bbox;
    const tolX = Math.max(2, (ox2 - ox1) * TOLERANCE);
    const tolY = Math.max(2, (oy2 - oy1) * TOLERANCE);
    return ix1 >= ox1 - tolX && iy1 >= oy1 - tolY &&
           ix2 <= ox2 + tolX && iy2 <= oy2 + tolY;
  };
  return detections.filter((outer) => {
    const outerArea = area(outer);
    if (outerArea <= 0) return true;
    return !detections.some((inner) =>
      inner !== outer &&
      area(inner) > 0 &&
      area(inner) < outerArea &&
      contains(outer, inner)
    );
  });
};

/**
 * Calls the Python backend to detect text bubbles in the image.
 * Uses standard Multipart/FormData upload (Method 1 in API docs).
 */
export const detectBubbles = async (
  imageBase64: string,
  config: AppConfig
): Promise<Region[]> => {
  const baseUrl = config.pythonBackendUrl?.replace(/\/+$/, '');
  const apiUrl = baseUrl ? `${baseUrl}/detect` : '';

  if (!apiUrl) {
     throw new Error("Python backend URL is not configured.");
  }

  try {
    // 1. Prepare Image (Resize & Compress)
    const imageBlob = await prepareImageForUpload(imageBase64);

    // 2. Build FormData
    const formData = new FormData();
    formData.append('image', imageBlob, 'image.jpg');
    // Server-side confidence threshold: ALWAYS the floor (0.3), never the user's
    // filter threshold. Detection must fetch every box down to the floor so the
    // front-end confidence filter (see types.ts → isRegionAboveThreshold) can
    // reveal them live when the user lowers the slider — a high pre-filter here
    // would make that slider one-way. The floor also keeps truly low-score
    // RT-DETR noise out of the payload.
    const confThreshold = DETECTION_CONFIDENCE_FLOOR / 100;
    formData.append('conf_threshold', String(confThreshold));
    // Request all three classes. text_bubble = 气泡内文本, text_free = 气泡外文本
    // are the editable text areas; bubble = 整颗气泡, kept as context-only
    // markers (reserved for later use, e.g. per-bubble styling).
    formData.append('filter_classes', 'bubble,text_bubble,text_free');
    // 文字掩码精准擦除开关：开后端 comic-text-detector（首次会触发模型加载，
    // 检测变慢）。必须显式传 false——后端默认值为 true。
    formData.append('with_masks', String(!!config.detectionTextMask));

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

    // 1. Check Confidence (safety net — the server already filtered at
    // conf_threshold, but a custom URL may ignore the parameter). Done before
    // containment so a filtered-out stray box can't suppress a box that would
    // otherwise survive.
    const confident = data.detections.filter((det) => det.confidence >= confThreshold);

    // 2. Drop outer boxes fully enclosing inner ones — keeps the precise inner
    // boxes (see dropEnclosingBoxes).
    const keptDetections = dropEnclosingBoxes(confident);

    // Map API result to internal Region format
    const regions: Region[] = [];

    /** 检测返回的掩码换算成 Region.textMask：掩码与 bbox 同一坐标系（检测图
     *  的像素，可能被缩放过），统一存成整页百分比，擦除时按目标图尺寸还原
     *  即可对齐。 */
    const buildTextMask = (det: ApiDetection): RegionTextMask | undefined => {
      if (!det.text_mask || !det.mask_origin || !det.mask_size) return undefined;
      const [ox, oy] = det.mask_origin;
      const [mw, mh] = det.mask_size;
      if (!(mw > 0 && mh > 0) || !(width > 0 && height > 0)) return undefined;
      return {
        png: det.text_mask,
        rect: {
          x: (ox / width) * 100,
          y: (oy / height) * 100,
          w: (mw / width) * 100,
          h: (mh / height) * 100,
        },
      };
    };

    keptDetections.forEach((det) => {
      // API returns absolute pixel coordinates [left, top, right, bottom]
      const [x1, y1, x2, y2] = det.bbox;
      
      let wPx = x2 - x1;
      let hPx = y2 - y1;
      
      // Calculate Center
      let cx = x1 + wPx / 2;
      let cy = y1 + hPx / 2;

      // 3. Apply Inflation (Scale width/height)
      // Inflation applies to the box size relative to its center
      const newWPx = wPx * (1 + inflation);
      const newHPx = hPx * (1 + inflation);
      
      // 4. Apply Offset (Shift center based on *original* box size percentage)
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
            source: 'auto',
            detectedClass: det.class_name,
            // 逐框置信度（0-1）：前端「置信度过滤」据此实时取舍 ——
            // 见 types.ts → isRegionAboveThreshold / effectiveDetectionThreshold。
            confidence: det.confidence,
            // 'bubble' outlines are context-only markers: never sent to the
            // AI redraw pipeline, not editable text areas.
            // NOTE: a bubble that ENCLOSED a text box was already dropped above
            // by dropEnclosingBoxes (it is the redundant "outer box"), so only
            // empty bubbles ever reach this line.
            contextOnly: det.class_name === 'bubble',
            textMask: buildTextMask(det),
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