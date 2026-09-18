import { Region } from '../types';
import { loadImage, releaseObjectURL } from './imageUtils';
import { eraseTextInCanvasAuto, EraseKind } from './textErase';
import { layoutText, drawTextLayout, measureLayoutBlock } from './textLayout';

/**
 * Compositing pipeline for the in-place manga text editor.
 *
 * For each edited region the final patch is rebuilt from scratch:
 *   original crop  →  flood-fill erasure (optional)  →  whiteout (optional)
 *   →  typeset text  →  brush layer
 *
 * Everything is derived from data stored on the Region, so any layer can be
 * toggled (e.g. undo erasure while keeping the typeset text) and the patch
 * re-rendered deterministically. The erased base is cached per
 * region+geometry because erasure is the only expensive step.
 */

const canvasToObjectURL = (canvas: HTMLCanvasElement): Promise<string> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(URL.createObjectURL(blob));
      else reject(new Error('canvas.toBlob returned null'));
    }, 'image/png');
  });

export interface ErasedCacheEntry {
  geomKey: string;
  url: string;
  /** Offset of the region crop inside the cached ROI image (px). */
  dx: number;
  dy: number;
  /** Cached ROI size (px). */
  w: number;
  h: number;
}

const regionGeomKey = (region: Region): string =>
  `${region.x.toFixed(3)},${region.y.toFixed(3)},${region.width.toFixed(3)},${region.height.toFixed(3)}`;

/**
 * Margin (px) added around the erase box. `whiten_regions.py` uses
 * `--expand 4` on the bubble box; 8 gives anti-aliased outlines a bit more
 * room without dragging in unrelated art.
 */
const ERASE_EXPAND_PX = 8;

/** Backend eraser tuning, matching whiten_regions.py's recommended values. */
const ERASE_DILATE = 5;
const ERASE_INPAINT_RADIUS = 7;

/** A bubble box is only used when it isn't wildly bigger than the text box
 *  (guards against a mis-detected page-spanning "bubble"). */
const MAX_BUBBLE_AREA_RATIO = 16;

const regionToPx = (r: Region, imgW: number, imgH: number) => ({
  x1: (r.x / 100) * imgW,
  y1: (r.y / 100) * imgH,
  x2: ((r.x + r.width) / 100) * imgW,
  y2: ((r.y + r.height) / 100) * imgH,
});

export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Erase ROI in image pixels = union(region box, parent bubble box) grown by
 * ERASE_EXPAND_PX and clamped to the image.
 *
 * Why this matters: the eraser's `_edge_reachable` starts its flood fill FROM
 * THE ROI BORDER, so the border decides what counts as "outside". With a crop
 * that ends exactly on the text box, the border lands on bubble outline or on
 * the text itself — outline and text become indistinguishable and either the
 * outline gets eaten or edge text survives. Giving the crop the whole bubble
 * plus a margin of outside background reproduces the geometry
 * whiten_regions.py works with (bubble box + `--expand`).
 *
 * `contextBubbles` are the detected `bubble`-class boxes of the same image
 * (stored as context-only regions). Matching = the bubble whose box contains
 * the region centre and whose own centre is closest (same idea as
 * `match_bubbles`), so manually drawn boxes benefit too.
 */
