import { Region } from '../types';
import { loadImage, releaseObjectURL } from './imageUtils';
import { eraseTextInCanvasAuto } from './textErase';
import { layoutText, drawTextLayout, measureLayoutBlock } from './textLayout';

/**
 * Compositing pipeline for the in-place manga text editor.
 *
 * For each edited region the final patch is rebuilt from scratch:
 *   original crop  →  flood-fill erasure (optional)  →  typeset text  →  brush layer
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
}

const regionGeomKey = (region: Region): string =>
  `${region.x.toFixed(3)},${region.y.toFixed(3)},${region.width.toFixed(3)},${region.height.toFixed(3)}`;

/** Effective text for a region: user edit wins, OCR text is the fallback. */
export const getRegionEditorText = (region: Region): string =>
  region.editorText ?? region.ocrText ?? '';

/** True when the region has anything for the compositor to render. */
export const regionNeedsComposite = (region: Region): boolean =>
  !!region.editorErased || !!getRegionEditorText(region).trim() || !!region.editorBrushUrl;

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
 * `editorBackendUrl` points at the unified Python backend; its /erase
 * endpoint (OpenCV inpaint) is preferred over the local fallback eraser.
 */
export const compositeRegionPatch = async (
  imageEl: HTMLImageElement,
  region: Region,
  erasedCache: Map<string, ErasedCacheEntry>,
  preferVerticalDefault: boolean,
  editorBackendUrl?: string,
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
    const key = regionGeomKey(region);
    let entry = erasedCache.get(region.id);
    if (!entry || entry.geomKey !== key) {
      const eraseCanvas = document.createElement('canvas');
      eraseCanvas.width = cropW;
      eraseCanvas.height = cropH;
      const ectx = eraseCanvas.getContext('2d');
      if (!ectx) throw new Error('Could not get canvas context');
      ectx.drawImage(imageEl, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      await eraseTextInCanvasAuto(
        eraseCanvas,
        editorBackendUrl,
        region.detectedClass === 'text_free' ? 'free' : 'bubble'
      );
      const url = await canvasToObjectURL(eraseCanvas);
      if (entry) releaseObjectURL(entry.url);
      entry = { geomKey: key, url };
      erasedCache.set(region.id, entry);
    }
    const erasedImg = await loadImage(entry.url);
    ctx.drawImage(erasedImg, mx, my, cropW, cropH);
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
