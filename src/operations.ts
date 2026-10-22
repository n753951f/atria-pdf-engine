// 引擎的五個動作（不管 HTTP、驗證、配額）：輸入是開好的 PDF，輸出是可以序列化的結果＋圖片／SVG 檔。
// 「PDF 進、座標／圖片／SVG 出」：這裡沒有版面判斷、OCR、AI 或翻譯。
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { area, round, toRect, type Rect } from './geometry.ts';
import { mupdf, pageFrame, pageLabel, pageText, readOutline, renderPng, withPage, type OpenedPdf, type OutlineEntry } from './pdf.ts';
import { classifyContent, extractTextLayer, scanPageContent, type ExtractedWord, type PageClassification } from './text-layer.ts';

/** 給 AI 看的頁面圖 */
export const PAGE_IMAGE_DPI = 150;
/** 掃描頁給 OCR 的圖 */
export const OCR_IMAGE_DPI = 300;
/** 一次回應裡檔案＋JSON 的上限（Cloud Run 的回應上限是 32 MiB，留餘裕） */
export const RESPONSE_BUDGET_BYTES = 24 * 1024 * 1024;
/** 一次請求最多做多久（Cloud Run 逾時 300 秒，留餘裕）；做不完的頁放進 next */
export const TIME_BUDGET_MS = 200_000;

/** 回應裡的一個檔案（multipart 的一個部分） */
export interface OutputFile {
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array;
}

export interface OperationResult<T> {
  readonly meta: T;
  readonly files: readonly OutputFile[];
  /** 計入每日上限的頁數 */
  readonly pagesProcessed: number;
}

/** 檔名：p0041.png、p0041@300.png、p0041.svg */
export function pageFileName(page: number, suffix: string): string {
  return `p${String(page).padStart(4, '0')}${suffix}`;
}

export interface Budget {
  readonly bytes: number;
  readonly deadline: number;
}

export function defaultBudget(now = Date.now()): Budget {
  return { bytes: RESPONSE_BUDGET_BYTES, deadline: now + TIME_BUDGET_MS };
}

// ── info ───────────────────────────────────────────────

export interface InfoMeta {
  readonly pageCount: number;
  /** 第一頁的大小（pt）；各頁不同時看 pageSizes */
  readonly pageSizes: readonly { readonly width: number; readonly height: number }[];
  readonly outline: readonly OutlineEntry[];
  /** 每頁的 PDF 頁碼標籤（沒有時空字串） */
  readonly labels: readonly string[];
}

export async function infoOf(pdf: OpenedPdf): Promise<OperationResult<InfoMeta>> {
  const pageSizes: { width: number; height: number }[] = [];
  const labels: string[] = [];
  for (let page = 1; page <= pdf.pageCount; page += 1) {
    withPage(pdf, page, (loaded) => {
      const frame = pageFrame(loaded);
      pageSizes.push({ width: round(frame.width), height: round(frame.height) });
      labels.push(pageLabel(loaded));
    });
    if (page % 50 === 0) await yieldToLoop();
  }
  return { meta: { pageCount: pdf.pageCount, pageSizes, outline: readOutline(pdf), labels }, files: [], pagesProcessed: 0 };
}

// ── classify ───────────────────────────────────────────

export interface ClassifyMeta {
  readonly pageCount: number;
  readonly pages: readonly PageClassification[];
}

export async function classifyPdf(pdf: OpenedPdf): Promise<OperationResult<ClassifyMeta>> {
  const pages: PageClassification[] = [];
  for (let page = 1; page <= pdf.pageCount; page += 1) {
    pages.push(withPage(pdf, page, (loaded) => classifyContent(scanPageContent(loaded))));
    if (page % 10 === 0) await yieldToLoop();
  }
  return { meta: { pageCount: pdf.pageCount, pages }, files: [], pagesProcessed: pdf.pageCount };
}

// ── pages（指定頁的文字與頁面圖；匯入目錄用） ─────────────