export const resolveEraseRect = (
  region: Region,
  contextBubbles: Region[] | undefined,
  imgW: number,
  imgH: number
): PxRect => {
  const self = regionToPx(region, imgW, imgH);
  const selfArea = Math.max(1, (self.x2 - self.x1) * (self.y2 - self.y1));
  let { x1, y1, x2, y2 } = self;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;

  let best: ReturnType<typeof regionToPx> | null = null;
  let bestDist = Infinity;
  for (const b of contextBubbles ?? []) {
    if (b.id === region.id || b.detectedClass !== 'bubble') continue;
    const bb = regionToPx(b, imgW, imgH);
    // Region centre must be inside the bubble box.
    if (cx < bb.x1 || cx > bb.x2 || cy < bb.y1 || cy > bb.y2) continue;
    if ((bb.x2 - bb.x1) * (bb.y2 - bb.y1) > selfArea * MAX_BUBBLE_AREA_RATIO) continue;
    const d = ((bb.x1 + bb.x2) / 2 - cx) ** 2 + ((bb.y1 + bb.y2) / 2 - cy) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = bb;
    }
  }
  if (best) {
    x1 = Math.min(x1, best.x1);
    y1 = Math.min(y1, best.y1);
    x2 = Math.max(x2, best.x2);
    y2 = Math.max(y2, best.y2);
  }

  x1 = Math.max(0, Math.floor(x1 - ERASE_EXPAND_PX));
  y1 = Math.max(0, Math.floor(y1 - ERASE_EXPAND_PX));
  x2 = Math.min(imgW, Math.ceil(x2 + ERASE_EXPAND_PX));
  y2 = Math.min(imgH, Math.ceil(y2 + ERASE_EXPAND_PX));
  return {
    x: x1,
    y: y1,
    w: Math.max(1, Math.round(x2 - x1)),
    h: Math.max(1, Math.round(y2 - y1)),
  };
};

/** Effective text for a region: user edit wins, OCR text is the fallback.
 *  Frozen regions (translation held back) suppress the OCR fallback — they
 *  must render the untouched original, not a typeset preview. */
export const getRegionEditorText = (region: Region): string =>
  region.editorText ?? (region.editorFrozenText?.trim() ? '' : region.ocrText ?? '');

/** True when the region has anything for the compositor to render. */
export const regionNeedsComposite = (region: Region): boolean =>
  !!region.editorErased || !!region.editorWhitedOut || !!getRegionEditorText(region).trim() || !!region.editorBrushUrl;

export interface CompositeResult {
  url: string;
  /** Resolved font size (also when auto-fit) — shown in the panel as reference. */
  fontSize?: number;
  /** Overflow margin beyond the anchor box, as % of the FULL image size.
   *  The patch canvas extends this far past the crop on every side so text
   *  that overflows the box stays visible (user can then shrink font size). */
  marginXPct: number;
  marginYPct: number;
}

/**
 * Build the composited patch for a region. Returns null when the region has
 * no editor content (caller should then restore its un-edited state).
 *
 * When the typeset text overflows the box, the patch canvas is enlarged by
 * the overflow amount (+ slack) instead of clipping, so the user can see the
 * overflow and adjust the font size. `allowMargin=false` forces a crop-sized
 * patch (used for the brush-painter base, whose canvas must stay crop-sized).
 *
 * `pythonBackendUrl` points at the unified Python backend; its /erase
 * endpoint (OpenCV inpaint) is preferred over the local fallback eraser.
 *
 * `contextBubbles` are the image's detected `bubble` boxes; they enlarge the
 * erasure ROI (see `resolveEraseRect`).
 */
