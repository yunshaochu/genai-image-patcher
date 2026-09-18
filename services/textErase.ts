/**
 * Pure-frontend text erasure for manga regions — a TypeScript port of the
 * comic-text-translator-lite `whiten_regions.py` selective-erase algorithm.
 *
 * The Python original uses OpenCV; every primitive is reproduced here on
 * canvas ImageData:
 *
 * 1. FLAT CENTER SEEDS (_flat_seeds_center): spiral out from the crop center
 *    and pick up to 5 seeds whose 3x3 patch is flat (std < 10) and within ±40
 *    of the centre region's median luminance (the text-bearing surface) —
 *    avoids seeding a flood fill on top of a text stroke, which would mark
 *    the strokes as background.
 *
 * 2. BACKGROUND (multi-seed FIXED_RANGE flood fill): border pixels plus the
 *    flat center seeds each expand through pixels within `tolerance` of THAT
 *    seed's color. Tolerance follows the Python ladder (40 → 24 → 14): the
 *    first level whose background area fraction is sane [0.08, 0.92] wins;
 *    otherwise the largest fill is used (leaky outlines / gradient breaks).
 *
 * 3. HOLES = TEXT: pixels that are neither background nor reachable from the
 *    crop border without crossing background are text strokes. The
 *    border-reachable "outside" set (bubble outlines, neighbouring art) is
 *    the Python `ext` mask and is never touched.
 *
 * 4. DILATION: the text mask grows up to 2 fringe rounds into pixels that
 *    are not background and sit closer to the text colour than to the
 *    surrounding background colour (anti-aliased stroke edges) — the
 *    background mask blocks growth, mirroring `m &= ~ext`.
 *
 * 5. INPAINT: OpenCV's TELEA is replaced by an onion-peel diffusion fill —
 *    masked pixels are filled layer by layer from the average of their
 *    already-known 4-neighbours. On flat bubble interiors it converges to
 *    the flat background colour; on gradient / art backgrounds it follows
 *    the surrounding colours instead of stamping one flat block.
 *    A final residue pass catches faint stroke remnants near the filled area.
 *
 * Works on a region crop canvas in place. Crops are small (text boxes), so
 * the O(n) pixel loops are fast enough for interactive use.
 */

interface EraseOptions {
  /** Base tolerance (ladder start) for background flood fill. */
  tolerance?: number;
  /** Region kind: decides the seed strategy of the local fallback below. */
  kind?: EraseKind;
  /** Text-mask dilation radius sent to the backend (whiten_regions.py: 5). */
  dilate?: number;
  /** Inpaint radius sent to the backend (whiten_regions.py: 7). */
  inpaintRadius?: number;
}

const DEFAULT_TOLERANCE = 40;
const DEFAULT_DILATE = 5;
const DEFAULT_INPAINT_RADIUS = 7;

/** Region kind for the backend eraser: bubble interior vs free-standing text. */
export type EraseKind = 'bubble' | 'free';

/**
 * Erase via the unified Python backend (`POST {base}/erase`, OpenCV
 * flood-fill + TELEA inpaint — the same algorithm this file's local
 * fallback approximates). Returns true when the backend produced a result;
 * on any failure (offline, timeout, bad payload) the caller falls back to
 * the local algorithm.
 */
