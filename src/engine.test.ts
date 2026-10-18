// 引擎自己的測試：用 mupdf 畫一份小 PDF（文字頁＋掃描頁），起一個本機伺服器（資料夾來源、固定 token、記憶體用量），
// 檢查 HTTP API 的回應、驗證、配額，以及抽字、頁面圖與 SVG 的內容。
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractPages, renderSvg } from './operations.ts';
import { mupdf, openPdf } from './pdf.ts';
import { createEngineServer } from './server.ts';
import { SourceCache, directorySourceStore } from './sources.ts';
import { BusyError, DailyLimitError, docUsageStore, memoryUsageStore, taipeiDay, type UsageDoc, type UsageStore } from './usage.ts';
import { WORD_FLAGS } from './text-layer.ts';

const WIDTH = 612;
const HEIGHT = 792;

/** 第 1 頁：粗體標題、內文（含上標）、一個框；第 2 頁：整頁影像（掃描頁）；第 3 頁：空白 */
function buildPdf(): Uint8Array {
  const buffer = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buffer, 'pdf', '');
  const regular = new mupdf.Font('Times-Roman');
  const bold = new mupdf.Font('Times-Bold');
  const gray = mupdf.ColorSpace.DeviceGray;
  const write = (device: mupdf.Device, font: mupdf.Font, str: string, x: number, y: number, size: number): number => {
    const text = new mupdf.Text();
    const end = text.showString(font, [size, 0, 0, -size, x, y], str);
    device.fillText(text, mupdf.Matrix.identity, gray, [0], 1);
    return end[4] ?? x;
  };
  let device = writer.beginPage([0, 0, WIDTH, HEIGHT]);
  write(device, bold, 'Basic Concepts', 72, 100, 18);
  const end = write(device, regular, 'The charge of an electron is 1.6 x 10', 72, 140, 11);
  write(device, regular, '-19', end, 135, 7);
  const path = new mupdf.Path();
  path.rect(60, 200, 400, 300);
  device.strokePath(path, new mupdf.StrokeState({ lineCap: 'Butt', lineJoin: 'Miter', lineWidth: 1, miterLimit: 10 }), mupdf.Matrix.identity, gray, [0], 1);
  write(device, regular, 'Example inside a frame', 72, 240, 11);
  writer.endPage();
  device = writer.beginPage([0, 0, WIDTH, HEIGHT]);
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 306, 396], false);
  pixmap.clear(230);
  device.fillImage(new mupdf.Image(pixmap), [WIDTH, 0, 0, HEIGHT, 0, 0], 1);
  writer.endPage();
  writer.beginPage([0, 0, WIDTH, HEIGHT]);
  writer.endPage();
  writer.close();
  return buffer.asUint8Array().slice();
}

const USER = 'user_a';
const OTHER = 'user_b';
const SOURCE = `users/${USER}/books/bk1/source.pdf`;
let dir: string;
let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pdf-engine-test-'));
  await mkdir(join(dir, 'src', 'users', USER, 'books', 'bk1'), { recursive: true });
  await mkdir(join(dir, 'src', 'users', OTHER, 'books', 'bk2'), { recursive: true });
  const bytes = buildPdf();
  await writeFile(join(dir, 'src', ...SOURCE.split('/')), bytes);
  await writeFile(join(dir, 'src', 'users', OTHER, 'books', 'bk2', 'source.pdf'), bytes);
  const sources = new SourceCache(directorySourceStore(join(dir, 'src')), { dir: join(dir, 'cache'), maxBytes: 50_000_000, maxOpen: 2 });
  const tokens = new Map([
    ['token-a', USER],
    ['token-limited', 'user_limited'],
  ]);
  const server = createEngineServer({
    verifier: { verify: (t) => (tokens.has(t) ? Promise.resolve({ uid: tokens.get(t) ?? '' }) : Promise.reject(new Error('bad'))) },
    sources,
    usage: memoryUsageStore(1000),
    source: { repository: 'https://example.test/engine', commit: 'abc123' },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
      sources.close();
    });
});

afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

