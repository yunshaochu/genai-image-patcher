

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
  /** /detect 顺手量到的原文墨色（后端已用整页 CTD 掩码从原图统计好）。 */
  ink_color?: string;
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
const detArea = (d: ApiDetection): number =>
  (d.bbox[2] - d.bbox[0]) * (d.bbox[3] - d.bbox[1]);

/** 两个检测框的交并比（0-1）。用来判定「是不是同一块地方」。 */
const detIou = (a: ApiDetection, b: ApiDetection): number => {
  const ix = Math.min(a.bbox[2], b.bbox[2]) - Math.max(a.bbox[0], b.bbox[0]);
  const iy = Math.min(a.bbox[3], b.bbox[3]) - Math.max(a.bbox[1], b.bbox[1]);
  if (ix <= 0 || iy <= 0) return 0;
  const inter = ix * iy;
  const union = detArea(a) + detArea(b) - inter;
  return union > 0 ? inter / union : 0;
};

/**
 * 完全重合的框只留一个。
 *
 * dropEnclosingBoxes 刻意要求外层框「严格更大」（怕把两个几乎重合的真重复框一起
 * 删掉），于是**等面积的重复框谁也删不掉** —— 而检测器确实会吐这种情况：同一块
 * 文字既被判成 text_bubble 又被判成 text_free，或者气泡轮廓与它的文字框坐标一模
 * 一样。这类框在画布上叠成两层，编辑 / 翻译 / 擦除都会做两遍。
 *
 * 判定用交并比 ≥ 0.9：只有「几乎完全盖住彼此」才算重复，不会误伤「气泡框（大）+
 * 里面的文字框（小）」那种正常嵌套。
 * 保留优先级：text_bubble > text_free > bubble —— 气泡轮廓在套住文字时本来就是要
 * 被丢掉的外层框（见 dropEnclosingBoxes）。
 */
const CLASS_PRIORITY: Record<ApiDetection['class_name'], number> = {
  text_bubble: 0,
  text_free: 1,
  bubble: 2,
};

const dropDuplicateDetections = (detections: ApiDetection[]): ApiDetection[] => {
  const DUP_IOU = 0.9;
  const byPriority = [...detections].sort((a, b) =>
    CLASS_PRIORITY[a.class_name] - CLASS_PRIORITY[b.class_name] || detArea(b) - detArea(a));
  const kept = new Set<ApiDetection>();
  for (const d of byPriority) {
    // 退化框（宽或高为 0）算不出交并比，原样放行 —— 后面按 w/h 的过滤会收拾它。
    if (detArea(d) <= 0) { kept.add(d); continue; }
    if ([...kept].some(k => detIou(k, d) >= DUP_IOU)) continue;
    kept.add(d);
  }
  // 保持传入顺序：区域清单 / 编号是照着检测顺序生成的。
  return detections.filter(d => kept.has(d));
};

const dropEnclosingBoxes = (detections: ApiDetection[]): ApiDetection[] => {
  const TOLERANCE = 0.02; // 内层框允许探出外层框尺寸的 2%
  const area = detArea;
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
    // 文字掩码：精准擦除要它来擦，自动取色要它来量墨色，所以两者任一开着都
    // 要在检测阶段拿掩码。注意「拿到掩码」不等于「用它擦」：擦除是否用掩码
    // 只由 detectionTextMask 决定（见 eraseRegionRoi）。必须显式传 false——
    // 后端默认值为 true。
    formData.append('with_masks', String(!!(config.detectionTextMask || config.editorAutoTextColor)));

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
    // 3. 完全重合的重复框只留一个（等面积的框在上一步谁也删不掉，见
    //    dropDuplicateDetections）。
    const keptDetections = dropDuplicateDetections(dropEnclosingBoxes(confident));

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
            // /detect 已经在后端量好原文墨色；旧版后端没有这个字段时 undefined。
            inkColor: det.ink_color,
            // 自动取色开着时直接把实测墨色落到样式上：dock 的色块从检测完成
            // 这一刻就显示真实字色，不必等用户写了字、第一次合成写回之后。
            ...(config.editorAutoTextColor && det.ink_color
              ? {
                  editorStyle: {
                    color: det.ink_color,
                    outlineColor: undefined,
                    outlineWidth: undefined,
                    colorSource: 'auto' as const,
                  },
                }
              : {}),
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