// 文字頁：用 mupdf 的文字層抽單字與座標，並判斷頁面類型。
//
// - 一次跑過頁面的內容（自訂 Device）：數看得見／看不見的字、圖片物件的外框、向量圖形的外框。
// - 再用 structured text 取每個字元的框、字型、字級、顏色；以空白切成單字，上下標另外切開。
// - 看不見的字（render mode 3、只當裁切路徑）與中心點在頁面外的字不輸出。
// - 單字 ID＝頁＋頁內序號（依抽字順序），同一頁抽兩次完全相同。
import type { Font, Path, Text } from 'mupdf';
import { area, clipBox, median, round, toRect, transform, union, type Box, type Rect } from './geometry.ts';
import { mupdf, pageFrame, type MupdfPage } from './pdf.ts';

/** 單字的旗標（位元）；App 端的 schema 用同樣的數值 */
export const WORD_FLAGS = {
  italic: 1,
  bold: 2,
  /** 有顏色（不是黑白灰）的字 */
  accent: 4,
  /** 數學字型、數學符號 */
  math: 8,
  /** 跨行斷字（行尾「字母-」＋下一行小寫開頭），兩段都標 */
  hyphenated: 16,
  /** 上標 */
  superscript: 32,
  /** 下標 */
  subscript: 64,
} as const;

export type PageKind = 'text' | 'scanned';

export interface PageClassification {
  readonly kind: PageKind;
  readonly visibleGlyphs: number;
  readonly invisibleGlyphs: number;
  readonly imageCoverage: number;
}

export interface ExtractedWord {
  /** p0018w0001：頁＋頁內序號（依抽字順序，從 1 起） */
  readonly id: string;
  readonly text: string;
  readonly box: Rect;
  readonly line: number;
  readonly size: number;
  readonly font: string;
  readonly flags: number;
  readonly conf: null;
}

/** p0018w0453 */
export function wordId(page: number, indexInPage: number): string {
  return `p${String(page).padStart(4, '0')}w${String(indexInPage).padStart(4, '0')}`;
}

/** 掃描頁：看得見的字少於這個數，而且影像覆蓋超過 SCANNED_IMAGE_COVERAGE */
export const SCANNED_MAX_VISIBLE_GLYPHS = 30;
export const SCANNED_IMAGE_COVERAGE = 0.5;

/** 頁面內容掃過一次的結果（PDF 座標，原點在頁面左上角） */
export interface PageContent {
  readonly width: number;
  readonly height: number;
  readonly visibleGlyphs: number;
  readonly invisibleGlyphs: number;
  /** 看不見的字的原點（unicode@x,y），抽單字時排除 */
  readonly invisibleKeys: ReadonlySet<string>;
  readonly images: readonly Box[];
  readonly drawings: readonly Box[];
}

/** 判斷規則：看得見的字 < 30 且影像覆蓋 > 50% → 掃描頁；其餘（含空白頁）是文字頁 */
export function classifyByCounts(visibleGlyphs: number, imageCoverage: number): PageKind {
  return imageCoverage > SCANNED_IMAGE_COVERAGE && visibleGlyphs < SCANNED_MAX_VISIBLE_GLYPHS ? 'scanned' : 'text';
}

/** 各頁類型 → 書的 sourceKind */
export function summarizeSourceKind(kinds: readonly PageKind[]): 'text' | 'scanned' | 'mixed' {
  const scanned = kinds.filter((k) => k === 'scanned').length;
  if (scanned === 0) return 'text';
  if (scanned === kinds.length) return 'scanned';
  return 'mixed';
}

function glyphKey(unicode: number, x: number, y: number): string {
  return `${String(unicode)}@${String(Math.round(x * 10))},${String(Math.round(y * 10))}`;
}

/** 白色（或接近白色）的填色：當成背景，不算圖形 */
function isWhite(components: number, color: readonly number[]): boolean {
  if (color.length === 0) return false;
  if (components === 4) return color.every((v) => v <= 0.04);
  return color.every((v) => v >= 0.94);
}

