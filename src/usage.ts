// 防濫用：每位使用者同時 1 個請求、每日頁數上限（台北時間的日期）。
// 管理員（ID token 有 admin 自訂宣告）不受每日頁數上限，但照樣記帳、照樣只能同時 1 個請求（工單 85）。
// 雲端用 Firestore 的 users/{uid}/engine/usage（前端的安全規則沒有開放這個路徑），本機測試用記憶體。

/** 每位使用者每天最多處理幾頁 */
export const DAILY_PAGE_LIMIT = 3000;
/** 「處理中」的租約多久過期（請求逾時 300 秒＋餘裕；執行個體當掉時不會永遠卡住） */
export const BUSY_LEASE_MS = 330_000;

export class BusyError extends Error {}

export class DailyLimitError extends Error {
  readonly used: number;
  readonly limit: number;
  readonly requested: number;
  constructor(used: number, limit: number, requested: number) {
    super(
      `今天（台北時間）已經處理 ${String(used)} 頁，每日上限 ${String(limit)} 頁` +
        (requested > 0 ? `，這次要 ${String(requested)} 頁` : '') +
        '；明天 0 點（台北時間）後再試。',
    );
    this.used = used;
    this.limit = limit;
    this.requested = requested;
  }
}

/** 一次請求拿到的使用權：先確認頁數、做完記帳並釋放 */
export interface UsageLease {
  /** 今天已經用掉的頁數（不含這次） */
  readonly used: number;
  readonly limit: number;
  /** 不受每日上限（管理員）：reserve 永遠通過 */
  readonly unlimited: boolean;
  /** 這次要做的頁數超過剩下的額度時丟 DailyLimitError（不記帳、不釋放，由 finish 處理）；unlimited 時不丟 */
  reserve(pages: number): void;
  /** 記下實際處理的頁數並釋放「處理中」 */
  finish(pagesProcessed: number): Promise<void>;
}

export interface AcquireOptions {
  /** 不受每日頁數上限（ID token 有 admin 宣告）；同時 1 個請求與記帳照舊 */
  readonly unlimited?: boolean;
}

export interface UsageStore {
  /** 同一個使用者已經有請求在處理時丟 BusyError；今天的額度用完時丟 DailyLimitError（unlimited 時不丟） */
  acquire(uid: string, options?: AcquireOptions): Promise<UsageLease>;
}

/** 台北時間的日期 YYYY-MM-DD */
export function taipeiDay(now = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

function lease(used: number, limit: number, unlimited: boolean, finish: (pages: number) => Promise<void>): UsageLease {
  let done = false;
  return {
    used,
    limit,
    unlimited,
    reserve(pages) {
      if (!unlimited && used + pages > limit) throw new DailyLimitError(used, limit, pages);
    },
    async finish(pages) {
      if (done) return;
      done = true;
      await finish(pages);
    },
  };
}

/** 記憶體版（本機測試用的引擎、單元測試） */
export function memoryUsageStore(limit = DAILY_PAGE_LIMIT, now: () => number = Date.now): UsageStore {
  const days = new Map<string, { day: string; pages: number; busy: boolean }>();
  return {
    acquire(uid, options = {}) {
      const unlimited = options.unlimited === true;
      const day = taipeiDay(now());
      let row = days.get(uid);
      if (!row || row.day !== day) {
        row = { day, pages: 0, busy: false };
        days.set(uid, row);
      }
      if (row.busy) return Promise.reject(new BusyError('同一個帳號已經有一個 PDF 引擎請求在處理'));
      if (!unlimited && row.pages >= limit) return Promise.reject(new DailyLimitError(row.pages, limit, 0));
      row.busy = true;
      const current = row;
      return Promise.resolve(
        lease(current.pages, limit, unlimited, (pages) => {
          current.pages += pages;
          current.busy = false;
          return Promise.resolve();
        }),
      );
    },
  };
}

/** Firestore 的一份文件（只用到這幾個操作，方便測試換掉） */
export interface UsageDocStore {
  /** 在交易裡讀－改－寫；update 回傳要寫的內容，或丟錯放棄 */
  transact(uid: string, update: (current: UsageDoc | null) => UsageDoc): Promise<UsageDoc>;
}

export interface UsageDoc {
  readonly day: string;
  readonly pages: number;
  /** 處理中的租約到期時間（毫秒）；0＝沒有在處理 */
  readonly busyUntil: number;
  readonly busyId: string;
  readonly updatedAt: number;
  /**
   * 最後一個請求是不是管理員（不受每日上限）。工單 85 新增；之前寫的文件沒有這個欄位（＝false）。
   * 只給管理後台顯示「不限」用，引擎自己判斷上限只看這次請求的 token。
   */
  readonly unlimited?: boolean;
}

export function docUsageStore(docs: UsageDocStore, limit = DAILY_PAGE_LIMIT, now: () => number = Date.now): UsageStore {
  return {
    async acquire(uid, options = {}) {
      const unlimited = options.unlimited === true;
      const id = `${String(now())}-${Math.random().toString(36).slice(2, 10)}`;
      const taken = await docs.transact(uid, (current) => {
        const t = now();
        const day = taipeiDay(t);
        const pages = current?.day === day ? current.pages : 0;
        if (current && current.busyUntil > t) throw new BusyError('同一個帳號已經有一個 PDF 引擎請求在處理');
        if (!unlimited && pages >= limit) throw new DailyLimitError(pages, limit, 0);
        return { day, pages, busyUntil: t + BUSY_LEASE_MS, busyId: id, updatedAt: t, unlimited };
      });
      return lease(taken.pages, limit, unlimited, async (processed) => {
        await docs.transact(uid, (current) => {
          const t = now();
          const day = taipeiDay(t);
          const base = current?.day === day ? current.pages : 0;
          const mine = current?.busyId === id;
          return {
            day,
            pages: base + processed,
            busyUntil: mine ? 0 : (current?.busyUntil ?? 0),
            busyId: mine ? '' : (current?.busyId ?? ''),
            updatedAt: t,
            unlimited,
          };
        });
      });
    },
  };
}
