import { EditorTextStyle } from '../types';

/**
 * Text layout + rendering for the in-place manga text editor (嵌字).
 *
 * Inspired by comic-text-translator-lite's fill_translated_text.py
 * (font_size: "auto"), but with a rewritten fitting algorithm and proper
 * kinsoku shori (避头尾) so punctuation never starts a line and opening
 * brackets never end one — a known weakness of the original script.
 *
 * - Horizontal: greedy char wrap measured with canvas measureText, binary
 *   search for the largest font size that fits the box.
 * - Vertical: chars flow top→bottom, columns right→left (traditional manga).
 *   Columns are top-aligned so first characters share one horizontal line;
 *   vertical punctuation forms are emulated (90° rotation for dashes /
 *   brackets / ellipsis, em-box offsets for 。、：；！？) since canvas cannot
 *   trigger OpenType 'vert' features.
 * - The text block is centered inside the box.
 */

export interface ResolvedTextStyle {
  fontSize: number;     // px (auto-computed when input had none)
  isVertical: boolean;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  isBold: boolean;
  fontFamily: string;
  padding: number;
}

// Punctuation that must NOT appear at the start of a line/column (行首禁则)
const NO_LINE_START = new Set(
  '。、，．！？；：）】」』〉》”’…‥—～・﹒﹗﹖﹔’»,.!?:;)]}%"\''.split('')
);
// Punctuation that must NOT appear at the end of a line/column (行末禁则)
const NO_LINE_END = new Set(
  '（【「『〈《“‘﹙‘«([{'.split('')
);

const LINE_HEIGHT_RATIO = 1.18;

// ── Vertical punctuation handling (竖排标点) ─────────────────────────────
// Canvas can't trigger OpenType 'vert'/'vrt2' features, so vertical forms are
// emulated per character:
//  - ROTATE90: glyphs whose vertical form is the horizontal glyph turned 90°
//    CW — dashes, ellipsis, the katakana long-vowel mark, and all brackets /
//    corner quotes (「 rotated 90° CW IS the correct vertical bracket shape).
//  - PUNCT_OFFSET: fullwidth CJK punctuation whose ink sits bottom-left in
//    the horizontal em box; in vertical writing 。、 belong to the TOP-RIGHT
//    of the em box, ：； pull toward the center, and ！？ must be centered
//    (their ink is left-of-em in horizontal fonts). Values are x/y offsets
//    as fractions of fontSize.
const ROTATE90 = new Set(
  '—―−-ー~～〜…‥⋯（）()【】[]《》〈〉「」『』〔〕｛｝{}‖'.split('')
);
const PUNCT_OFFSET: Record<string, readonly [number, number]> = {
  '。': [0.35, -0.35],
  '、': [0.35, -0.35],
  '，': [0.35, -0.35],
  '．': [0.35, -0.35],
  '：': [0.25, -0.25],
  '；': [0.25, -0.25],
  '！': [0.25, 0],
  '？': [0.25, 0],
};

let measureCanvas: HTMLCanvasElement | null = null;
const getMeasureCtx = (): CanvasRenderingContext2D => {
  if (!measureCanvas) {
    measureCanvas = document.createElement('canvas');
    measureCanvas.width = 8;
    measureCanvas.height = 8;
  }
  const ctx = measureCanvas.getContext('2d');
  if (!ctx) throw new Error('Could not get measure canvas context');
  return ctx;
};

const buildFont = (fontSize: number, style: ResolvedTextStyle): string =>
  `${style.isBold ? 'bold' : 'normal'} ${fontSize}px ${style.fontFamily}`;

/**
 * Greedy char-based wrap with kinsoku post-processing.
 * `fits(chars)` returns true when the given chars fit on one line.
 * Returns the text split into lines; explicit '\n' forces a break.
 */