export interface PagesRequest {
  readonly pages: readonly number[];
  /** 要不要整頁純文字 */
  readonly text: boolean;
  /** 頁面圖的 dpi；null＝不要圖 */
  readonly imageDpi: number | null;
}

export interface PagesMetaPage {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly text: string | null;
  /** 頁面圖的檔名（multipart 的部分名稱） */
  readonly image: string | null;
}

export interface PagesMeta {
  readonly pages: readonly PagesMetaPage[];
  /** 這次沒做到的頁（超過回應大小或時間）；照樣再請求一次 */
  readonly next: readonly number[];
}

export async function pagesOf(pdf: OpenedPdf, request: PagesRequest, budget = defaultBudget()): Promise<OperationResult<PagesMeta>> {
  const out: PagesMetaPage[] = [];
  const files: OutputFile[] = [];
  const list = unique(request.pages);
  for (const p of list) pdf.loadPage(p).destroy(); // 先檢查頁碼
  let used = 0;
  let index = 0;
  for (; index < list.length; index += 1) {
    const page = list[index] ?? 0;
    if (out.length > 0 && Date.now() > budget.deadline) break;
    const result = withPage(pdf, page, (loaded) => {
      const frame = pageFrame(loaded);
      const png = request.imageDpi === null ? null : renderPng(loaded, request.imageDpi);
      return {
        meta: {
          page,
          width: round(frame.width),
          height: round(frame.height),
          label: pageLabel(loaded),
          text: request.text ? pageText(loaded) : null,
          image: png ? pageFileName(page, '.png') : null,
        },
        png,
      };
    });
    const size = (result.png?.length ?? 0) + (result.meta.text?.length ?? 0) * 3;
    if (out.length > 0 && used + size > budget.bytes) break;
    used += size;
    out.push(result.meta);
    if (result.png && result.meta.image) files.push({ name: result.meta.image, type: 'image/png', bytes: result.png });
    await yieldToLoop();
  }
  return { meta: { pages: out, next: list.slice(index) }, files, pagesProcessed: out.length };
}

// ── extract ────────────────────────────────────────────

export interface ExtractMetaPage {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly classification: PageClassification;
  /** 文字頁的單字（掃描頁是空陣列，OCR 在 App 端做） */
  readonly words: readonly ExtractedWord[];
  /** 向量圖形（線、框、填色）的外框 */
  readonly drawings: readonly Rect[];
  /** 圖片物件的外框（掃描頁的整頁影像也在內） */
  readonly images: readonly Rect[];
  /** 150 dpi 頁面圖的檔名 */
  readonly image: string;
  /** 掃描頁另給 300 dpi 的圖（OCR 用）；文字頁 null */
  readonly ocrImage: string | null;
}

export interface ExtractMeta {
  readonly pages: readonly ExtractMetaPage[];
  readonly next: readonly number[];
}

export async function extractPages(
  pdf: OpenedPdf,
  pages: readonly number[],
  budget = defaultBudget(),
): Promise<OperationResult<ExtractMeta>> {
  const out: ExtractMetaPage[] = [];
  const files: OutputFile[] = [];
  const list = unique(pages);
  for (const p of list) pdf.loadPage(p).destroy();
  let used = 0;
  let index = 0;
  for (; index < list.length; index += 1) {
    const page = list[index] ?? 0;
    if (out.length > 0 && Date.now() > budget.deadline) break;
    const result = withPage(pdf, page, (loaded) => {
      const frame = pageFrame(loaded);
      const content = scanPageContent(loaded);
      const classification = classifyContent(content);
      const words = classification.kind === 'text' ? extractTextLayer(loaded, page, content) : [];
      const png = renderPng(loaded, PAGE_IMAGE_DPI);
      const png300 = classification.kind === 'scanned' ? renderPng(loaded, OCR_IMAGE_DPI) : null;
      const meta: ExtractMetaPage = {
        page,
        width: frame.width,
        height: frame.height,
        classification,
        words,
        drawings: content.drawings.map((box) => toRect(box)),
        images: content.images.filter((box) => area(box) > 0).map((box) => toRect(box)),
        image: pageFileName(page, '.png'),
        ocrImage: png300 ? pageFileName(page, '@300.png') : null,
      };
      return { meta, png, png300 };
    });
    const json = JSON.stringify(result.meta).length;
    const size = result.png.length + (result.png300?.length ?? 0) + json;
    if (out.length > 0 && used + size > budget.bytes) break;
    used += size;
    out.push(result.meta);
    files.push({ name: result.meta.image, type: 'image/png', bytes: result.png });
    if (result.png300 && result.meta.ocrImage) files.push({ name: result.meta.ocrImage, type: 'image/png', bytes: result.png300 });
    await yieldToLoop();
  }
  return { meta: { pages: out, next: list.slice(index) }, files, pagesProcessed: out.length };
}