export const compositeRegionPatch = async (
  imageEl: HTMLImageElement,
  region: Region,
  erasedCache: Map<string, ErasedCacheEntry>,
  preferVerticalDefault: boolean,
  pythonBackendUrl?: string,
  contextBubbles?: Region[],
  allowMargin = true
): Promise<CompositeResult | null> => {
  if (!regionNeedsComposite(region)) return null;

  const imgW = imageEl.naturalWidth;
  const imgH = imageEl.naturalHeight;
  const cropX = (region.x / 100) * imgW;
  const cropY = (region.y / 100) * imgH;
  const cropW = Math.max(1, Math.round((region.width / 100) * imgW));
  const cropH = Math.max(1, Math.round((region.height / 100) * imgH));

  // Layout first: its block bounds decide the overflow margin.
  const text = getRegionEditorText(region);
  const layout = text.trim() ? layoutText(text, cropW, cropH, region.editorStyle, preferVerticalDefault) : null;

  let mx = 0;
  let my = 0;
  if (layout && allowMargin) {
    const { blockW, blockH } = measureLayoutBlock(layout);
    const pad = layout.style.padding;
    const innerW = Math.max(8, cropW - pad * 2);
    const innerH = Math.max(8, cropH - pad * 2);
    // The block is centered in the box, so overflow spills evenly on both
    // sides. Slack (only when overflowing) covers punctuation overhang
    // (em-box offsets, rotations).
    const overX = Math.max(0, Math.ceil((blockW - innerW) / 2));
    const overY = Math.max(0, Math.ceil((blockH - innerH) / 2));
    const slack = overX > 0 || overY > 0 ? Math.ceil(layout.style.fontSize * 0.35) : 0;
    mx = overX + slack;
    my = overY + slack;
  }

  const canvas = document.createElement('canvas');
  canvas.width = cropW + mx * 2;
  canvas.height = cropH + my * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');
  ctx.drawImage(imageEl, cropX, cropY, cropW, cropH, mx, my, cropW, cropH);

  // 1. Erasure (cached per region+geometry — the expensive step)
  if (region.editorErased) {
    const kind: EraseKind = region.detectedClass === 'text_free' ? 'free' : 'bubble';
    // Erase on the enlarged ROI (bubble ∪ text box + margin), not on the bare
    // text box — see resolveEraseRect.
    const roi = resolveEraseRect(region, contextBubbles, imgW, imgH);
    const key = `${regionGeomKey(region)}|${roi.x},${roi.y},${roi.w},${roi.h}`;
    let entry = erasedCache.get(region.id);
    if (!entry || entry.geomKey !== key) {
      const eraseCanvas = document.createElement('canvas');
      eraseCanvas.width = roi.w;
      eraseCanvas.height = roi.h;
      const ectx = eraseCanvas.getContext('2d');
      if (!ectx) throw new Error('Could not get canvas context');
      ectx.drawImage(imageEl, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
      await eraseTextInCanvasAuto(eraseCanvas, pythonBackendUrl, kind, {
        kind,
        dilate: ERASE_DILATE,
        inpaintRadius: ERASE_INPAINT_RADIUS,
      });
      const url = await canvasToObjectURL(eraseCanvas);
      if (entry) releaseObjectURL(entry.url);
      entry = {
        geomKey: key,
        url,
        dx: Math.round(cropX - roi.x),
        dy: Math.round(cropY - roi.y),
        w: roi.w,
        h: roi.h,
      };
      erasedCache.set(region.id, entry);
    }
    const erasedImg = await loadImage(entry.url);
    // Paste-back isolation: only the region's own bbox is taken from the
    // erased ROI (same guard as whiten_regions.py's final `final[y1:y2,x1:x2]
    // = erased[...]`). Whatever the eraser did outside the box is discarded,
    // so a leaky flood fill can never damage the outline or a neighbour.
    const sx = Math.max(0, entry.dx);
    const sy = Math.max(0, entry.dy);
    const sw = Math.min(cropW, entry.w - sx);
    const sh = Math.min(cropH, entry.h - sy);
    if (sw > 0 && sh > 0) {
      ctx.drawImage(
        erasedImg,
        sx, sy, sw, sh,
        mx + Math.max(0, -entry.dx), my + Math.max(0, -entry.dy), sw, sh
      );
    }
  }

  // 1.5 Brute-force whiteout (text_free quick fix: covers the whole crop —
  // complex background included — so typeset text sits on a clean white box)
  if (region.editorWhitedOut) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(mx, my, cropW, cropH);
  }

  // 2. Typeset text
  if (layout) {
    ctx.save();
    ctx.translate(mx, my);
    drawTextLayout(ctx, layout, cropW, cropH);
    ctx.restore();
  }

  // 3. Brush strokes on top (crop-aligned; scaled if the box geometry
  // changed since painting)
  if (region.editorBrushUrl) {
    try {
      const brushImg = await loadImage(region.editorBrushUrl);
      ctx.drawImage(brushImg, mx, my, cropW, cropH);
    } catch (e) {
      console.warn('Failed to load brush layer for region', region.id, e);
    }
  }

  return {
    url: await canvasToObjectURL(canvas),
    fontSize: layout?.style.fontSize,
    marginXPct: (mx / imgW) * 100,
    marginYPct: (my / imgH) * 100,
  };
};

/** Release a region's cached erased base (e.g. when the region is deleted). */
export const releaseErasedCacheEntry = (
  regionId: string,
  erasedCache: Map<string, ErasedCacheEntry>
): void => {
  const entry = erasedCache.get(regionId);
  if (entry) {
    releaseObjectURL(entry.url);
    erasedCache.delete(regionId);
  }
};
