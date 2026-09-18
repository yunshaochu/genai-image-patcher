/**
 * Pure-frontend text erasure for manga regions, inspired by the
 * comic-text-translator-lite `whiten_regions.py` script (flood-fill mode).
 *
 * The Python original uses OpenCV floodFill + inpaint. This implementation
 * reproduces the same idea with canvas ImageData:
 *
 * 1. BACKGROUND: multi-source BFS flood fill from all border pixels (plus the
 *    center point). Each seed expands through pixels whose color is within
 *    `tolerance` of THAT seed's color — so a bubble interior (near-white)
 *    becomes one connected background region while dark text strokes are
 *    rejected. Multi-seed handles text_free too (non-uniform art background).
 *
 * 2. HOLES = TEXT: pixels that are NOT background but are fully enclosed by
 *    background (cannot reach the crop border without crossing background)
 *    are text strokes. Pixels connected to the border (bubble outlines,
 *    neighbouring art) are preserved.
 *
 * 3. FILL: connected-component labeling on the text mask; each component is
 *    filled with the average color of the background pixels surrounding it.
 *    A constrained 1px fringe pass catches anti-aliased edges (only pixels
 *    whose color sits closer to the text than to the background).
 *
 * Works on a region crop canvas in place. Crops are small (text boxes), so
 * the O(n) pixel loops are fast enough for interactive use.
 */

interface EraseOptions {
  /** Max per-channel color distance for a pixel to join a background region. */
  tolerance?: number;
}

const DEFAULT_TOLERANCE = 32;