// ── render（頁面或裁切範圍 → SVG，文字轉路徑） ───────────────

export interface RenderItem {
  readonly page: number;
  /** PDF 座標的裁切範圍 [x, y, w, h]；沒有時整頁 */
  readonly clip?: Rect | null | undefined;
}

export interface RenderMetaItem {
  readonly page: number;
  /** 實際的範圍（PDF 座標；裁到頁面內） */
  readonly box: Rect;
  /** SVG 的檔名（r000.svg…，依請求的順序） */
  readonly svg: string;
  readonly bytes: number;
}

export interface RenderMeta {
  readonly items: readonly RenderMetaItem[];
  /** 這次沒做到的項目在請求裡的索引 */
  readonly next: readonly number[];
  /** 畫的時候跳過的物件（工單 67）；沒有時是空陣列 */
  readonly warnings: readonly RenderWarning[];
}

/**
 * 可以跳過的物件種類：只有「畫」的呼叫。裁切、群組、遮罩、圖樣（tile）跳過會讓後面的內容錯亂，所以不跳過，
 * 那些出錯時整項回 render_failed。
 */
export type RenderObjectKind = 'shading' | 'image' | 'path' | 'text';

/** render 時跳過的物件：同一項、同一種類合成一筆 */
export interface RenderWarning {
  /** 請求裡第幾項（從 0 起） */
  readonly item: number;
  readonly page: number;
  readonly skipped: RenderObjectKind;
  /** 跳過幾個 */
  readonly count: number;
  /** mupdf 的錯誤訊息（第一個） */
  readonly reason: string;
}

export class InvalidClipError extends Error {}

/** 跳過畫不出來的物件之後還是畫不出來（或頁面本身讀不了）：伺服器回 422 render_failed */
export class RenderFailedError extends Error {
  readonly page: number;
  /** 請求裡第幾項；renderSvg 單獨呼叫時 null */
  readonly item: number | null;
  readonly reason: string;
  constructor(page: number, reason: string, item: number | null = null) {
    super(`PDF 頁 ${String(page)} 畫不出來：${reason}`);
    this.page = page;
    this.item = item;
    this.reason = reason;
  }
}

/**
 * 轉 SVG 時的影像：mupdf 的 SVG 輸出把 JPEG 原封不動嵌進去，CMYK（4 色）的 JPEG 在瀏覽器裡顏色會反相
 * （PDF 用 /Decode 把 Adobe 反相的 CMYK 轉回來，嵌進 SVG 後這個資訊就不見了）。
 * 所以 CMYK 的影像先依 PDF 的設定（含 /Decode）解成 RGB 點陣，再交給 SVG 輸出（變成 PNG）。
 */
function svgSafeImage(image: mupdf.Image): mupdf.Image {
  const colorspace = image.getColorSpace();
  if (image.getImageMask() || !colorspace || colorspace.getNumberOfComponents() !== 4) return image;
  const pixmap = image.toPixmap();
  try {
    const rgb = pixmap.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
    const mask = image.getMask();
    return mask ? new mupdf.Image(rgb, mask) : new mupdf.Image(rgb);
  } finally {
    pixmap.destroy();
  }
}