/** 測試只讀得到的欄位（回應的形狀由各端點決定） */
interface TestPage {
  readonly page: number;
  readonly kind: string;
  readonly words: readonly { readonly id: string; readonly text: string; readonly flags: number }[];
  readonly drawings: readonly number[][];
  readonly images: readonly number[][];
  readonly image: string | null;
  readonly ocrImage: string | null;
  readonly text: string;
}
interface TestBody {
  readonly error: { readonly code: string; readonly message: string; readonly pageCount?: number };
  readonly engineVersion: string;
  readonly sourceSha256: string;
  readonly pageSizes: unknown[];
  readonly pages: TestPage[];
  readonly next: number[];
  readonly items: { readonly box: number[] }[];
}

async function post(path: string, body: unknown, token: string | null = 'token-a') {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  if (type.startsWith('multipart/form-data')) {
    const form = await res.formData();
    const files = new Map<string, Uint8Array>();
    for (const [name, value] of form) if (typeof value !== 'string') files.set(name, new Uint8Array(await value.arrayBuffer()));
    return { status: res.status, body: JSON.parse(form.get('meta') as string) as TestBody, files };
  }
  return { status: res.status, body: (await res.json()) as TestBody, files: new Map<string, Uint8Array>() };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

describe('驗證與權限', () => {
  it('GET /v1/source 不用登入，回公開儲存庫與 commit', async () => {
    const res = await fetch(`${baseUrl}/v1/source`);
    const body = (await res.json()) as Record<string, string>;
    expect(body.engineVersion).toMatch(/^mupdf-1\.28\.1\/engine-\d+$/);
    expect(body).toEqual({
      engineVersion: body.engineVersion,
      license: 'AGPL-3.0-or-later',
      repository: 'https://example.test/engine',
      commit: 'abc123',
    });
  });

  it('沒帶 token 401、token 無效 401、讀別人的書 403、找不到 404、格式錯 400', async () => {
    expect((await post('/v1/info', { source: SOURCE }, null)).body.error.code).toBe('unauthenticated');
    expect((await post('/v1/info', { source: SOURCE }, null)).status).toBe(401);
    expect((await post('/v1/info', { source: SOURCE }, 'nope')).status).toBe(401);
    const other = await post('/v1/info', { source: `users/${OTHER}/books/bk2/source.pdf` });
    expect([other.status, other.body.error.code]).toEqual([403, 'forbidden']);
    const missing = await post('/v1/info', { source: `users/${USER}/books/none/source.pdf` });
    expect([missing.status, missing.body.error.code]).toEqual([404, 'source_not_found']);
    expect((await post('/v1/info', { source: '../etc/passwd' })).status).toBe(400);
    expect((await post('/v1/extract', { source: SOURCE, pages: [] })).status).toBe(400);
    const range = await post('/v1/extract', { source: SOURCE, pages: [4] });
    expect([range.status, range.body.error.code, range.body.error.pageCount]).toEqual([400, 'page_out_of_range', 3]);
  });

  it('超過每日上限回 429 daily_limit（訊息寫出已用與上限）', async () => {
    const usage = memoryUsageStore(2);
    const lease = await usage.acquire('u');
    expect(() => lease.reserve(3)).toThrow(DailyLimitError);
    lease.reserve(2);
    await lease.finish(2);
    await expect(usage.acquire('u')).rejects.toThrow(/每日上限 2 頁/);
    // 伺服器：classify 整本 3 頁，額度 1000 → 正常；另一個額度只有 2 頁的伺服器 → 429
    const sources = new SourceCache(directorySourceStore(join(dir, 'src')), { dir: join(dir, 'cache2'), maxBytes: 50_000_000, maxOpen: 1 });
    const server = createEngineServer({
      verifier: { verify: () => Promise.resolve({ uid: USER }) },
      sources,
      usage: memoryUsageStore(2),
      source: { repository: 'r', commit: 'c' },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/classify`;
    const res = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify({ source: SOURCE }) });
    const body = (await res.json()) as { error: { code: string; message: string; used: number; limit: number; requested: number } };
    expect(res.status).toBe(429);
    expect(body.error).toMatchObject({ code: 'daily_limit', used: 0, limit: 2, requested: 3 });
    expect(body.error.message).toContain('每日上限 2 頁');
    server.closeAllConnections();
    server.close();
    sources.close();
  });

  it('同一個使用者同時第二個請求：BusyError（伺服器回 429 busy）；租約過期或做完後可以再拿', async () => {
    const memory = memoryUsageStore(100);
    const first = await memory.acquire('u');
    await expect(memory.acquire('u')).rejects.toThrow(BusyError);
    await first.finish(1);
    await (await memory.acquire('u')).finish(0);

    // Firestore 版：用假的交易
    let doc: UsageDoc | null = null;
    let now = Date.UTC(2026, 9, 17, 15, 59, 0); // 台北 23:59
    const store = docUsageStore(
      {
        transact(_uid, update) {
          doc = update(doc);
          return Promise.resolve(doc);
        },
      },
      10,
      () => now,
    );
    const a = await store.acquire('u');
    await expect(store.acquire('u')).rejects.toThrow(BusyError);
    await a.finish(7);
    expect(doc).toMatchObject({ day: '2026-10-17', pages: 7, busyUntil: 0 });
    const b = await store.acquire('u');
    expect(b.used).toBe(7);
    expect(() => b.reserve(4)).toThrow(DailyLimitError);
    now += 120_000; // 過了台北的午夜：額度重算
    await b.finish(0);
    expect(doc).toMatchObject({ day: '2026-10-18', pages: 0 });
    // 執行個體當掉、沒有 finish：租約過期後可以再拿
    await store.acquire('u');
    now += 331_000;
    await expect(store.acquire('u')).resolves.toBeDefined();
    expect(taipeiDay(Date.UTC(2026, 9, 17, 16, 0, 0))).toBe('2026-10-18');
  });
});

describe('用量的釋放', () => {
  it('回應之前就釋放「處理中」：收到回應後馬上送下一個請求不會 busy（Firestore 的寫入比較慢）', async () => {
    const memory = memoryUsageStore(1000);
    const slow: UsageStore = {
      async acquire(uid) {
        const lease = await memory.acquire(uid);
        return {
          ...lease,
          finish: async (pages) => {
            await new Promise((resolve) => setTimeout(resolve, 80));
            await lease.finish(pages);
          },
        };
      },
    };
    const sources = new SourceCache(directorySourceStore(join(dir, 'src')), { dir: join(dir, 'cache3'), maxBytes: 50_000_000, maxOpen: 1 });
    const server = createEngineServer({
      verifier: { verify: () => Promise.resolve({ uid: USER }) },
      sources,
      usage: slow,
      source: { repository: 'r', commit: 'c' },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/info`;
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify({ source: SOURCE }) });
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    expect(statuses).toEqual([200, 200, 200]);
    server.closeAllConnections();
    server.close();
    sources.close();
  });
});

describe('PDF 進、座標／圖片／SVG 出', () => {
  it('/v1/info：頁數、頁面大小、書籤、頁碼標籤；回應帶 engineVersion 與 sourceSha256', async () => {
    const { status, body } = await post('/v1/info', { source: SOURCE });
    expect(status).toBe(200);
    expect(body).toMatchObject({ pageCount: 3, outline: [], labels: ['1', '2', '3'] });
    expect(body.pageSizes).toEqual([
      { width: WIDTH, height: HEIGHT },
      { width: WIDTH, height: HEIGHT },
      { width: WIDTH, height: HEIGHT },
    ]);
    expect(body.engineVersion).toMatch(/^mupdf-/);
    expect(body.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('/v1/classify：文字頁、掃描頁、空白頁（文字頁）', async () => {
    const { body } = await post('/v1/classify', { source: SOURCE });
    expect(body.pages.map((p) => p.kind)).toEqual(['text', 'scanned', 'text']);
    expect(body.pages[1]).toMatchObject({ visibleGlyphs: 0, imageCoverage: 1 });
  });

  it('/v1/extract：文字頁的單字、旗標、ID 與框；掃描頁沒有單字但另給 300 dpi 圖', async () => {
    const { body, files } = await post('/v1/extract', { source: SOURCE, pages: [2, 1] });
    expect(body.next).toEqual([]);
    const [p1, p2] = body.pages;
    expect(p1?.page).toBe(1);
    expect(p1?.words.map((w) => w.text)).toEqual([
      'Basic',
      'Concepts',
      'The',
      'charge',
      'of',
      'an',
      'electron',
      'is',
      '1.6',
      'x',
      '10',
      '-19',
      'Example',
      'inside',
      'a',
      'frame',
    ]);
    expect(p1?.words[0]).toMatchObject({ id: 'p0001w0001', flags: WORD_FLAGS.bold, line: 0, conf: null });
    expect(p1?.words.find((w) => w.text === '-19')?.flags).toBe(WORD_FLAGS.superscript);
    expect(p1?.drawings).toContainEqual([59.5, 199.5, 341, 101]);
    expect(p1?.ocrImage).toBeNull();
    expect(p2).toMatchObject({ words: [], classification: { kind: 'scanned' }, image: 'p0002.png', ocrImage: 'p0002@300.png' });
    expect(p2?.images).toEqual([[0, 0, WIDTH, HEIGHT]]);
    for (const name of ['p0001.png', 'p0002.png', 'p0002@300.png']) expect([...(files.get(name) ?? []).slice(0, 4)]).toEqual(PNG_MAGIC);
    // 300 dpi 是 150 dpi 的兩倍大：PNG 的寬在 IHDR（第 16–19 個位元組）
    const widthOf = (png: Uint8Array) => new DataView(png.buffer, png.byteOffset).getUint32(16);
    expect(widthOf(files.get('p0001.png') ?? new Uint8Array(24))).toBe(1275);
    expect(widthOf(files.get('p0002@300.png') ?? new Uint8Array(24))).toBe(2550);
  });

  it('同一頁抽兩次完全相同', async () => {
    const a = await post('/v1/extract', { source: SOURCE, pages: [1] });
    const b = await post('/v1/extract', { source: SOURCE, pages: [1] });
    expect(a.body.pages).toEqual(b.body.pages);
  });

  it('回應超過大小上限時做到一半，剩下的頁放在 next', async () => {
    const pdf = openPdf(buildPdf());
    try {
      const result = await extractPages(pdf, [1, 2, 3], { bytes: 1000, deadline: Date.now() + 60_000 });
      expect(result.meta.pages.map((p) => p.page)).toEqual([1]);
      expect(result.meta.next).toEqual([2, 3]);
      expect(result.pagesProcessed).toBe(1);
    } finally {
      pdf.close();
    }
  });

  it('/v1/pages：頁碼標籤、純文字與頁面圖', async () => {
    const { body, files } = await post('/v1/pages', { source: SOURCE, pages: [1, 3], text: true, imageDpi: 72 });
    expect(body.pages[0]).toMatchObject({ page: 1, label: '1', image: 'p0001.png' });
    expect(body.pages[0]?.text).toContain('Basic Concepts');
    expect(body.pages[1]?.text.trim()).toBe('');
    expect(files.size).toBe(2);
  });

  it('/v1/render：整頁與裁切範圍 → SVG，文字轉成路徑（沒有 <text>）', async () => {
    const { body, files } = await post('/v1/render', {
      source: SOURCE,
      items: [{ page: 1 }, { page: 1, clip: [50, 80, 300, 100] }, { page: 1, clip: [600, 780, 100, 100] }],
    });
    expect(body.items.map((i) => i.box)).toEqual([
      [0, 0, WIDTH, HEIGHT],
      [50, 80, 300, 100],
      [600, 780, 12, 12],
    ]);
    const full = new TextDecoder().decode(files.get('r000.svg'));
    const clipped = new TextDecoder().decode(files.get('r001.svg'));
    for (const svg of [full, clipped]) {
      expect(svg).toMatch(/^<svg[^>]+viewBox=/);
      expect(svg).not.toContain('<text');
      expect(svg).toContain('<path');
    }
    expect(clipped).toContain('viewBox="0 0 300 100"');
    expect((await post('/v1/render', { source: SOURCE, items: [{ page: 1, clip: [700, 0, 10, 10] }] })).status).toBe(400);
  });

  it('renderSvg 的裁切：範圍外的字不在裁切後的可見範圍（clipPath）', () => {
    const pdf = openPdf(buildPdf());
    try {
      const { svg } = renderSvg(pdf, 1, [60, 200, 340, 100]);
      expect(svg).toContain('<clipPath');
    } finally {
      pdf.close();
    }
  });
});