export const eraseTextInCanvas = (
  canvas: HTMLCanvasElement,
  options: EraseOptions = {}
): void => {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  if (w < 4 || h < 4) return;

  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const n = w * h;

  // Masks: 0 = undecided, 1 = background, 2 = outside (non-bg touching border)
  const state = new Uint8Array(n);
  // Per-pixel owning seed color (only meaningful for background pixels)
  const seedColor = new Int32Array(n);

  const colorDist = (idx: number, packed: number): number => {
    const r = (packed >> 16) & 0xff;
    const g = (packed >> 8) & 0xff;
    const b = packed & 0xff;
    const o = idx * 4;
    return Math.max(
      Math.abs(data[o] - r),
      Math.abs(data[o + 1] - g),
      Math.abs(data[o + 2] - b)
    );
  };

  const packedAt = (idx: number): number => {
    const o = idx * 4;
    return (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
  };

  // --- Step 1: multi-source BFS background flood fill ---
  // Queue entries are pixel indices. Seed color travels with the pixel via
  // seedColor[] so expansion always compares against the originating seed.
  let queue: number[] = [];
  const pushSeed = (idx: number) => {
    if (state[idx] !== 0) return;
    state[idx] = 1;
    seedColor[idx] = packedAt(idx);
    queue.push(idx);
  };

  for (let x = 0; x < w; x++) {
    pushSeed(x);                 // top row
    pushSeed((h - 1) * w + x);   // bottom row
  }
  for (let y = 0; y < h; y++) {
    pushSeed(y * w);             // left column
    pushSeed(y * w + w - 1);     // right column
  }
  // Center seed helps when a bubble outline fully encloses the crop borders
  // (text_bubble boxes are tight, but manual boxes may not be).
  pushSeed(Math.floor(h / 2) * w + Math.floor(w / 2));

  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const sc = seedColor[cur];
    const cx = cur % w;
    const cy = (cur / w) | 0;
    // 4-neighbours
    if (cx > 0 && state[cur - 1] === 0 && colorDist(cur - 1, sc) <= tolerance) {
      state[cur - 1] = 1; seedColor[cur - 1] = sc; queue.push(cur - 1);
    }
    if (cx < w - 1 && state[cur + 1] === 0 && colorDist(cur + 1, sc) <= tolerance) {
      state[cur + 1] = 1; seedColor[cur + 1] = sc; queue.push(cur + 1);
    }
    if (cy > 0 && state[cur - w] === 0 && colorDist(cur - w, sc) <= tolerance) {
      state[cur - w] = 1; seedColor[cur - w] = sc; queue.push(cur - w);
    }
    if (cy < h - 1 && state[cur + w] === 0 && colorDist(cur + w, sc) <= tolerance) {
      state[cur + w] = 1; seedColor[cur + w] = sc; queue.push(cur + w);
    }
  }

  // --- Step 2: outside pass — non-background pixels reachable from border ---
  queue = [];
  const pushOutside = (idx: number) => {
    if (state[idx] === 0) {
      state[idx] = 2;
      queue.push(idx);
    }
  };
  for (let x = 0; x < w; x++) {
    pushOutside(x);
    pushOutside((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    pushOutside(y * w);
    pushOutside(y * w + w - 1);
  }
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const cx = cur % w;
    const cy = (cur / w) | 0;
    if (cx > 0) pushOutside(cur - 1);
    if (cx < w - 1) pushOutside(cur + 1);
    if (cy > 0) pushOutside(cur - w);
    if (cy < h - 1) pushOutside(cur + w);
  }

  // Remaining state-0 pixels are interior holes = text. Nothing to do if none.
  const textMask = new Uint8Array(n); // 1 = text pixel
  let hasText = false;
  for (let i = 0; i < n; i++) {
    if (state[i] === 0) {
      textMask[i] = 1;
      hasText = true;
    }
  }
  if (!hasText) return;

  // --- Step 3: connected components on the text mask; fill each with the
  // average color of the background pixels adjacent to it. ---
  const compId = new Int32Array(n).fill(-1);
  let compCount = 0;
  const compQueue: number[] = [];
  // Per-component accumulators (grown as needed)
  const bgR: number[] = [];
  const bgG: number[] = [];
  const bgB: number[] = [];
  const bgN: number[] = [];
  const fgR: number[] = [];
  const fgG: number[] = [];
  const fgB: number[] = [];
  const fgN: number[] = [];

  for (let i = 0; i < n; i++) {
    if (textMask[i] !== 1 || compId[i] !== -1) continue;
    const id = compCount++;
    bgR[id] = 0; bgG[id] = 0; bgB[id] = 0; bgN[id] = 0;
    fgR[id] = 0; fgG[id] = 0; fgB[id] = 0; fgN[id] = 0;
    compId[i] = id;
    compQueue.length = 0;
    compQueue.push(i);
    for (let head = 0; head < compQueue.length; head++) {
      const cur = compQueue[head];
      const cx = cur % w;
      const cy = (cur / w) | 0;
      const o = cur * 4;
      fgR[id] += data[o]; fgG[id] += data[o + 1]; fgB[id] += data[o + 2]; fgN[id]++;
      const neighbors = [
        cx > 0 ? cur - 1 : -1,
        cx < w - 1 ? cur + 1 : -1,
        cy > 0 ? cur - w : -1,
        cy < h - 1 ? cur + w : -1,
      ];
      for (const nb of neighbors) {
        if (nb < 0) continue;
        if (textMask[nb] === 1 && compId[nb] === -1) {
          compId[nb] = id;
          compQueue.push(nb);
        } else if (state[nb] === 1) {
          // Adjacent background pixel → contributes to the fill color
          const bo = nb * 4;
          bgR[id] += data[bo]; bgG[id] += data[bo + 1]; bgB[id] += data[bo + 2]; bgN[id]++;
        }
      }
    }
  }

  // Fill each component (+ constrained fringe) with its background average.
  const filled = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const id = compId[i];
    if (id < 0) continue;
    const fillR = bgN[id] > 0 ? bgR[id] / bgN[id] : 255;
    const fillG = bgN[id] > 0 ? bgG[id] / bgN[id] : 255;
    const fillB = bgN[id] > 0 ? bgB[id] / bgN[id] : 255;
    const o = i * 4;
    data[o] = fillR;
    data[o + 1] = fillG;
    data[o + 2] = fillB;
    data[o + 3] = 255;
    filled[i] = 1;
  }

  // Fringe pass: non-background, non-text pixels adjacent to a filled pixel
  // whose color is closer to the component's text average than to the fill
  // color are anti-aliased stroke edges — fill them too.
  for (let i = 0; i < n; i++) {
    if (filled[i] !== 1) continue;
    const id = compId[i];
    if (id < 0) continue;
    const cx = i % w;
    const cy = (i / w) | 0;
    const neighbors = [
      cx > 0 ? i - 1 : -1,
      cx < w - 1 ? i + 1 : -1,
      cy > 0 ? i - w : -1,
      cy < h - 1 ? i + w : -1,
    ];
    const fillR = bgN[id] > 0 ? bgR[id] / bgN[id] : 255;
    const fillG = bgN[id] > 0 ? bgG[id] / bgN[id] : 255;
    const fillB = bgN[id] > 0 ? bgB[id] / bgN[id] : 255;
    const txtR = fgN[id] > 0 ? fgR[id] / fgN[id] : 0;
    const txtG = fgN[id] > 0 ? fgG[id] / fgN[id] : 0;
    const txtB = fgN[id] > 0 ? fgB[id] / fgN[id] : 0;
    for (const nb of neighbors) {
      if (nb < 0 || filled[nb] === 1 || state[nb] === 1 || compId[nb] !== -1) continue;
      const no = nb * 4;
      const dText =
        Math.abs(data[no] - txtR) + Math.abs(data[no + 1] - txtG) + Math.abs(data[no + 2] - txtB);
      const dFill =
        Math.abs(data[no] - fillR) + Math.abs(data[no + 1] - fillG) + Math.abs(data[no + 2] - fillB);
      if (dText < dFill) {
        data[no] = fillR;
        data[no + 1] = fillG;
        data[no + 2] = fillB;
        data[no + 3] = 255;
        filled[nb] = 1;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
};