const wrapWithKinsoku = (text: string, fits: (s: string) => boolean): string[] => {
  const lines: string[] = [];
  const paragraphs = text.split('\n');

  for (const para of paragraphs) {
    if (para.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (let i = 0; i < para.length; i++) {
      const ch = para[i];
      if (line.length > 0 && !fits(line + ch)) {
        lines.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    if (line.length > 0) lines.push(line);
  }

  // Kinsoku pass: fix line breaks so forbidden punctuation doesn't start a
  // line and opening punctuation doesn't end one. Work on non-empty lines.
  const out = [...lines];
  for (let i = 0; i < out.length - 1; i++) {
    // Guard against pathological loops (e.g. a box so narrow only one char fits)
    let guard = 0;
    while (guard++ < 8) {
      const cur = out[i];
      const next = out[i + 1];
      if (!cur || !next) break;

      const firstOfNext = next[0];
      if (NO_LINE_START.has(firstOfNext)) {
        // Move the last char of the current line down so the punctuation
        // doesn't lead the next line. If current line has only one char,
        // allow overflow instead (nothing sensible to do).
        if (cur.length <= 1) break;
        out[i] = cur.slice(0, -1);
        out[i + 1] = cur[cur.length - 1] + next;
        continue; // re-check: the new line-end might be an opening bracket
      }

      const lastOfCur = cur[cur.length - 1];
      if (NO_LINE_END.has(lastOfCur)) {
        // Opening punctuation at line end → carry it to the next line.
        if (cur.length <= 1) break;
        out[i] = cur.slice(0, -1);
        out[i + 1] = lastOfCur + next;
        continue;
      }
      break;
    }
  }
  return out;
};

const resolveStyle = (
  boxW: number,
  boxH: number,
  style: EditorTextStyle | undefined,
  preferVerticalDefault: boolean
): Omit<ResolvedTextStyle, 'fontSize'> => {
  const padding = Math.max(4, Math.min(boxW, boxH) * 0.07);
  const isVertical =
    style?.isVertical ??
    (preferVerticalDefault || boxH > boxW * 1.5);
  return {
    isVertical,
    color: style?.color ?? '#000000',
    outlineColor: style?.outlineColor ?? '#ffffff',
    outlineWidth: style?.outlineWidth ?? 0,
    isBold: style?.isBold ?? true,
    fontFamily: style?.fontFamily ?? 'sans-serif',
    padding,
  };
};

export interface TextLayout {
  lines: string[];
  style: ResolvedTextStyle;
}

/**
 * Lay out `text` inside a boxW×boxH box. When style.fontSize is undefined,
 * binary-searches the largest font size (8..cap) whose wrapped result fits.
 */
export const layoutText = (
  text: string,
  boxW: number,
  boxH: number,
  style?: EditorTextStyle,
  preferVerticalDefault = false
): TextLayout | null => {
  if (!text.trim()) return null;
  const base = resolveStyle(boxW, boxH, style, preferVerticalDefault);
  const innerW = Math.max(8, boxW - base.padding * 2);
  const innerH = Math.max(8, boxH - base.padding * 2);
  const ctx = getMeasureCtx();

  const wrapAt = (fontSize: number): { lines: string[]; fits: boolean } => {
    const full: ResolvedTextStyle = { ...base, fontSize };
    ctx.font = buildFont(fontSize, full);
    let lines: string[];
    let fits: boolean;
    if (base.isVertical) {
      // A vertical "line" is a column; a char occupies fontSize vertically.
      const charsPerCol = Math.max(1, Math.floor(innerH / fontSize));
      lines = wrapWithKinsoku(text, (s) => s.length <= charsPerCol);
      const colW = fontSize * LINE_HEIGHT_RATIO;
      fits = lines.length * colW <= innerW + 0.5;
    } else {
      lines = wrapWithKinsoku(text, (s) => ctx.measureText(s).width <= innerW);
      fits = lines.length * fontSize * LINE_HEIGHT_RATIO <= innerH + 0.5;
    }
    return { lines, fits };
  };

  if (style?.fontSize && style.fontSize > 0) {
    const fontSize = style.fontSize;
    return { lines: wrapAt(fontSize).lines, style: { ...base, fontSize } };
  }

  // Auto-fit: binary search the largest fitting font size.
  let lo = 8;
  let hi = Math.max(
    10,
    Math.floor(base.isVertical ? innerW / LINE_HEIGHT_RATIO : innerH / LINE_HEIGHT_RATIO)
  );
  let best: { lines: string[]; fontSize: number } | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const { lines, fits } = wrapAt(mid);
    if (fits) {
      best = { lines, fontSize: mid };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (!best) {
    // Even the minimum doesn't fit — use it anyway (text will overflow the
    // box slightly; better than silently dropping the text).
    best = { lines: wrapAt(8).lines, fontSize: 8 };
  }
  return { lines: best.lines, style: { ...base, fontSize: best.fontSize } };
};

/**
 * Draw previously laid-out text into ctx, centered inside a boxW×boxH box
 * whose top-left corner is at (0, 0) of the current transform.
 */
export const drawTextLayout = (
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  boxW: number,
  boxH: number
): void => {
  const { lines, style } = layout;
  const { fontSize, isVertical, color, outlineColor, outlineWidth, padding } = style;
  ctx.save();
  ctx.font = buildFont(fontSize, style);
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  if (outlineWidth > 0) {
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = outlineWidth;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
  }
  const innerW = Math.max(8, boxW - padding * 2);
  const innerH = Math.max(8, boxH - padding * 2);

  const drawLine = (line: string, x: number, y: number) => {
    if (outlineWidth > 0) ctx.strokeText(line, x, y);
    ctx.fillText(line, x, y);
  };

  if (!isVertical) {
    const lineH = fontSize * LINE_HEIGHT_RATIO;
    const blockH = lines.length * lineH;
    let y = padding + Math.max(0, (innerH - blockH) / 2);
    for (const line of lines) {
      const w = ctx.measureText(line).width;
      const x = padding + Math.max(0, (innerW - w) / 2);
      drawLine(line, x, y);
      y += lineH;
    }
  } else {
    const colW = fontSize * LINE_HEIGHT_RATIO;
    const blockW = lines.length * colW;
    // Columns flow right → left: column 0 is the rightmost.
    const rightEdge = boxW - padding - Math.max(0, (innerW - blockW) / 2);
    // All columns share one baseline: the block is centered by its LONGEST
    // column and every column starts at the same y, so first characters line
    // up horizontally (竖排首字对齐).
    const maxColH = Math.max(...lines.map(l => l.length * fontSize));
    const startY = padding + Math.max(0, (innerH - maxColH) / 2);
    lines.forEach((line, colIdx) => {
      const colCenterX = rightEdge - colIdx * colW - colW / 2;
      let y = startY;
      for (const ch of line) {
        if (ROTATE90.has(ch)) {
          // Drawn as the horizontal glyph rotated 90° CW about the em center.
          ctx.save();
          ctx.translate(colCenterX, y + fontSize / 2);
          ctx.rotate(Math.PI / 2);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          drawLine(ch, 0, 0);
          ctx.restore();
        } else {
          const cw = ctx.measureText(ch).width;
          const offset = PUNCT_OFFSET[ch];
          const dx = offset ? offset[0] * fontSize : 0;
          const dy = offset ? offset[1] * fontSize : 0;
          drawLine(ch, colCenterX - cw / 2 + dx, y + dy);
        }
        y += fontSize;
      }
    });
  }
  ctx.restore();
};