/** 跑一次頁面內容 */
export function scanPageContent(page: MupdfPage): PageContent {
  const frame = pageFrame(page);
  const { width, height } = frame;
  let visibleGlyphs = 0;
  let invisibleGlyphs = 0;
  const invisibleKeys = new Set<string>();
  const images: Box[] = [];
  const drawings: Box[] = [];
  const toPage = (box: Box): Box | null =>
    clipBox([box[0] - frame.x0, box[1] - frame.y0, box[2] - frame.x0, box[3] - frame.y0], width, height);

  const countText = (text: Text, ctm: readonly number[], visible: boolean) => {
    text.walk({
      showGlyph(_font, trm, _glyph, unicode) {
        if (unicode === 32 || unicode === 9 || unicode === 10 || unicode === 13 || unicode === 160) return;
        if (visible) {
          visibleGlyphs += 1;
        } else {
          invisibleGlyphs += 1;
          const [x, y] = transform(ctm, trm[4] ?? 0, trm[5] ?? 0);
          invisibleKeys.add(glyphKey(unicode, x, y));
        }
      },
    });
  };
  const pathBox = (path: Path, ctm: readonly number[], pad: number): Box | null => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const add = (x: number, y: number) => {
      const [px, py] = transform(ctm, x, y);
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    };
    path.walk({
      moveTo: add,
      lineTo: add,
      curveTo(ax, ay, bx, by, cx, cy) {
        add(ax, ay);
        add(bx, by);
        add(cx, cy);
      },
    });
    if (!Number.isFinite(x0)) return null;
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  };
  const imageBox = (ctm: readonly number[]): Box => {
    const corners = [transform(ctm, 0, 0), transform(ctm, 1, 0), transform(ctm, 0, 1), transform(ctm, 1, 1)];
    return [
      Math.min(...corners.map((c) => c[0])),
      Math.min(...corners.map((c) => c[1])),
      Math.max(...corners.map((c) => c[0])),
      Math.max(...corners.map((c) => c[1])),
    ];
  };
  const ctmScale = (ctm: readonly number[]) => Math.sqrt(Math.abs((ctm[0] ?? 1) * (ctm[3] ?? 1) - (ctm[1] ?? 0) * (ctm[2] ?? 0)));

  const device = new mupdf.Device({
    fillText(text, ctm, _cs, _color, alpha) {
      countText(text, ctm, alpha > 0);
    },
    strokeText(text, _stroke, ctm, _cs, _color, alpha) {
      countText(text, ctm, alpha > 0);
    },
    clipText(text, ctm) {
      countText(text, ctm, false);
    },
    clipStrokeText(text, _stroke, ctm) {
      countText(text, ctm, false);
    },
    ignoreText(text, ctm) {
      countText(text, ctm, false);
    },
    fillImage(_image, ctm) {
      const box = toPage(imageBox(ctm));
      if (box && area(box) > 0) images.push(box);
    },
    fillImageMask(_image, ctm) {
      const box = toPage(imageBox(ctm));
      if (box && area(box) > 0) images.push(box);
    },
    fillPath(path, _evenOdd, ctm, colorspace, color) {
      if (isWhite(colorspace.getNumberOfComponents(), color)) return;
      const raw = pathBox(path, ctm, 0);
      const box = raw ? toPage(raw) : null;
      if (box) drawings.push(box);
    },
    strokePath(path, stroke, ctm) {
      const raw = pathBox(path, ctm, (stroke.getLineWidth() * ctmScale(ctm)) / 2);
      const box = raw ? toPage(raw) : null;
      if (box) drawings.push(box);
    },
  });
  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    device.destroy();
  }
  return { width, height, visibleGlyphs, invisibleGlyphs, invisibleKeys, images, drawings };
}

/** 圖片物件的覆蓋率（裁到頁面後的面積總和 ÷ 頁面面積，上限 1） */
export function computeImageCoverage(content: Pick<PageContent, 'width' | 'height' | 'images'>): number {
  const pageArea = content.width * content.height;
  if (pageArea <= 0) return 0;
  const covered = content.images.reduce((sum, box) => sum + area(box), 0);
  return Math.min(1, covered / pageArea);
}

export function classifyContent(content: PageContent): PageClassification {
  const imageCoverage = computeImageCoverage(content);
  return {
    kind: classifyByCounts(content.visibleGlyphs, imageCoverage),
    visibleGlyphs: content.visibleGlyphs,
    invisibleGlyphs: content.invisibleGlyphs,
    imageCoverage: round(imageCoverage, 4),
  };
}

