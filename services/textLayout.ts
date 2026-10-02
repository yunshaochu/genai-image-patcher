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
 * - Alignment: 横排靠左（每行从框的左内边起排，块本身仍在框内垂直居中）；
 *   竖排整块居中（列从右往左排）。
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

/**
 * 嵌字的全局默认字体栈：区域自身没有 `editorStyle.fontFamily` 时用它。
 *
 * 做成模块级状态（而不是多加一个函数参数）是因为调用链太多——合成器、画笔
 * 预览、自动字号探测、面板里的字号参考都各自调 layoutText，全部改签名既啰嗦
 * 又容易漏。App 在「编辑器字体」配置变化时调一次 setDefaultFontFamily 即可。
 */
let defaultFontFamily = 'sans-serif';

export const setDefaultFontFamily = (stack: string): void => {
  defaultFontFamily = stack && stack.trim() ? stack : 'sans-serif';
};

export const getDefaultFontFamily = (): string => defaultFontFamily;

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

/**
 * 「白字」的判定阈值 —— 黑描边只配白字，其余（黑字、彩字、灰字）一律白描边。
 *
 * 不用「偏亮就算白」的 128 阈值：中间调的灰字/彩字配白边才认得出字形，配黑边
 * 会和深色笔画糊在一起。
 *
 * 也不做 `=== '#ffffff'` 的严格相等：自动取色量出来的白字几乎不会正好落在
 * #ffffff 上（#fdfdfd / #f8f8f8 之类很常见），严格相等会让这些字拿到白边 ——
 * 白底白边，字直接消失。240 既能吸掉这点噪声，又远高于任何不会被叫作「白」的
 * 颜色（浅粉 237、浅黄 221、浅灰 #d0d0d0 208 都判为非白）。
 */
const WHITE_LUMINANCE = 240;
const isWhiteHex = (c: string): boolean => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return false;
  const v = parseInt(m[1], 16);
  return 0.299 * ((v >> 16) & 0xff) + 0.587 * ((v >> 8) & 0xff) + 0.114 * (v & 0xff) >= WHITE_LUMINANCE;
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
  const color = style?.color ?? '#000000';
  return {
    isVertical,
    color,
    // 没显式给 outlineColor 时按字色推：只有白字配黑边，其余一律白边
    // （黑字白边、彩字/灰字白边）。显式值优先 —— dock 的黑字/白字按钮和 AI
    // 颜色模块都按同一条规则写值。
    outlineColor: style?.outlineColor ?? (isWhiteHex(color) ? '#000000' : '#ffffff'),
    outlineWidth: style?.outlineWidth ?? 0,
    isBold: style?.isBold ?? true,
    // 区域显式指定优先，否则跟随「编辑器字体」全局设置。
    fontFamily: style?.fontFamily ?? defaultFontFamily,
    padding,
  };
};

export interface TextLayout {
  lines: string[];
  style: ResolvedTextStyle;
}

/**
 * Pixel bounds of a laid-out text block, in the same box coordinate space as
 * drawTextLayout. Used by the compositor to size the overflow margin when
 * the block doesn't fit its box (manual font size / pathological input).
 * For horizontal layouts blockW is 0 — wrapping guarantees lines fit innerW.
 */
export const measureLayoutBlock = (layout: TextLayout): { blockW: number; blockH: number } => {
  const { lines, style } = layout;
  const { fontSize, isVertical } = style;
  if (isVertical) {
    return {
      blockW: lines.length * fontSize * LINE_HEIGHT_RATIO,
      blockH: Math.max(0, ...lines.map(l => l.length * fontSize)),
    };
  }
  return { blockW: 0, blockH: lines.length * fontSize * LINE_HEIGHT_RATIO };
};

/**
 * Auto outline: applies only when the caller explicitly set a text colour
 * without an outline width (AI colour module / dock colour toggle) — the
 * width scales with the resolved font size. Colourless legacy regions keep
 * outlineWidth 0, so existing output is unchanged.
 */
const withAutoOutline = (
  full: ResolvedTextStyle,
  style?: EditorTextStyle
): ResolvedTextStyle =>
  style?.color && style.outlineWidth === undefined
    ? { ...full, outlineWidth: Math.min(6, Math.max(1.5, full.fontSize * 0.12)) }
    : full;

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
    return { lines: wrapAt(fontSize).lines, style: withAutoOutline({ ...base, fontSize }, style) };
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
  return { lines: best.lines, style: withAutoOutline({ ...base, fontSize: best.fontSize }, style) };
};

/**
 * Draw previously laid-out text into ctx, inside a boxW×boxH box whose
 * top-left corner is at (0, 0) of the current transform.
 *
 * 横排：每行**靠左**（贴框的左内边距），整块在框内垂直居中。
 * 竖排：整块居中（列从右往左，首字对齐）。
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

  // The block stays CENTERED (vertically for 横排, both axes for 竖排) even when
  // it overflows the box — these offsets are deliberately not clamped to 0. The
  // compositor sizes the patch's overflow margin from measureLayoutBlock() as a
  // symmetric HALF-spill per side (see compositeRegionPatch), so an overflowing
  // block must spill equally on both sides. Clamping made the whole overflow run
  // down (horizontal) or left (vertical): that side got only half the margin it
  // needed — the excess was cut off at the canvas edge — while the opposite
  // margin went unused.
  if (!isVertical) {
    const lineH = fontSize * LINE_HEIGHT_RATIO;
    const blockH = lines.length * lineH;
    let y = padding + (innerH - blockH) / 2;
    for (const line of lines) {
      // 横排靠左：每行贴框的左内边起排（块本身仍然垂直居中）。
      // 只有"整行宽度超出框"的极端情况（无法断行的超长串）会往右溢出 —— 横排
      // 的溢出边距由 measureLayoutBlock 的 blockW 决定，这里保持不夹取，行为
      // 与居中时一致（贴边绘制，多余部分同样被画布裁掉）。
      drawLine(line, padding, y);
      y += lineH;
    }
  } else {
    const colW = fontSize * LINE_HEIGHT_RATIO;
    const blockW = lines.length * colW;
    // Columns flow right → left: column 0 is the rightmost.
    const rightEdge = boxW - padding - (innerW - blockW) / 2;
    // All columns share one baseline: the block is centered by its LONGEST
    // column and every column starts at the same y, so first characters line
    // up horizontally (竖排首字对齐).
    const maxColH = Math.max(...lines.map(l => l.length * fontSize));
    const startY = padding + (innerH - maxColH) / 2;
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
