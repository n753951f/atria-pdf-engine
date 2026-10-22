// 引擎自己的測試：用 mupdf 畫一份小 PDF（文字頁＋掃描頁），起一個本機伺服器（資料夾來源、固定 token、記憶體用量），
// 檢查 HTTP API 的回應、驗證、配額，以及抽字、頁面圖與 SVG 的內容。
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_RENDER_ATTEMPTS, RenderFailedError, extractPages, renderItems, renderSvg } from './operations.ts';
import { mupdf, openPdf } from './pdf.ts';
import { createEngineServer } from './server.ts';
import { SourceCache, directorySourceStore } from './sources.ts';
import { buildShadingPdf } from './test-fixtures.ts';
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

/**
 * 一頁 ToUnicode 寫錯的文字：字碼 1（Omega 字形）、2（Delta 字形）對到 U+FFFD、3（bullet 字形）對到私用區 U+E001，
 * 就像真書把 Ω、Δ 抽成「�」。手寫 PDF（mupdf 的 DocumentWriter 會自己產生正確的 ToUnicode）。
 */
function buildMisencodedPdf(): Uint8Array {
  const cmap =
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Misencoded def ' +
    '1 begincodespacerange <00> <FF> endcodespacerange 3 beginbfchar <01> <FFFD> <02> <FFFD> <03> <E001> endbfchar ' +
    'endcmap CMapName currentdict /CMap defineresource pop end end';
  const content = 'BT /F1 11 Tf 72 700 Td (R = 1.8 k\\001 and \\002V \\001 \\003) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(WIDTH)} ${String(HEIGHT)}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /Differences [1 /Omega 2 /Delta 3 /bullet] >> /ToUnicode 6 0 R >>',
    `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
    `<< /Length ${String(cmap.length)} >>\nstream\n${cmap}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  const entries = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${entries}`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const USER = 'user_a';
const OTHER = 'user_b';
const SOURCE = `users/${USER}/books/bk1/source.pdf`;
/** 工單 67 的漸層網格 PDF（fixtures/mesh-shading.pdf） */
const SHADING_SOURCE = `users/${USER}/books/bk3/source.pdf`;
const SHADING_FIXTURE = new URL('../fixtures/mesh-shading.pdf', import.meta.url);
let dir: string;
let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pdf-engine-test-'));
  await mkdir(join(dir, 'src', 'users', USER, 'books', 'bk1'), { recursive: true });
  await mkdir(join(dir, 'src', 'users', OTHER, 'books', 'bk2'), { recursive: true });
  await mkdir(join(dir, 'src', 'users', USER, 'books', 'bk3'), { recursive: true });
  await writeFile(join(dir, 'src', ...SHADING_SOURCE.split('/')), readFileSync(SHADING_FIXTURE));
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
  readonly items: { readonly box: number[]; readonly svg: string }[];
  readonly warnings: { readonly item: number; readonly page: number; readonly skipped: string; readonly count: number; readonly reason: string }[];
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

  it('ToUnicode 對不到的字（U+FFFD、私用區）：單字帶 glyphs（第幾個字元、字型、字形編號），同一個字形編號相同；其他單字沒有這個欄位', async () => {
    const pdf = openPdf(buildMisencodedPdf());
    try {
      const { meta } = await extractPages(pdf, [1]);
      const words = meta.pages[0]?.words ?? [];
      expect(words.map((w) => w.text)).toEqual(['R', '=', '1.8', 'k�', 'and', '�V', '�', '\uE001']);
      const byText = (text: string) => words.find((w) => w.text === text);
      const omega = byText('k�')?.glyphs ?? [];
      const delta = byText('�V')?.glyphs ?? [];
      expect(omega).toEqual([{ at: 1, font: 'Helvetica', gid: expect.any(Number) as number }]);
      expect(delta).toEqual([{ at: 0, font: 'Helvetica', gid: expect.any(Number) as number }]);
      // 第二個 Omega（字碼 1）和 k� 的是同一個字形；Delta 是另一個
      expect(byText('�')?.glyphs?.[0]?.gid).toBe(omega[0]?.gid);
      expect(delta[0]?.gid).not.toBe(omega[0]?.gid);
      expect(byText('\uE001')?.glyphs).toEqual([{ at: 0, font: 'Helvetica', gid: expect.any(Number) as number }]);
      for (const text of ['R', '=', '1.8', 'and']) expect(byText(text)).not.toHaveProperty('glyphs');
    } finally {
      pdf.close();
    }
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

  it('renderSvg 的 CMYK 影像：嵌進 SVG 的是 RGB 的 PNG，顏色和 mupdf 算圖一致（真書的 Adobe CMYK JPEG 原封不動嵌入時會反相；合成的 JPEG 重現不出來，只驗證結果）', () => {
    // 一頁只有一張純青色（C=100%）的 CMYK JPEG
    const cmyk = new mupdf.Pixmap(mupdf.ColorSpace.DeviceCMYK, [0, 0, 40, 20], false);
    const pixels = cmyk.getPixels();
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 255;
      pixels[i + 1] = 0;
      pixels[i + 2] = 0;
      pixels[i + 3] = 0;
    }
    const jpeg = cmyk.asJPEG(90, false);
    const buffer = new mupdf.Buffer();
    const writer = new mupdf.DocumentWriter(buffer, 'pdf', '');
    const device = writer.beginPage([0, 0, 200, 100]);
    device.fillImage(new mupdf.Image(jpeg), [100, 0, 0, 50, 50, 25], 1);
    writer.endPage();
    writer.close();
    const pdf = openPdf(buffer.asUint8Array().slice());
    try {
      const { svg } = renderSvg(pdf, 1, null);
      expect(svg).not.toContain('data:image/jpeg');
      const png = /data:image\/png;base64,([^"]+)"/.exec(svg)?.[1] ?? '';
      expect(png.length).toBeGreaterThan(0);
      // 嵌進去的影像和 mupdf 自己算圖（頁面圖）的顏色相同
      const image = new mupdf.Image(Buffer.from(png.replace(/\s/g, ''), 'base64'));
      const embedded = image.toPixmap();
      const page = pdf.loadPage(1);
      const raster = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      page.destroy();
      const at = (pix: mupdf.Pixmap, x: number, y: number) => {
        const n = pix.getNumberOfComponents();
        const i = (y * pix.getWidth() + x) * n;
        return Array.from(pix.getPixels().slice(i, i + 3));
      };
      const a = at(embedded, 20, 10);
      const b = at(raster, 100, 50);
      for (let k = 0; k < 3; k += 1) expect(Math.abs((a[k] ?? 0) - (b[k] ?? 0)), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBeLessThan(40);
    } finally {
      pdf.close();
    }
  });
});

describe('壞掉的漸層網格（工單 67：Cloud Run 的 Unexpected mesh type 97／115）', () => {
  const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
  /** text=path 的 SVG：每個字形是一個 <use>；漸層畫成 <image> */
  const glyphs = (svg: string) => (svg.match(/<use /g) ?? []).length;
  const images = (svg: string) => (svg.match(/<image /g) ?? []).length;
  /** 強制 GC：mupdf.js 的 finalizer 只在 GC 之後才跑 */
  const collect = (() => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    return async () => {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
  })();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fixtures/mesh-shading.pdf 和產生它的程式（test-fixtures.ts）一致', () => {
    expect(Buffer.from(readFileSync(SHADING_FIXTURE)).equals(Buffer.from(buildShadingPdf()))).toBe(true);
  });

  it('同一份打開的 PDF 反覆畫漸層網格、中間跑 GC：每次都畫得出來、結果相同（mupdf.js 的 Shade 包裝不再多 drop 一次）', async () => {
    const pdf = openPdf(buildShadingPdf());
    try {
      const first = renderSvg(pdf, 1, null);
      expect(first.skipped).toEqual([]);
      // 四個正常的網格、線性漸層與 shading pattern 都畫成影像；壞掉的 shading（97、115、截斷、BitsPerFlag 3）mupdf 自己略過
      expect(images(first.svg)).toBeGreaterThanOrEqual(6);
      expect(glyphs(first.svg)).toBeGreaterThan(40);
      for (let i = 0; i < 25; i += 1) {
        await collect();
        const again = renderSvg(pdf, 1, i % 2 === 0 ? null : [60, 380, 500, 200]);
        expect(again.skipped).toEqual([]);
        if (i % 2 === 0) expect(again.svg).toBe(first.svg);
      }
    } finally {
      pdf.close();
    }
  });

  it('漸層畫不出來時跳過那個漸層、其他照畫，skipped 記下種類、個數與 mupdf 的訊息', () => {
    const pdf = openPdf(buildShadingPdf());
    try {
      const normal = renderSvg(pdf, 1, null);
      // 只有第一個漸層畫不出來
      // eslint-disable-next-line @typescript-eslint/unbound-method -- 原本的方法，在 mock 裡以收到的 device 當 this 呼叫
      const original = mupdf.Device.prototype.fillShade;
      let failed = false;
      vi.spyOn(mupdf.Device.prototype, 'fillShade').mockImplementation(function (this: mupdf.Device, ...args) {
        if (!failed) {
          failed = true;
          throw new Error('Unexpected mesh type 97');
        }
        original.apply(this, args);
      });
      const one = renderSvg(pdf, 1, null);
      expect(one.skipped).toEqual([{ kind: 'shading', count: 1, reason: 'Unexpected mesh type 97' }]);
      expect(images(one.svg)).toBe(images(normal.svg) - 1);
      expect(glyphs(one.svg)).toBe(glyphs(normal.svg));
      // 所有漸層都畫不出來：全部跳過，文字照畫
      vi.restoreAllMocks();
      vi.spyOn(mupdf.Device.prototype, 'fillShade').mockImplementation(() => {
        throw new Error('Unexpected mesh type 115');
      });
      const none = renderSvg(pdf, 1, null);
      expect(none.skipped).toEqual([{ kind: 'shading', count: expect.any(Number) as number, reason: 'Unexpected mesh type 115' }]);
      expect(none.skipped[0]?.count).toBeGreaterThanOrEqual(6);
      expect(images(none.svg)).toBe(0);
      expect(glyphs(none.svg)).toBe(glyphs(normal.svg));
    } finally {
      pdf.close();
    }
  });

  it('跳過之後還是畫不出來、或頁面內容本身讀不了：RenderFailedError（哪一頁、原因），不是一般的例外', async () => {
    const pdf = openPdf(buildShadingPdf());
    try {
      vi.spyOn(mupdf.Page.prototype, 'run').mockImplementation(() => {
        throw new Error('syntax error in content stream');
      });
      expect(() => renderSvg(pdf, 1, null)).toThrow(RenderFailedError);
      expect(() => renderSvg(pdf, 1, null)).toThrow('PDF 頁 1 畫不出來：syntax error in content stream');
      await expect(renderItems(pdf, [{ page: 2 }, { page: 1 }])).rejects.toMatchObject({ page: 2, item: 0 });
      // 每次重畫都有另一個漸層畫不出來（像 mupdf 出錯後停用整個 device，後面的錯要下一次才看得到）：
      // 第 2、3 次只跳過出錯的那幾個，第 MAX_RENDER_ATTEMPTS 次跳過整個種類
      vi.restoreAllMocks();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- 原本的方法，在 mock 裡以收到的 device 當 this 呼叫
      const original = mupdf.Device.prototype.fillShade;
      const seen = new WeakSet<mupdf.Device>();
      let thrown = 0;
      vi.spyOn(mupdf.Device.prototype, 'fillShade').mockImplementation(function (this: mupdf.Device, ...args) {
        if (!seen.has(this)) {
          seen.add(this);
          thrown += 1;
          throw new Error(`broken shade ${String(thrown)}`);
        }
        original.apply(this, args);
      });
      const escalated = renderSvg(pdf, 1, null);
      expect(thrown).toBe(MAX_RENDER_ATTEMPTS - 1);
      expect(escalated.skipped).toEqual([{ kind: 'shading', count: expect.any(Number) as number, reason: 'broken shade 1' }]);
      expect(escalated.skipped[0]?.count).toBeGreaterThanOrEqual(6);
      expect(images(escalated.svg)).toBe(0);
      vi.restoreAllMocks();
      // 跳過整個種類之後還是不行（第 MAX_RENDER_ATTEMPTS 次換文字畫不出來）
      const devices: mupdf.Device[] = [];
      vi.spyOn(mupdf.Device.prototype, 'fillShade').mockImplementation(function (this: mupdf.Device) {
        if (!devices.includes(this)) {
          devices.push(this);
          throw new Error('broken shade');
        }
      });
      vi.spyOn(mupdf.Device.prototype, 'fillText').mockImplementation(function (this: mupdf.Device) {
        if (devices.length >= MAX_RENDER_ATTEMPTS - 1 && !devices.includes(this)) throw new Error('broken text');
      });
      expect(() => renderSvg(pdf, 1, null)).toThrow(/PDF 頁 1 畫不出來：跳過畫不出來的物件之後還是失敗（broken text）/);
      vi.restoreAllMocks();
      // 裁切這類不能跳過的出錯：直接 RenderFailedError
      vi.spyOn(mupdf.Device.prototype, 'clipPath').mockImplementation(() => {
        throw new Error('broken clip');
      });
      expect(() => renderSvg(pdf, 1, null)).toThrow(/PDF 頁 1 畫不出來：broken clip/);
    } finally {
      pdf.close();
    }
  });

  it('/v1/render：漸層畫不出來時 200＋warnings（第幾項、哪一頁、跳過什麼），SVG 照樣有文字；正常時 warnings 是空的', async () => {
    const items = [{ page: 2 }, { page: 1 }, { page: 1, clip: [60, 380, 500, 200] }];
    const normal = await post('/v1/render', { source: SHADING_SOURCE, items });
    expect(normal.status).toBe(200);
    expect(normal.body.warnings).toEqual([]);
    vi.spyOn(mupdf.Device.prototype, 'fillShade').mockImplementation(() => {
      throw new Error('Unexpected mesh type 97');
    });
    const { status, body, files } = await post('/v1/render', { source: SHADING_SOURCE, items });
    expect(status).toBe(200);
    expect(body.items).toHaveLength(3);
    expect(body.warnings.map((w) => [w.item, w.page, w.skipped, w.reason])).toEqual([
      [1, 1, 'shading', 'Unexpected mesh type 97'],
      [2, 1, 'shading', 'Unexpected mesh type 97'],
    ]);
    const full = decode(files.get(body.items[1]?.svg ?? ''));
    expect(images(full)).toBe(0);
    expect(glyphs(full)).toBe(glyphs(decode(normal.files.get(normal.body.items[1]?.svg ?? ''))));
  });

  it('/v1/render：真的畫不出來時 422 render_failed（訊息有頁碼與原因、detail 有 page 與 item），不是 500 internal', async () => {
    vi.spyOn(mupdf.Page.prototype, 'run').mockImplementation(() => {
      throw new Error('Unexpected mesh type 115');
    });
    const { status, body } = await post('/v1/render', { source: SHADING_SOURCE, items: [{ page: 1 }] });
    expect(status).toBe(422);
    expect(body.error).toMatchObject({ code: 'render_failed', message: 'PDF 頁 1 畫不出來：Unexpected mesh type 115', page: 1, item: 0 });
  });
});