/** 一頁的頁面類型（只看內容，不抽字） */
export function classifyPage(page: MupdfPage): PageClassification {
  return classifyContent(scanPageContent(page));
}

// ── 抽單字 ─────────────────────────────────────────────

const ITALIC_NAME = /italic|oblique|slanted|[-,](it|ita|obl)$/i;
const BOLD_NAME = /bold|black|heavy|semibold|demibold|[-,]bd$/i;
const MATH_NAME =
  /math|^(cmmi|cmsy|cmex|cmbsy|cmmib|msam|msbm|eufm|eusm|euex|rsfs|wasy|esint|stmary|txsy|txex|pxsy|pxex|mtsy|mtex|mt-?extra|symbol|euclid|asana|mathematicalpi)/i;
const SUBSET_PREFIX = /^[A-Z]{6}\+/;
const MATH_RANGES: readonly (readonly [number, number])[] = [
  [0x2200, 0x22ff],
  [0x27c0, 0x27ef],
  [0x2980, 0x2aff],
  [0xe000, 0xf8ff],
  [0x1d400, 0x1d7ff],
];

export function isMathChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return MATH_RANGES.some(([low, high]) => low <= code && code <= high);
}

interface FontInfo {
  readonly name: string;
  readonly italic: boolean;
  readonly bold: boolean;
  readonly math: boolean;
}

interface CharInfo {
  readonly c: string;
  readonly box: Box;
  readonly ox: number;
  readonly oy: number;
  readonly size: number;
  readonly font: FontInfo;
  readonly color: readonly number[];
}

interface LineInfo {
  readonly horizontal: boolean;
  readonly chars: CharInfo[];
}

function isSpace(c: string): boolean {
  return c.trim() === '' || c === ' ';
}

function isAccent(color: readonly number[]): boolean {
  if (color.length < 3) return false;
  const [r = 0, g = 0, b = 0] = color;
  return Math.max(r, g, b) - Math.min(r, g, b) > 40 / 255;
}

type Script = 'base' | 'superscript' | 'subscript';

/** 一行裡每個字元是正常、上標還是下標（只看水平行） */
function scriptsOf(line: LineInfo): Script[] {
  const visible = line.chars.filter((ch) => !isSpace(ch.c));
  if (!line.horizontal || visible.length < 2) return line.chars.map(() => 'base');
  const size = median(visible.map((ch) => ch.size));
  const baseline = median(visible.filter((ch) => ch.size >= 0.9 * size).map((ch) => ch.oy));
  return line.chars.map((ch) => {
    if (ch.size > 0.85 * size) return 'base';
    const shift = ch.oy - baseline;
    if (shift <= -0.12 * size) return 'superscript';
    if (shift >= 0.12 * size) return 'subscript';
    return 'base';
  });
}

function majority(chars: readonly CharInfo[], test: (ch: CharInfo) => boolean): boolean {
  const letters = chars.filter((ch) => /\p{L}/u.test(ch.c));
  const pool = letters.length > 0 ? letters : chars;
  return pool.filter(test).length * 2 >= pool.length;
}

/** 跨行斷字（行尾「字母-」＋下一個單字在不同行、以小寫開頭） */
export function isLineHyphenation(left: Pick<ExtractedWord, 'text' | 'line'>, right: Pick<ExtractedWord, 'text' | 'line'>): boolean {
  const text = left.text;
  return (
    right.line !== left.line &&
    text.length >= 2 &&
    text.endsWith('-') &&
    /\p{L}/u.test(text.at(-2) ?? '') &&
    /^\p{Ll}/u.test(right.text)
  );
}

