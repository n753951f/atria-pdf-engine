// HTTP API（README 有完整說明）：
//   GET  /v1/source    公開原始碼的位置與部署的 commit（不用登入；AGPL-3.0 §13）
//   POST /v1/info      頁數、頁面大小、書籤、頁碼標籤
//   POST /v1/classify  整本每頁的類型與判斷依據
//   POST /v1/pages     指定頁的頁碼標籤、純文字、頁面圖
//   POST /v1/extract   指定頁的單字與旗標、向量圖形與圖片物件的外框、150 dpi 頁面圖（掃描頁另給 300 dpi）
//   POST /v1/render    頁面或裁切範圍 → SVG（文字轉路徑）
// POST 都要 Authorization: Bearer <Firebase ID token>，body 是 JSON，source 只能是呼叫者自己的
// users/{uid}/books/{bookId}/….pdf。有檔案的回應是 multipart/form-data：meta（JSON）＋各個檔案。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { TokenVerifier } from './firebase.ts';
import {
  InvalidClipError,
  classifyPdf,
  extractPages,
  infoOf,
  pagesOf,
  renderItems,
  type OperationResult,
} from './operations.ts';
import { PageOutOfRangeError, type OpenedPdf } from './pdf.ts';
import { SOURCE_PATH, SourceNotFoundError, type SourceCache } from './sources.ts';
import { BusyError, DailyLimitError, type UsageStore } from './usage.ts';
import { ENGINE_VERSION } from './version.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PAGES_PER_REQUEST = 500;
const MAX_RENDER_ITEMS = 200;

export interface EngineDeps {
  readonly verifier: TokenVerifier;
  readonly sources: SourceCache;
  readonly usage: UsageStore;
  /** GET /v1/source 的內容 */
  readonly source: { readonly repository: string; readonly commit: string };
  /** 一行一個請求的紀錄（不含 token） */
  readonly log?: (entry: Record<string, unknown>) => void;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: Record<string, unknown>;
  constructor(status: number, code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const pageNumber = z.number().int().positive();
const rect = z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]);
const sourceOnly = z.object({ source: z.string() }).strict();
const pagesBody = z
  .object({
    source: z.string(),
    pages: z.array(pageNumber).min(1).max(MAX_PAGES_PER_REQUEST),
    text: z.boolean().default(false),
    imageDpi: z.number().int().min(36).max(300).nullable().default(null),
  })
  .strict();
const extractBody = z.object({ source: z.string(), pages: z.array(pageNumber).min(1).max(MAX_PAGES_PER_REQUEST) }).strict();
const renderBody = z
  .object({
    source: z.string(),
    items: z
      .array(z.object({ page: pageNumber, clip: rect.nullable().optional() }).strict())
      .min(1)
      .max(MAX_RENDER_ITEMS),
  })
  .strict();

type Handler = (pdf: OpenedPdf, body: unknown) => Promise<OperationResult<unknown>>;

const ROUTES: Readonly<Record<string, { schema: z.ZodType; run: Handler; estimate: (pdf: OpenedPdf, body: unknown) => number }>> = {
  '/v1/info': { schema: sourceOnly, run: (pdf) => infoOf(pdf), estimate: () => 0 },
  '/v1/classify': { schema: sourceOnly, run: (pdf) => classifyPdf(pdf), estimate: (pdf) => pdf.pageCount },
  '/v1/pages': {
    schema: pagesBody,
    run: (pdf, body) => {
      const b = body as z.infer<typeof pagesBody>;
      return pagesOf(pdf, { pages: b.pages, text: b.text, imageDpi: b.imageDpi });
    },
    estimate: (_pdf, body) => new Set((body as z.infer<typeof pagesBody>).pages).size,
  },
  '/v1/extract': {
    schema: extractBody,
    run: (pdf, body) => extractPages(pdf, (body as z.infer<typeof extractBody>).pages),
    estimate: (_pdf, body) => new Set((body as z.infer<typeof extractBody>).pages).size,
  },
  '/v1/render': {
    schema: renderBody,
    run: (pdf, body) => renderItems(pdf, (body as z.infer<typeof renderBody>).items),
    estimate: (_pdf, body) => (body as z.infer<typeof renderBody>).items.length,
  },
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', '請求內容太大（上限 1 MB）');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'bad_request', '請求內容不是 JSON');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function sendResult(res: ServerResponse, meta: Record<string, unknown>, result: OperationResult<unknown>): Promise<void> {
  const body = { engineVersion: ENGINE_VERSION, ...meta, ...(result.meta as Record<string, unknown>) };
  if (result.files.length === 0) {
    sendJson(res, 200, body);
    return;
  }
  const form = new FormData();
  form.append('meta', JSON.stringify(body));
  for (const file of result.files) form.append(file.name, new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type }), file.name);
  const encoded = new Response(form);
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  res.writeHead(200, {
    'content-type': encoded.headers.get('content-type') ?? 'multipart/form-data',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
  });
  res.end(bytes);
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1]) throw new HttpError(401, 'unauthenticated', '沒有登入：請求要帶 Authorization: Bearer <Firebase ID token>');
  return match[1];
}