/**
 * 工單 67：mupdf.js 1.28.1 自訂 Device 的 fillShade callback 用 `new Shade(pointer)` 包住 mupdf 借給它的指標，
 * 卻沒有像 Path、Text、Image 那樣先 keep。這個包裝被 GC 回收時 finalizer 會多 drop 一次：shade 被提早釋放，
 * 但 PDF 的資源快取還指著它（use-after-free）。之後再畫到同一個 shading（引擎會快取打開的 PDF，重試也一樣）
 * 就讀到被覆寫的記憶體——Cloud Run 上的「Unexpected mesh type 97／115」，或 wasm 直接當掉。
 * 所以 callback 收到的 Shade 一律取消 finalizer 的登記：這個包裝只是借用，不擁有參考。
 */
export function borrowShade(shade: mupdf.Shade): void {
  const registry = (shade.constructor as { _finalizer?: FinalizationRegistry<unknown> })._finalizer;
  registry?.unregister(shade);
}

type DeviceColor = Parameters<mupdf.Device['fillPath']>[4];
/** callback 給的顏色是 number[]，device 的方法要 Color（長度 1–4 的 tuple） */
function deviceColor(color: number[]): DeviceColor {
  return color as unknown as DeviceColor;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 300);
}

/** 這一次要跳過哪些「畫」的呼叫：依序編號（同一頁、同一個範圍每次的順序都一樣），或整個種類 */
interface SkipRule {
  readonly calls: ReadonlySet<number>;
  readonly kinds: ReadonlySet<RenderObjectKind>;
}

interface AttemptLog {
  /** 畫不出來的呼叫（編號、種類、mupdf 的訊息） */
  readonly failures: { index: number; kind: RenderObjectKind; reason: string }[];
  /** 依規則跳過的呼叫 */
  readonly skipped: { index: number; kind: RenderObjectKind }[];
  /** 裁切、群組這類不能跳過的呼叫出錯（第一個） */
  structural: string | null;
}

/**
 * 把所有呼叫轉給 SVG 輸出的 device：影像先經過 svgSafeImage、Shade 先 borrowShade。
 * 每個呼叫都包 try/catch，callback 永遠不丟錯（丟出去的錯會穿過 mupdf 的 wasm 堆疊、跳過它的清理）；
 * 出錯的記在 log，由 renderSvg 決定跳過重畫還是回 render_failed。
 */
