import { Region } from '../types';
import { loadImage, releaseObjectURL } from './imageUtils';
import { eraseTextInCanvas } from './textErase';
import { layoutText, drawTextLayout } from './textLayout';

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

/**
 * Build the composited patch for a region. Returns an Object URL, or null
 * when the region has no editor content (caller should then restore the
 * region to its un-edited state).
 */
export const compositeRegionPatch = async (
  imageEl: HTMLImageElement,
  region: Region,
  erasedCache: Map<string, ErasedCacheEntry>,
  preferVerticalDefault: boolean
): Promise<string | null> => {
  if (!regionNeedsComposite(region)) return null;

  const imgW = imageEl.naturalWidth;
  const imgH = imageEl.naturalHeight;
  const cropX = (region.x / 100) * imgW;
  const cropY = (region.y / 100) * imgH;
  const cropW = Math.max(1, Math.round((region.width / 100) * imgW));
  const cropH = Math.max(1, Math.round((region.height / 100) * imgH));

  const canvas = document.createElement('canvas');
  canvas.width = cropW;
  canvas.height = cropH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');
  ctx.drawImage(imageEl, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

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
      eraseTextInCanvas(eraseCanvas);
      const url = await canvasToObjectURL(eraseCanvas);
      if (entry) releaseObjectURL(entry.url);
      entry = { geomKey: key, url };
      erasedCache.set(region.id, entry);
    }
    const erasedImg = await loadImage(entry.url);
    ctx.drawImage(erasedImg, 0, 0, cropW, cropH);
  }

  // 2. Typeset text
  const text = getRegionEditorText(region);
  if (text.trim()) {
    const layout = layoutText(text, cropW, cropH, region.editorStyle, preferVerticalDefault);
    if (layout) drawTextLayout(ctx, layout, cropW, cropH);
  }

  // 3. Brush strokes on top (scaled if the box geometry changed since painting)
  if (region.editorBrushUrl) {
    try {
      const brushImg = await loadImage(region.editorBrushUrl);
      ctx.drawImage(brushImg, 0, 0, cropW, cropH);
    } catch (e) {
      console.warn('Failed to load brush layer for region', region.id, e);
    }
  }

  return canvasToObjectURL(canvas);
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