async function handlePost(deps: EngineDeps, req: IncomingMessage, res: ServerResponse, path: string, log: Record<string, unknown>): Promise<void> {
  const route = ROUTES[path];
  if (!route) throw new HttpError(404, 'not_found', `沒有這個端點：${path}`);
  const token = bearer(req);
  let uid: string;
  try {
    ({ uid } = await deps.verifier.verify(token));
  } catch {
    throw new HttpError(401, 'unauthenticated', '登入無效或已過期：請重新取得 Firebase ID token');
  }
  log.uid = uid;
  const raw = await readBody(req);
  const parsed = route.schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, 'bad_request', `請求內容不合格式：${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`);
  }
  const body = parsed.data as { source: string };
  const owner = SOURCE_PATH.exec(body.source)?.[1];
  if (!owner) throw new HttpError(400, 'bad_request', 'source 要是 users/{uid}/books/{bookId}/….pdf');
  if (owner !== uid) throw new HttpError(403, 'forbidden', '只能讀自己的書');

  let lease;
  try {
    lease = await deps.usage.acquire(uid);
  } catch (error) {
    throw usageError(error);
  }
  let processed = 0;
  const finish = () =>
    lease.finish(processed).catch((error: unknown) => {
      log.usageError = String(error);
    });
  try {
    let opened;
    try {
      opened = await deps.sources.get(body.source);
    } catch (error) {
      if (error instanceof SourceNotFoundError) throw new HttpError(404, 'source_not_found', `找不到原始 PDF：${body.source}`);
      throw error;
    }
    try {
      const estimate = route.estimate(opened.pdf, parsed.data);
      try {
        lease.reserve(estimate);
      } catch (error) {
        throw usageError(error);
      }
      const result = await route.run(opened.pdf, parsed.data);
      processed = result.pagesProcessed;
      log.pages = processed;
      // 先記帳並釋放「處理中」再回應：呼叫者收到回應後馬上送下一個請求時不會撞到 busy
      await finish();
      await sendResult(res, { sourceSha256: opened.sha256, pageCount: opened.pdf.pageCount }, result);
    } finally {
      opened.release();
    }
  } finally {
    await finish();
  }
}

function usageError(error: unknown): HttpError {
  if (error instanceof BusyError) return new HttpError(429, 'busy', error.message);
  if (error instanceof DailyLimitError) {
    return new HttpError(429, 'daily_limit', error.message, { used: error.used, limit: error.limit, requested: error.requested });
  }
  return error instanceof HttpError ? error : new HttpError(500, 'internal', '記錄用量失敗');
}

export function createEngineServer(deps: EngineDeps): Server {
  return createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://engine');
    const log: Record<string, unknown> = { method: req.method, path: url.pathname };
    const done = (status: number) => {
      deps.log?.({ ...log, status, ms: Date.now() - started });
    };
    void (async () => {
      try {
        if (req.method === 'GET' && url.pathname === '/v1/source') {
          sendJson(res, 200, {
            engineVersion: ENGINE_VERSION,
            license: 'AGPL-3.0-or-later',
            repository: deps.source.repository,
            commit: deps.source.commit,
          });
          done(200);
          return;
        }
        if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', '只接受 POST（GET 只有 /v1/source）');
        await handlePost(deps, req, res, url.pathname, log);
        done(200);
      } catch (error) {
        let http: HttpError;
        if (error instanceof HttpError) http = error;
        else if (error instanceof PageOutOfRangeError) {
          http = new HttpError(400, 'page_out_of_range', error.message, { page: error.page, pageCount: error.pageCount });
        } else if (error instanceof InvalidClipError) http = new HttpError(400, 'bad_request', error.message);
        else {
          http = new HttpError(500, 'internal', 'PDF 引擎內部錯誤');
          log.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
        if (!res.headersSent) {
          sendJson(res, http.status, { error: { code: http.code, message: http.message, ...http.detail } });
        } else {
          res.destroy();
        }
        log.code = http.code;
        done(http.status);
      }
    })();
  });
}