function svgProxyDevice(target: mupdf.Device, skip: SkipRule, log: AttemptLog): mupdf.Device {
  let next = 0;
  const draw = (kind: RenderObjectKind, call: () => void) => {
    const index = next;
    next += 1;
    if (skip.calls.has(index) || skip.kinds.has(kind)) {
      log.skipped.push({ index, kind });
      return;
    }
    try {
      call();
    } catch (error) {
      log.failures.push({ index, kind, reason: errorText(error) });
    }
  };
  const structure = <T>(call: () => T, fallback: T): T => {
    try {
      return call();
    } catch (error) {
      log.structural ??= errorText(error);
      return fallback;
    }
  };
  return new mupdf.Device({
    fillPath: (path, evenOdd, ctm, colorspace, color, alpha) =>
      draw('path', () => target.fillPath(path, evenOdd, ctm, colorspace, deviceColor(color), alpha)),
    strokePath: (path, stroke, ctm, colorspace, color, alpha) =>
      draw('path', () => target.strokePath(path, stroke, ctm, colorspace, deviceColor(color), alpha)),
    clipPath: (path, evenOdd, ctm) => structure(() => target.clipPath(path, evenOdd, ctm), undefined),
    clipStrokePath: (path, stroke, ctm) => structure(() => target.clipStrokePath(path, stroke, ctm), undefined),
    fillText: (text, ctm, colorspace, color, alpha) => draw('text', () => target.fillText(text, ctm, colorspace, deviceColor(color), alpha)),
    strokeText: (text, stroke, ctm, colorspace, color, alpha) =>
      draw('text', () => target.strokeText(text, stroke, ctm, colorspace, deviceColor(color), alpha)),
    clipText: (text, ctm) => structure(() => target.clipText(text, ctm), undefined),
    clipStrokeText: (text, stroke, ctm) => structure(() => target.clipStrokeText(text, stroke, ctm), undefined),
    ignoreText: (text, ctm) => structure(() => target.ignoreText(text, ctm), undefined),
    fillShade: (shade, ctm, alpha) => {
      borrowShade(shade);
      draw('shading', () => target.fillShade(shade, ctm, alpha));
    },
    fillImage: (image, ctm, alpha) => draw('image', () => target.fillImage(svgSafeImage(image), ctm, alpha)),
    fillImageMask: (image, ctm, colorspace, color, alpha) =>
      draw('image', () => target.fillImageMask(image, ctm, colorspace, deviceColor(color), alpha)),
    clipImageMask: (image, ctm) => structure(() => target.clipImageMask(image, ctm), undefined),
    popClip: () => structure(() => target.popClip(), undefined),
    beginMask: (bbox, luminosity, colorspace, color) => structure(() => target.beginMask(bbox, luminosity, colorspace, deviceColor(color)), undefined),
    endMask: () => structure(() => target.endMask(), undefined),
    beginGroup: (bbox, colorspace, isolated, knockout, blendmode, alpha) =>
      structure(() => target.beginGroup(bbox, colorspace, isolated, knockout, blendmode, alpha), undefined),
    endGroup: () => structure(() => target.endGroup(), undefined),
    beginTile: (area, view, xstep, ystep, ctm, id, docId) => structure(() => target.beginTile(area, view, xstep, ystep, ctm, id, docId), 0),
    endTile: () => structure(() => target.endTile(), undefined),
    beginLayer: (name) => structure(() => target.beginLayer(name), undefined),
    endLayer: () => structure(() => target.endLayer(), undefined),
  });
}

/** 畫一次：範圍 [x, y, w, h]（PDF 座標）→ SVG；出錯的呼叫記在 log */
function renderSvgAttempt(loaded: mupdf.Page, origin: { x0: number; y0: number }, box: Rect, skip: SkipRule): { svg: string | null; log: AttemptLog } {
  const [x, y, w, h] = box;
  const log: AttemptLog = { failures: [], skipped: [], structural: null };
  const buffer = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buffer, 'svg', 'text=path');
  try {
    const device = writer.beginPage([0, 0, w, h]);
    const rect = new mupdf.Path();
    rect.rect(0, 0, w, h);
    device.clipPath(rect, false, mupdf.Matrix.identity);
    rect.destroy();
    // mupdf 座標＝PDF 座標＋頁面原點
    const proxy = svgProxyDevice(device, skip, log);
    try {
      loaded.run(proxy, mupdf.Matrix.translate(-(x + origin.x0), -(y + origin.y0)));
      proxy.close();
    } catch (error) {
      // 頁面內容本身讀不了（不是某個物件畫不出來）
      log.structural ??= errorText(error);
    } finally {
      proxy.destroy();
    }
    device.popClip();
    writer.endPage();
    writer.close();
    return { svg: buffer.asString(), log };
  } catch (error) {
    log.structural ??= errorText(error);
    return { svg: null, log };
  } finally {
    writer.destroy();
    buffer.destroy();
  }
}

/** 最多畫幾次：第 1 次照畫；第 2、3 次跳過前面畫不出來的那幾個物件；第 4 次跳過出過錯的整個種類 */
export const MAX_RENDER_ATTEMPTS = 4;

export interface SvgRender {
  readonly svg: string;
  readonly box: Rect;
  /** 跳過的物件（依種類合計；沒有時空陣列） */
  readonly skipped: readonly { readonly kind: RenderObjectKind; readonly count: number; readonly reason: string }[];
}

