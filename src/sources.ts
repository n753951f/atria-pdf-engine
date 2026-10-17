// 原始 PDF 從哪裡來：雲端是 Firebase Storage 的 users/{uid}/books/{bookId}/source.pdf。
// 本機以 sha256 快取（磁碟上的 PDF 檔＋記憶體裡開好的文件），同一本書連續請求時不重新下載、不重新開檔。
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openPdf, type OpenedPdf } from './pdf.ts';

/** 呼叫者只能讀自己的書：users/{uid}/books/{bookId}/<檔名>.pdf */
export const SOURCE_PATH = /^users\/([A-Za-z0-9_-]{1,128})\/books\/([A-Za-z0-9_-]{1,128})\/[A-Za-z0-9_.-]{1,128}\.pdf$/;

export class SourceNotFoundError extends Error {}

/** 儲存位置的一個版本：同一個 path 的內容換了，version 就不同 */
export interface SourceHandle {
  readonly path: string;
  readonly version: string;
  readonly bytes: number;
  download(): Promise<Uint8Array>;
}

export interface SourceStore {
  /** 找不到時丟 SourceNotFoundError */
  stat(path: string): Promise<SourceHandle>;
}

export interface OpenedSource {
  readonly sha256: string;
  readonly pdf: OpenedPdf;
  /** 用完一定要呼叫（被擠出快取的文件等沒人用了才關） */
  release(): void;
}

export interface SourceCacheOptions {
  /** 磁碟快取的資料夾 */
  readonly dir: string;
  /** 磁碟快取的上限（位元組）；超過時刪最久沒用的 */
  readonly maxBytes: number;
  /** 記憶體裡最多同時開幾份文件（正在用的不算在內，不會被關掉） */
  readonly maxOpen: number;
}

interface OpenEntry {
  readonly pdf: OpenedPdf;
  users: number;
  evicted: boolean;
}

/** 以 sha256 快取的來源：path+version → sha256 → 開好的文件 */
export class SourceCache {
  private readonly store: SourceStore;
  private readonly options: SourceCacheOptions;
  private readonly hashes = new Map<string, string>();
  private readonly open = new Map<string, OpenEntry>();

  constructor(store: SourceStore, options: SourceCacheOptions) {
    this.store = store;
    this.options = options;
  }

  async get(path: string): Promise<OpenedSource> {
    const handle = await this.store.stat(path);
    const key = `${handle.path}#${handle.version}`;
    let sha256 = this.hashes.get(key);
    if (sha256) {
      const entry = this.open.get(sha256);
      if (entry) {
        // 最近用過的排到最後
        this.open.delete(sha256);
        this.open.set(sha256, entry);
        return this.lease(sha256, entry);
      }
      const cached = await this.readDisk(sha256);
      if (cached) return this.lease(sha256, this.remember(sha256, cached));
    }
    const bytes = await handle.download();
    sha256 = createHash('sha256').update(bytes).digest('hex');
    this.hashes.set(key, sha256);
    const existing = this.open.get(sha256);
    if (existing) return this.lease(sha256, existing);
    await this.writeDisk(sha256, bytes);
    return this.lease(sha256, this.remember(sha256, bytes));
  }

  /** 關掉所有沒人在用的文件 */
  close(): void {
    for (const [sha256, entry] of this.open) {
      entry.evicted = true;
      if (entry.users === 0) entry.pdf.close();
      this.open.delete(sha256);
    }
  }

  private lease(sha256: string, entry: OpenEntry): OpenedSource {
    entry.users += 1;
    let released = false;
    return {
      sha256,
      pdf: entry.pdf,
      release: () => {
        if (released) return;
        released = true;
        entry.users -= 1;
        if (entry.evicted && entry.users === 0) entry.pdf.close();
      },
    };
  }

  private remember(sha256: string, bytes: Uint8Array): OpenEntry {
    const entry: OpenEntry = { pdf: openPdf(bytes), users: 0, evicted: false };
    this.open.set(sha256, entry);
    for (const [oldest, old] of this.open) {
      if (this.open.size <= this.options.maxOpen) break;
      if (old === entry) continue;
      this.open.delete(oldest);
      old.evicted = true;
      if (old.users === 0) old.pdf.close();
    }
    return entry;
  }

  private file(sha256: string): string {
    return join(this.options.dir, `${sha256}.pdf`);
  }

  private async readDisk(sha256: string): Promise<Uint8Array | null> {
    try {
      const bytes = new Uint8Array(await readFile(this.file(sha256)));
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) return null;
      const now = new Date();
      await utimes(this.file(sha256), now, now).catch(() => undefined);
      return bytes;
    } catch {
      return null;
    }
  }

  private async writeDisk(sha256: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length > this.options.maxBytes) return;
    try {
      await mkdir(this.options.dir, { recursive: true });
      const temp = `${this.file(sha256)}.${String(process.pid)}.tmp`;
      await writeFile(temp, bytes);
      await rename(temp, this.file(sha256));
      await this.evict();
    } catch {
      // 快取寫不進去不影響這次請求
    }
  }

  private async evict(): Promise<void> {
    const names = (await readdir(this.options.dir)).filter((name) => name.endsWith('.pdf'));
    const files = await Promise.all(
      names.map(async (name) => {
        const info = await stat(join(this.options.dir, name));
        return { name, size: info.size, used: info.mtimeMs };
      }),
    );
    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const f of files.sort((a, b) => a.used - b.used)) {
      if (total <= this.options.maxBytes) break;
      await rm(join(this.options.dir, f.name), { force: true });
      total -= f.size;
    }
  }
}

/** 本機資料夾當來源（測試用的引擎）：path 直接對應到 dir 底下的檔案 */
export function directorySourceStore(dir: string): SourceStore {
  return {
    async stat(path) {
      const file = join(dir, ...path.split('/'));
      let info;
      try {
        info = await stat(file);
      } catch {
        throw new SourceNotFoundError(`找不到 ${path}`);
      }
      return {
        path,
        version: `${String(info.mtimeMs)}-${String(info.size)}`,
        bytes: info.size,
        download: async () => new Uint8Array(await readFile(file)),
      };
    },
  };
}
