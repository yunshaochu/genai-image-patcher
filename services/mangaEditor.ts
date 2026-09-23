import { Region } from '../types';
import { loadImage, releaseObjectURL, previewPixelSize } from './imageUtils';
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

/**
 * Encoding for the patch blobs.
 *
 * PNG is lossless, but its encoder dominated interactive editing: measured
 * 0.4–2.8 s per text edit (the patch canvas grows with the text-overflow
 * margin) against ~10–50 ms for WebP at this quality. Each patch is rebuilt
 * from the original pixels, so the lossy encode never compounds; WebP keeps
 * the alpha the brush layer needs. Switch back to 'image/png' for pixel-exact
 * patches — browsers that cannot encode WebP fall back to PNG on their own.
 */
const PATCH_IMAGE_TYPE = 'image/webp';
const PATCH_IMAGE_QUALITY = 0.94;

const canvasToObjectURL = (
  canvas: HTMLCanvasElement,
  type: string = PATCH_IMAGE_TYPE,
  quality: number = PATCH_IMAGE_QUALITY
): Promise<string> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(URL.createObjectURL(blob));
      else reject(new Error('canvas.toBlob returned null'));
    }, type, quality);
  });

export interface ErasedCacheEntry {
  geomKey: string;
  url: string;
  /** Decoded copy of `url`: every later patch redraws this ROI, so keeping the
   *  element avoids a blob decode (~20 ms measured) per composite. */
  img?: HTMLImageElement;
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

/**
 * Upper bound for the patch's text-overflow margin, as a fraction of the box
 * per side. The margin is what makes an over-long translation visible (the
 * canvas deliberately does not clip it back), but letting it grow without
 * limit turns a big overflow into a canvas many times the box area: slow to
 * encode/decode/redraw, heavy on memory and storage, and — since the patch is
 * positioned at anchor ± margin — it would cover neighbouring bubbles. Half a
 * box per side is far more than needed to show "this does not fit".
 */
const MAX_PATCH_MARGIN_RATIO = 0.5;

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

/**
 * The completed, AI-redrawn bubble whose box contains `region`'s centre
 * (closest centre wins). Used by the aiBubbleBase flow: after a whole-bubble
 * redraw the editor typesets the contained text regions ON TOP of this
 * bubble's patch instead of the original pixels.
 */
export const findCoveringCompletedBubble = (
  regions: Region[],
  region: Region
): Region | undefined => {
  const cx = region.x + region.width / 2;
  const cy = region.y + region.height / 2;
  let best: Region | undefined;
  let bestDist = Infinity;
  for (const b of regions) {
    if (b.id === region.id || b.detectedClass !== 'bubble') continue;
    if (b.status !== 'completed' || !b.processedImageUrl) continue;
    const bx = b.anchorX ?? b.x;
    const by = b.anchorY ?? b.y;
    const bw = b.anchorWidth ?? b.width;
    const bh = b.anchorHeight ?? b.height;
    if (cx < bx || cx > bx + bw || cy < by || cy > by + bh) continue;
    const d = ((bx + bw / 2) - cx) ** 2 + ((by + bh / 2) - cy) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
};

/** True when the region has anything for the compositor to render. */
export const regionNeedsComposite = (region: Region): boolean =>
  !!region.editorErased || !!region.editorWhitedOut || !!getRegionEditorText(region).trim() || !!region.editorBrushUrl;

/**
 * The font size the region typesets at when no explicit size is set — the same
 * auto-fit search the compositor runs (layoutText's binary search), computed
 * from the image dimensions and the region's box.
 *
 * Used to seed the ±5 font-size stepping, so the FIRST step continues from the
 * size that is actually on screen instead of a hard-coded default: the
 * compositor's resolved size is only published after a region has been
 * composited in this session (`computedFontSizes`), which is still empty right
 * after a reload — stepping then used to jump to 16±5.
 */
export const resolveAutoFontSize = (
  region: Region,
  imgW: number,
  imgH: number,
  preferVerticalDefault: boolean,
  /** Pass true when `previewUrl` is a compressed copy of the original (i.e.
   *  `previewUrl !== originalUrl`): the composite — and therefore the font
   *  size — lives in the preview's capped pixel space, not the original's. */
  previewIsCompressed = false
): number | undefined => {
  if (!imgW || !imgH) return undefined;
  const px = previewPixelSize(imgW, imgH, previewIsCompressed);
  const cropW = Math.max(1, Math.round((region.width / 100) * px.w));
  const cropH = Math.max(1, Math.round((region.height / 100) * px.h));
  return layoutText(
    getRegionEditorText(region),
    cropW,
    cropH,
    region.editorStyle,
    preferVerticalDefault
  )?.style.fontSize;
};

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
 * Layer order (bottom → top): base → erase → whiteout → brush → typeset text.
 * The brush is a background touch-up (it covers leftover artwork / original
 * text), so the translation is always drawn last and stays readable on top of
 * it — painting a box white must not swallow its typeset text.
 *
 * When the typeset text overflows the box, the patch canvas is enlarged by
 * the overflow amount (+ slack) instead of clipping, so the user can see the
 * overflow and adjust the font size. `allowMargin=false` forces a crop-sized
 * patch (used for the brush-painter base, whose canvas must stay crop-sized).
 * `includeText=false` produces that same background-only patch (no typeset
 * text) so the painter can draw the text itself, above its strokes.
 *
 * `pythonBackendUrl` points at the unified Python backend; its /erase
 * endpoint (OpenCV inpaint) is preferred over the local fallback eraser.
 *
 * `contextBubbles` are the image's detected `bubble` boxes; they enlarge the
 * erasure ROI (see `resolveEraseRect`).
 */
export const compositeRegionPatch = async (
  imageEl: HTMLImageElement | HTMLCanvasElement,
  region: Region,
  erasedCache: Map<string, ErasedCacheEntry>,
  preferVerticalDefault: boolean,
  pythonBackendUrl?: string,
  contextBubbles?: Region[],
  allowMargin = true,
  includeText = true,
  /** Optional stage sink for the editor's recomposite timing instrumentation. */
  onStage?: (stage: string) => void
): Promise<CompositeResult | null> => {
  if (!regionNeedsComposite(region)) return null;

  const imgW = imageEl instanceof HTMLImageElement ? imageEl.naturalWidth : imageEl.width;
  const imgH = imageEl instanceof HTMLImageElement ? imageEl.naturalHeight : imageEl.height;
  const cropX = (region.x / 100) * imgW;
  const cropY = (region.y / 100) * imgH;
  const cropW = Math.max(1, Math.round((region.width / 100) * imgW));
  const cropH = Math.max(1, Math.round((region.height / 100) * imgH));

  // Layout first: its block bounds decide the overflow margin.
  const text = getRegionEditorText(region);
  const layout = text.trim() ? layoutText(text, cropW, cropH, region.editorStyle, preferVerticalDefault) : null;

  let mx = 0;
  let my = 0;
  if (layout && includeText && allowMargin) {
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
    // Bound the growth (see MAX_PATCH_MARGIN_RATIO): beyond this the patch
    // would be mostly empty canvas covering the neighbouring bubbles.
    mx = Math.min(mx, Math.round(cropW * MAX_PATCH_MARGIN_RATIO));
    my = Math.min(my, Math.round(cropH * MAX_PATCH_MARGIN_RATIO));
  }
  onStage?.('layout+margin');

  const canvas = document.createElement('canvas');
  canvas.width = cropW + mx * 2;
  canvas.height = cropH + my * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');
  ctx.drawImage(imageEl, cropX, cropY, cropW, cropH, mx, my, cropW, cropH);
  onStage?.('base-draw');

  // 1. Erasure (cached per region+geometry — the expensive step)
  if (region.editorErased) {
    const kind: EraseKind = region.detectedClass === 'text_free' ? 'free' : 'bubble';
    // Erase on the enlarged ROI (bubble ∪ text box + margin), not on the bare
    // text box — see resolveEraseRect.
    const roi = resolveEraseRect(region, contextBubbles, imgW, imgH);
    // The base token keeps erased-ROI caches from crossing bases: a region
    // erased on the ORIGINAL pixels must not reuse that cache once it is
    // composited onto an AI-redrawn bubble (aiBubbleBase), and vice versa.
    const key = `${regionGeomKey(region)}|${roi.x},${roi.y},${roi.w},${roi.h}|${region.aiBubbleBase ? 'ai' : 'orig'}`;
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
      // Keep the erased base LOSSLESS: it is computed once per geometry but
      // redrawn into every later patch, so a lossy copy would bleed artifacts
      // into each re-composite.
      const url = await canvasToObjectURL(eraseCanvas, 'image/png');
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
    // Decode once per cache entry — every composite redraws this ROI, and a
    // fresh loadImage() per composite measured ~20 ms.
    if (!entry.img) entry.img = await loadImage(entry.url);
    const erasedImg = entry.img;
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
  onStage?.('erase');

  // 1.5 Brute-force whiteout (text_free quick fix: covers the whole crop —
  // complex background included — so typeset text sits on a clean white box)
  if (region.editorWhitedOut) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(mx, my, cropW, cropH);
  }

  // 2. Brush strokes (crop-aligned; scaled if the box geometry changed since
  // painting). Drawn BEFORE the typeset text: the brush is a background
  // touch-up — it covers leftover original artwork/text — so the translation
  // stays readable on top of it (涂白 must not swallow the translation).
  if (region.editorBrushUrl) {
    try {
      const brushImg = await loadImage(region.editorBrushUrl);
      ctx.drawImage(brushImg, mx, my, cropW, cropH);
    } catch (e) {
      console.warn('Failed to load brush layer for region', region.id, e);
    }
  }

  // 3. Typeset text — last, so it always sits above the erase / whiteout /
  // brush layers. Skipped for the background-only patch (includeText=false)
  // that the brush painter composes on top of.
  if (layout && includeText) {
    ctx.save();
    ctx.translate(mx, my);
    drawTextLayout(ctx, layout, cropW, cropH);
    ctx.restore();
  }
  onStage?.('layers(text/brush)');

  const url = await canvasToObjectURL(canvas);
  onStage?.('encode(webp)');

  return {
    url,
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