/**
 * 一頁（或裁切範圍）→ SVG 字串：文字轉成字形路徑，原點在範圍的左上角，單位 pt。
 * 工單 67：單一物件（漸層、影像…）畫不出來時不讓整頁失敗：跳過那個物件重畫，跳過的記在 skipped；
 * 跳過之後還是不行、或是裁切／群組這類不能跳過的出錯、或頁面內容本身讀不了 → RenderFailedError。
 */
export function renderSvg(pdf: OpenedPdf, page: number, clip: Rect | null): SvgRender {
  return withPage(pdf, page, (loaded) => {
    const frame = pageFrame(loaded);
    let [x, y, w, h] = clip ?? [0, 0, frame.width, frame.height];
    const x1 = Math.min(frame.width, x + w);
    const y1 = Math.min(frame.height, y + h);
    x = Math.max(0, x);
    y = Math.max(0, y);
    w = x1 - x;
    h = y1 - y;
    if (!(w > 0 && h > 0)) throw new InvalidClipError(`PDF 頁 ${String(page)} 的裁切範圍在頁面外或是空的`);
    const box: Rect = [round(x), round(y), round(w), round(h)];
    const calls = new Set<number>();
    const kinds = new Set<RenderObjectKind>();
    const reasons = new Map<RenderObjectKind, string>();
    for (let attempt = 1; ; attempt += 1) {
      const { svg, log } = renderSvgAttempt(loaded, frame, [x, y, w, h], { calls, kinds });
      if (log.structural !== null || svg === null) throw new RenderFailedError(page, log.structural ?? '沒有輸出');
      if (log.failures.length === 0) {
        const counts = new Map<RenderObjectKind, number>();
        for (const s of log.skipped) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
        const skipped = [...counts].map(([kind, count]) => ({ kind, count, reason: reasons.get(kind) ?? '' }));
        return { svg, box, skipped };
      }
      for (const f of log.failures) if (!reasons.has(f.kind)) reasons.set(f.kind, f.reason);
      if (attempt >= MAX_RENDER_ATTEMPTS) {
        const first = log.failures[0];
        throw new RenderFailedError(page, `跳過畫不出來的物件之後還是失敗（${first ? first.reason : ''}）`);
      }
      if (attempt + 1 < MAX_RENDER_ATTEMPTS) for (const f of log.failures) calls.add(f.index);
      else for (const kind of reasons.keys()) kinds.add(kind);
    }
  });
}

export async function renderItems(
  pdf: OpenedPdf,
  items: readonly RenderItem[],
  budget = defaultBudget(),
): Promise<OperationResult<RenderMeta>> {
  for (const item of items) pdf.loadPage(item.page).destroy();
  const out: RenderMetaItem[] = [];
  const files: OutputFile[] = [];
  const warnings: RenderWarning[] = [];
  const encoder = new TextEncoder();
  let used = 0;
  let index = 0;
  for (; index < items.length; index += 1) {
    const item = items[index];
    if (!item) break;
    if (out.length > 0 && Date.now() > budget.deadline) break;
    let rendered: SvgRender;
    try {
      rendered = renderSvg(pdf, item.page, item.clip ?? null);
    } catch (error) {
      if (error instanceof RenderFailedError) throw new RenderFailedError(error.page, error.reason, index);
      throw error;
    }
    const bytes = encoder.encode(rendered.svg);
    if (out.length > 0 && used + bytes.length > budget.bytes) break;
    used += bytes.length;
    const name = `r${String(index).padStart(3, '0')}.svg`;
    out.push({ page: item.page, box: rendered.box, svg: name, bytes: bytes.length });
    files.push({ name, type: 'image/svg+xml', bytes });
    for (const s of rendered.skipped) warnings.push({ item: index, page: item.page, skipped: s.kind, count: s.count, reason: s.reason });
    await yieldToLoop();
  }
  return {
    meta: { items: out, next: items.slice(index).map((_, i) => index + i), warnings },
    files,
    pagesProcessed: out.length,
  };
}

function unique(pages: readonly number[]): number[] {
  return [...new Set(pages)].sort((a, b) => a - b);
}