export const eraseTextInCanvasViaBackend = async (
  canvas: HTMLCanvasElement,
  backendBaseUrl: string,
  kind: EraseKind,
  options: EraseOptions = {},
  timeoutMs = 20000
): Promise<boolean> => {
  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
  if (!blob) return false;

  const form = new FormData();
  form.append('image', blob, 'crop.png');
  form.append('kind', kind);
  form.append('dilate', String(options.dilate ?? DEFAULT_DILATE));
  form.append('inpaint_radius', String(options.inpaintRadius ?? DEFAULT_INPAINT_RADIUS));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${backendBaseUrl.replace(/\/+$/, '')}/erase`, {
      method: 'POST',
      body: form,
      mode: 'cors',
      signal: ctrl.signal,
    });
    if (!resp.ok) return false;
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('image')) return false;
    const bmp = await createImageBitmap(await resp.blob());
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bmp.close();
      return false;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Smart erase: try the backend first (best quality), fall back to the local
 * pure-frontend algorithm when the backend is unreachable.
 */
export const eraseTextInCanvasAuto = async (
  canvas: HTMLCanvasElement,
  backendBaseUrl: string | undefined,
  kind: EraseKind,
  options: EraseOptions = {}
): Promise<void> => {
  if (backendBaseUrl) {
    const ok = await eraseTextInCanvasViaBackend(canvas, backendBaseUrl, kind, options);
    if (ok) return;
    console.warn('Backend erasure unavailable, falling back to local algorithm');
  }
  eraseTextInCanvas(canvas, { ...options, kind });
};

export const eraseTextInCanvas = (
  canvas: HTMLCanvasElement,
  options: EraseOptions = {}
): void => {
  const baseTol = options.tolerance ?? DEFAULT_TOLERANCE;
  const kind = options.kind ?? 'bubble';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  if (w < 4 || h < 4) return;

  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const n = w * h;

  const packedAt = (idx: number): number => {
    const o = idx * 4;
    return (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
  };

  const colorDistToPacked = (idx: number, packed: number): number => {
    const o = idx * 4;
    return Math.max(
      Math.abs(data[o] - ((packed >> 16) & 0xff)),
      Math.abs(data[o + 1] - ((packed >> 8) & 0xff)),
      Math.abs(data[o + 2] - (packed & 0xff))
    );
  };

  const lumAt = (idx: number): number => {
    const o = idx * 4;
    return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  };

  // ---------------------------------------------------------------------
  // Flat center seeds (Python `_flat_seeds_center`): spiral from the centre,
  // accept 3x3 patches with std < 10 whose mean is within ±40 of the CENTRE
  // REGION's median luminance. The centre region (not the whole crop) is the
  // reference because art outside the box skews a whole-crop median (black
  // narration box on a bright scene, grey bubbles) and used to flip the
  // polarity onto the text strokes; ±40 around the surface tone works for
  // black / white / mid-grey backgrounds alike.
  // ---------------------------------------------------------------------
  const flatCenterSeeds = (maxSeeds = 5): number[] => {
    const cx = w >> 1;
    const cy = h >> 1;
    const qx = w >> 2;
    const qy = h >> 2;
    const lums: number[] = [];
    for (let yy = qy; yy < Math.max(qy + 1, h - qy); yy++) {
      for (let xx = qx; xx < Math.max(qx + 1, w - qx); xx++) {
        lums.push(lumAt(yy * w + xx));
      }
    }
    lums.sort((a, b) => a - b);
    const base = lums[lums.length >> 1];

    const seeds: number[] = [];
    const step = Math.max(2, Math.min(h, w) / 10) | 0;
    const rMax = Math.min(h, w) >> 1;
    for (let r = 0; r < rMax && seeds.length < maxSeeds; r += step) {
      const nAng = r === 0 ? 1 : 8;
      for (let k = 0; k < nAng && seeds.length < maxSeeds; k++) {
        const ang = (k * 2 * Math.PI) / nAng;
        const x = Math.round(cx + r * Math.cos(ang));
        const y = Math.round(cy + r * Math.sin(ang));
        if (x < 1 || x >= w - 1 || y < 1 || y >= h - 1) continue;
        // 3x3 patch statistics
        let sum = 0;
        let sumSq = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const l = lumAt((y + dy) * w + (x + dx));
            sum += l;
            sumSq += l * l;
          }
        }
        const mean = sum / 9;
        const std = Math.sqrt(Math.max(0, sumSq / 9 - mean * mean));
        if (std < 10 && Math.abs(mean - base) <= 40) seeds.push(y * w + x);
      }
    }
    if (seeds.length === 0) seeds.push(cy * w + cx);
    return seeds;
  };

  // ---------------------------------------------------------------------
  // Multi-seed FIXED_RANGE flood fill: 1 = background.
  //
  // Seed policy follows the Python original per kind:
  //   free   → border seeds (Python seeds the 4 edge midpoints): text sits on
  //            an art background that reaches the crop border.
  //   bubble → flat centre seeds only: the ROI now contains the bubble outline
  //            and outside background, so seeding the border would mark the
  //            outside as background and turn the whole bubble interior (and
  //            possibly the outline) into a "text hole".
  // ---------------------------------------------------------------------
  const floodBackground = (
    tolerance: number,
    seedBorder: boolean
  ): { bg: Uint8Array; count: number } => {
    const bg = new Uint8Array(n);
    const seedColor = new Int32Array(n);
    const queue: number[] = [];
    const pushSeed = (idx: number) => {
      if (bg[idx] !== 0) return;
      bg[idx] = 1;
      seedColor[idx] = packedAt(idx);
      queue.push(idx);
    };

    if (seedBorder) {
      for (let x = 0; x < w; x++) {
        pushSeed(x);
        pushSeed((h - 1) * w + x);
      }
      for (let y = 0; y < h; y++) {
        pushSeed(y * w);
        pushSeed(y * w + w - 1);
      }
    }
    for (const s of flatCenterSeeds()) pushSeed(s);

    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      const sc = seedColor[cur];
      const cx = cur % w;
      const cy = (cur / w) | 0;
      if (cx > 0 && bg[cur - 1] === 0 && colorDistToPacked(cur - 1, sc) <= tolerance) {
        bg[cur - 1] = 1; seedColor[cur - 1] = sc; queue.push(cur - 1);
      }
      if (cx < w - 1 && bg[cur + 1] === 0 && colorDistToPacked(cur + 1, sc) <= tolerance) {
        bg[cur + 1] = 1; seedColor[cur + 1] = sc; queue.push(cur + 1);
      }
      if (cy > 0 && bg[cur - w] === 0 && colorDistToPacked(cur - w, sc) <= tolerance) {
        bg[cur - w] = 1; seedColor[cur - w] = sc; queue.push(cur - w);
      }
      if (cy < h - 1 && bg[cur + w] === 0 && colorDistToPacked(cur + w, sc) <= tolerance) {
        bg[cur + w] = 1; seedColor[cur + w] = sc; queue.push(cur + w);
      }
    }
    let count = 0;
    for (let i = 0; i < n; i++) count += bg[i];
    return { bg, count };
  };

  // Tolerance ladder (Python: 40 → 22 → 12 with area sanity check).
  let bg: Uint8Array | null = null;
  let bestBg: Uint8Array | null = null;
  let bestCount = -1;
  const ladder = [baseTol, Math.round(baseTol * 0.6), Math.round(baseTol * 0.35)];
  for (const tol of ladder) {
    let res = floodBackground(tol, kind === 'free');
    // Bubble with very dense text: every flat centre seed may have landed on a
    // stroke, leaving (almost) no background. Retry with border seeds instead
    // of erasing nothing.
    if (kind === 'bubble' && res.count < n * 0.02) {
      const alt = floodBackground(tol, true);
      if (alt.count > res.count) res = alt;
    }
    if (res.count > bestCount) {
      bestCount = res.count;
      bestBg = res.bg;
    }
    const frac = res.count / n;
    if (frac >= 0.08 && frac <= 0.92) {
      bg = res.bg;
      break;
    }
  }
  if (!bg) bg = bestBg!;
  // Practically everything is background → no text to erase.
  if (bestCount >= n * 0.995) return;

  // ---------------------------------------------------------------------
  // Outside pass (Python `ext`): non-background reachable from the border —
  // bubble outlines and neighbouring art. 4-connectivity keeps diagonally
  // touching strokes out of ext, just like the original.
  // ---------------------------------------------------------------------
  const state = new Uint8Array(n); // 1 = background, 2 = outside
  state.set(bg);
  {
    const queue: number[] = [];
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
  }

  // Remaining state-0 pixels are interior holes = text.
  const mask = new Uint8Array(n);
  let hasText = false;
  for (let i = 0; i < n; i++) {
    if (state[i] === 0) {
      mask[i] = 1;
      hasText = true;
    }
  }
  if (!hasText) return;

  // ---------------------------------------------------------------------
  // Connected components on the text mask → per-component text / adjacent
  // background average colours (used for the fringe-closeness criterion).
  // ---------------------------------------------------------------------
  const compId = new Int32Array(n).fill(-1);
  let compCount = 0;
  const bgR: number[] = [];
  const bgG: number[] = [];
  const bgB: number[] = [];
  const bgN: number[] = [];
  const fgR: number[] = [];
  const fgG: number[] = [];
  const fgB: number[] = [];
  const fgN: number[] = [];
  {
    const compQueue: number[] = [];
    for (let i = 0; i < n; i++) {
      if (mask[i] !== 1 || compId[i] !== -1) continue;
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
          if (mask[nb] === 1 && compId[nb] === -1) {
            compId[nb] = id;
            compQueue.push(nb);
          } else if (state[nb] === 1) {
            const bo = nb * 4;
            bgR[id] += data[bo]; bgG[id] += data[bo + 1]; bgB[id] += data[bo + 2]; bgN[id]++;
          }
        }
      }
    }
  }

  // Fringe dilation (≤2 rounds): grow the mask into non-background pixels
  // closer to the component's text colour than to its background colour.
  // Never crosses background, mirroring the Python `m &= ~ext` guard.
  for (let round = 0; round < 2; round++) {
    const additions: number[] = [];
    for (let i = 0; i < n; i++) {
      if (mask[i] !== 1) continue;
      const id = compId[i];
      if (id < 0) continue;
      const cx = i % w;
      const cy = (i / w) | 0;
      const fillR = bgN[id] > 0 ? bgR[id] / bgN[id] : 255;
      const fillG = bgN[id] > 0 ? bgG[id] / bgN[id] : 255;
      const fillB = bgN[id] > 0 ? bgB[id] / bgN[id] : 255;
      const txtR = fgN[id] > 0 ? fgR[id] / fgN[id] : 0;
      const txtG = fgN[id] > 0 ? fgG[id] / fgN[id] : 0;
      const txtB = fgN[id] > 0 ? fgB[id] / fgN[id] : 0;
      const neighbors = [
        cx > 0 ? i - 1 : -1,
        cx < w - 1 ? i + 1 : -1,
        cy > 0 ? i - w : -1,
        cy < h - 1 ? i + w : -1,
      ];
      for (const nb of neighbors) {
        if (nb < 0 || mask[nb] === 1 || state[nb] === 1) continue;
        const no = nb * 4;
        const dText =
          Math.abs(data[no] - txtR) + Math.abs(data[no + 1] - txtG) + Math.abs(data[no + 2] - txtB);
        const dFill =
          Math.abs(data[no] - fillR) + Math.abs(data[no + 1] - fillG) + Math.abs(data[no + 2] - fillB);
        if (dText < dFill) additions.push(nb);
      }
    }
    if (additions.length === 0) break;
    for (const a of additions) mask[a] = 1;
  }

  // ---------------------------------------------------------------------
  // Onion-peel diffusion inpaint (TELEA replacement): fill masked pixels
  // layer by layer from the average of their known 4-neighbours.
  // ---------------------------------------------------------------------
  const inpaint = (fillMask: Uint8Array): void => {
    const known = new Uint8Array(n);
    for (let i = 0; i < n; i++) known[i] = fillMask[i] ? 0 : 1;
    let frontier: number[] = [];
    for (let i = 0; i < n; i++) {
      if (fillMask[i] !== 1) continue;
      const cx = i % w;
      const cy = (i / w) | 0;
      if (
        (cx > 0 && known[i - 1] === 1) ||
        (cx < w - 1 && known[i + 1] === 1) ||
        (cy > 0 && known[i - w] === 1) ||
        (cy < h - 1 && known[i + w] === 1)
      ) {
        frontier.push(i);
      }
    }
    const inQueue = new Uint8Array(n);
    for (const f of frontier) inQueue[f] = 1;
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const cur of frontier) {
        const cx = cur % w;
        const cy = (cur / w) | 0;
        let r = 0;
        let g = 0;
        let b = 0;
        let c = 0;
        const neighbors = [
          cx > 0 ? cur - 1 : -1,
          cx < w - 1 ? cur + 1 : -1,
          cy > 0 ? cur - w : -1,
          cy < h - 1 ? cur + w : -1,
        ];
        for (const nb of neighbors) {
          if (nb < 0 || known[nb] !== 1) continue;
          const no = nb * 4;
          r += data[no]; g += data[no + 1]; b += data[no + 2]; c++;
        }
        if (c === 0) continue;
        const o = cur * 4;
        data[o] = r / c;
        data[o + 1] = g / c;
        data[o + 2] = b / c;
        data[o + 3] = 255;
        known[cur] = 1;
      }
      for (const cur of frontier) {
        if (known[cur] !== 1) continue;
        const cx = cur % w;
        const cy = (cur / w) | 0;
        const neighbors = [
          cx > 0 ? cur - 1 : -1,
          cx < w - 1 ? cur + 1 : -1,
          cy > 0 ? cur - w : -1,
          cy < h - 1 ? cur + w : -1,
        ];
        for (const nb of neighbors) {
          if (nb >= 0 && known[nb] === 0 && inQueue[nb] === 0) {
            inQueue[nb] = 1;
            next.push(nb);
          }
        }
      }
      frontier = next;
    }
  };

  inpaint(mask);

  // Residue pass (Python second-round cleanup): non-background pixels within
  // 1px of the filled mask whose luminance still differs strongly from their
  // filled/background surroundings are stroke remnants — fill them too.
  {
    const extra = new Uint8Array(n);
    let extraCount = 0;
    for (let i = 0; i < n; i++) {
      if (mask[i] === 1 || state[i] === 1) continue;
      const cx = i % w;
      const cy = (i / w) | 0;
      const neighbors = [
        cx > 0 ? i - 1 : -1,
        cx < w - 1 ? i + 1 : -1,
        cy > 0 ? i - w : -1,
        cy < h - 1 ? i + w : -1,
      ];
      let nearMask = false;
      let sumLum = 0;
      let cntLum = 0;
      for (const nb of neighbors) {
        if (nb < 0) continue;
        if (mask[nb] === 1) nearMask = true;
        if (mask[nb] === 1 || state[nb] === 1) {
          sumLum += lumAt(nb);
          cntLum++;
        }
      }
      if (!nearMask || cntLum === 0) continue;
      if (Math.abs(lumAt(i) - sumLum / cntLum) > 40) {
        extra[i] = 1;
        extraCount++;
      }
    }
    if (extraCount > 0) inpaint(extra);
  }

  ctx.putImageData(imageData, 0, 0);
};