/** 文字層 → 單字（PDF 座標）。content 是同一頁 scanPageContent 的結果 */
export function extractTextLayer(
  page: MupdfPage,
  pageNumber: number,
  content: PageContent,
): ExtractedWord[] {
  const frame = pageFrame(page);
  const fonts = new Map<string, FontInfo>();
  const fontInfo = (font: Font): FontInfo => {
    const raw = font.getName();
    let info = fonts.get(raw);
    if (!info) {
      const name = raw.replace(SUBSET_PREFIX, '');
      info = {
        name,
        italic: font.isItalic() || ITALIC_NAME.test(name),
        bold: font.isBold() || BOLD_NAME.test(name),
        math: MATH_NAME.test(name),
      };
      fonts.set(raw, info);
    }
    return info;
  };

  const lines: LineInfo[] = [];
  let current: LineInfo | null = null;
  const stext = page.toStructuredText('preserve-whitespace');
  try {
    stext.walk({
      beginLine(_bbox, _wmode, direction) {
        current = { horizontal: Math.abs(direction[1] ?? 0) < 0.05 && (direction[0] ?? 1) > 0, chars: [] };
        lines.push(current);
      },
      endLine() {
        current = null;
      },
      onChar(c, origin, font, size, quad, color) {
        if (!current) return;
        const [ox = 0, oy = 0] = origin;
        const code = c.codePointAt(0) ?? 0;
        if (content.invisibleKeys.has(glyphKey(code, ox, oy))) return;
        const xs = [quad[0], quad[2], quad[4], quad[6]].map((v) => (v ?? 0) - frame.x0);
        const ys = [quad[1], quad[3], quad[5], quad[7]].map((v) => (v ?? 0) - frame.y0);
        current.chars.push({
          c,
          box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          ox: ox - frame.x0,
          oy: oy - frame.y0,
          size,
          font: fontInfo(font),
          color: [...color],
        });
      },
    });
  } finally {
    stext.destroy();
  }

  interface Piece {
    readonly chars: CharInfo[];
    readonly script: Script;
    readonly line: number;
  }
  const pieces: Piece[] = [];
  let lineNumber = 0;
  for (const line of lines) {
    const scripts = scriptsOf(line);
    let token: Piece | null = null;
    let produced = false;
    line.chars.forEach((ch, i) => {
      if (isSpace(ch.c) || ch.c === '') {
        token = null;
        return;
      }
      const script = scripts[i] ?? 'base';
      const previous: Piece | null = token;
      if (!previous || previous.script !== script) {
        token = { chars: [ch], script, line: lineNumber };
        pieces.push(token);
        produced = true;
      } else {
        previous.chars.push(ch);
      }
    });
    if (produced) lineNumber += 1;
  }

  const words: ExtractedWord[] = [];
  for (const piece of pieces) {
    const box = union(piece.chars.map((ch) => ch.box));
    const cx = (box[0] + box[2]) / 2;
    const cy = (box[1] + box[3]) / 2;
    // 中心點在頁面外（CropBox 外）的字：看不到，不輸出
    if (cx < 0 || cx > frame.width || cy < 0 || cy > frame.height) continue;
    const clipped = clipBox(box, frame.width, frame.height) ?? box;
    const text = piece.chars.map((ch) => ch.c).join('');
    const anchor = piece.chars.find((ch) => /[\p{L}\p{N}]/u.test(ch.c)) ?? piece.chars[0];
    if (!anchor) continue;
    let flags = 0;
    if (majority(piece.chars, (ch) => ch.font.italic)) flags |= WORD_FLAGS.italic;
    if (majority(piece.chars, (ch) => ch.font.bold)) flags |= WORD_FLAGS.bold;
    if (isAccent(anchor.color)) flags |= WORD_FLAGS.accent;
    if (piece.chars.some((ch) => ch.font.math || isMathChar(ch.c))) flags |= WORD_FLAGS.math;
    if (piece.script === 'superscript') flags |= WORD_FLAGS.superscript;
    if (piece.script === 'subscript') flags |= WORD_FLAGS.subscript;
    words.push({
      id: wordId(pageNumber, words.length + 1),
      text,
      box: toRect(clipped),
      line: piece.line,
      size: round(anchor.size),
      font: anchor.font.name,
      flags,
      conf: null,
    });
  }
  markHyphenation(words);
  return words;
}

/** 相鄰兩字是跨行斷字時兩段都標 hyphenated */
export function markHyphenation(words: ExtractedWord[]): void {
  for (let i = 0; i + 1 < words.length; i += 1) {
    const left = words[i];
    const right = words[i + 1];
    if (left && right && isLineHyphenation(left, right)) {
      words[i] = { ...left, flags: left.flags | WORD_FLAGS.hyphenated };
      words[i + 1] = { ...right, flags: right.flags | WORD_FLAGS.hyphenated };
    }
  }
}
