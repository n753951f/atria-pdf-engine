// Reading someone else's public book (Atria ticket 91, ADR-0025).
// 別人的公開書：呼叫者不是擁有者時，引擎用 admin 權限讀擁有者的書文件 users/{uid}/books/{bookId}，
// 公開（visibility == 'public'）、不在回收桶、不是引用書（沒有 source），而且 pdf.path 就是要讀的 source，才讀 PDF。
// 判斷和 Atria 的安全規則 isPublicBook、邏輯層的 __IsPublicBook 是同一個條件；引擎不 import 它們（AGPL 邊界），自己寫一份。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 書的文件（只用到這幾個欄位；其他欄位不看） */
export interface BookRecord {
  readonly visibility?: unknown;
  readonly trashedAt?: unknown;
  readonly source?: unknown;
  readonly pdf?: { readonly path?: unknown } | null;
}

export interface BookDirectory {
  /** users/{uid}/books/{bookId} 的內容；不存在時 null */
  get(uid: string, bookId: string): Promise<BookRecord | null>;
}

/** 這本書是公開書，而且 source 就是它的原始 PDF */
export function isReadablePublicSource(book: BookRecord | null, source: string): boolean {
  if (!book || book.source !== undefined) return false;
  if (book.visibility !== 'public') return false;
  if (book.trashedAt !== null && book.trashedAt !== undefined) return false;
  return book.pdf?.path === source;
}

/** 測試用的引擎：書的文件放在 dir/books.json（{ "users/<uid>/books/<bookId>": { … } }），每次都重新讀 */
export function directoryBookStore(dir: string): BookDirectory {
  return {
    async get(uid, bookId) {
      let all: Record<string, BookRecord>;
      try {
        all = JSON.parse(await readFile(join(dir, 'books.json'), 'utf8')) as Record<string, BookRecord>;
      } catch {
        return null;
      }
      return all[`users/${uid}/books/${bookId}`] ?? null;
    },
  };
}
