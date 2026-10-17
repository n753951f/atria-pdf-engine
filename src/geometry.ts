// 矩形與數值的小工具。座標一律是 PDF 座標（pt，原點在頁面左上角）。
/** [x0, y0, x1, y1] */
export type Box = readonly [number, number, number, number];
/** [x, y, width, height] */
export type Rect = [number, number, number, number];

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor + 0;
}

/** [x0, y0, x1, y1] → [x, y, w, h]（取到 0.01 pt） */
export function toRect(box: Box): Rect {
  return [round(box[0]), round(box[1]), round(Math.max(0, box[2] - box[0])), round(Math.max(0, box[3] - box[1]))];
}

export function union(boxes: readonly Box[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b[0]);
    y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[2]);
    y1 = Math.max(y1, b[3]);
  }
  return boxes.length === 0 ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

/** 裁到 [0, 0, width, height]；完全在外面時 null */
export function clipBox(box: Box, width: number, height: number): Box | null {
  const x0 = Math.max(0, box[0]);
  const y0 = Math.max(0, box[1]);
  const x1 = Math.min(width, box[2]);
  const y1 = Math.min(height, box[3]);
  if (x1 < x0 || y1 < y0 || (x1 === x0 && y1 === y0)) return null;
  return [x0, y0, x1, y1];
}

export function area(box: Box): number {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

/** 矩陣 [a, b, c, d, e, f] 作用在一點 */
export function transform(m: readonly number[], x: number, y: number): [number, number] {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  return [x * a + y * c + e, x * b + y * d + f];
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((p, q) => p - q);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
