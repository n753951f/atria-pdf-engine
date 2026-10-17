// mupdf（WASM）的開檔、算圖、書籤、頁碼標籤與純文字。
import * as mupdf from 'mupdf';

export type MupdfDocument = mupdf.Document;
export type MupdfPage = mupdf.Page;
export type MupdfPixmap = mupdf.Pixmap;
export { mupdf };

export class PageOutOfRangeError extends Error {
  readonly page: number;
  readonly pageCount: number;
  constructor(page: number, pageCount: number) {
    super(`PDF 頁 ${String(page)} 不在 1–${String(pageCount)} 之內`);
    this.page = page;
    this.pageCount = pageCount;
  }
}

export interface OpenedPdf {
  readonly doc: MupdfDocument;
  readonly pageCount: number;
  /** 一頁（從 1 起）；用完呼叫 destroy() */
  loadPage(page: number): MupdfPage;
  close(): void;
}

export function openPdf(bytes: Uint8Array): OpenedPdf {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const pageCount = doc.countPages();
  return {
    doc,
    pageCount,
    loadPage(page) {
      if (!Number.isInteger(page) || page < 1 || page > pageCount) throw new PageOutOfRangeError(page, pageCount);
      return doc.loadPage(page - 1);
    },
    close() {
      doc.destroy();
    },
  };
}

/** 依序用一頁，用完就釋放 */
export function withPage<T>(pdf: OpenedPdf, page: number, use: (loaded: MupdfPage) => T): T {
  const loaded = pdf.loadPage(page);
  try {
    return use(loaded);
  } finally {
    loaded.destroy();
  }
}

/** 頁面的大小與原點（pt）；PDF 座標＝mupdf 座標－原點 */
export function pageFrame(page: MupdfPage): { x0: number; y0: number; width: number; height: number } {
  const [x0, y0, x1, y1] = page.getBounds();
  return { x0, y0, width: x1 - x0, height: y1 - y0 };
}

/** 以 dpi 算圖（RGB、不透明、含註解）→ PNG */
export function renderPng(page: MupdfPage, dpi: number): Uint8Array {
  const scale = dpi / 72;
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    return pixmap.asPNG();
  } finally {
    pixmap.destroy();
  }
}

/** PDF 書籤（大綱）的一列：depth 從 0 起；pdfPage 從 1 起，指不到頁時 null */
export interface OutlineEntry {
  readonly depth: number;
  readonly title: string;
  readonly pdfPage: number | null;
}

/** 讀 PDF 書籤，依文件順序攤平；沒有書籤時空陣列 */
export function readOutline(pdf: OpenedPdf): OutlineEntry[] {
  let root: ReturnType<MupdfDocument['loadOutline']>;
  try {
    root = pdf.doc.loadOutline();
  } catch {
    return [];
  }
  const out: OutlineEntry[] = [];
  const walk = (items: NonNullable<typeof root>, depth: number) => {
    for (const item of items) {
      let index = item.page ?? -1;
      if (index < 0 && item.uri) {
        try {
          index = pdf.doc.resolveLink(item.uri);
        } catch {
          index = -1;
        }
      }
      const title = (item.title ?? '').replace(/\s+/g, ' ').trim();
      if (title !== '') {
        out.push({ depth, title, pdfPage: index >= 0 && index < pdf.pageCount ? index + 1 : null });
      }
      if (item.down) walk(item.down, depth + 1);
    }
  };
  if (root) walk(root, 0);
  return out;
}

/** 一頁的 PDF 頁碼標籤（PageLabels；沒有時是空字串或頁序） */
export function pageLabel(page: MupdfPage): string {
  try {
    return page.getLabel().trim();
  } catch {
    return '';
  }
}

/** 一頁的純文字（文字層；掃描頁是空字串） */
export function pageText(page: MupdfPage): string {
  const stext = page.toStructuredText('preserve-whitespace');
  try {
    return stext.asText();
  } finally {
    stext.destroy();
  }
}
