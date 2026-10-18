# Atria PDF engine

PDF in, coordinates / images / SVG out. A small HTTP service built on [MuPDF.js](https://mupdf.readthedocs.io/) (AGPL-3.0), used by the Atria textbook reader. Licensed under **AGPL-3.0-or-later** (see `LICENSE`).

Atria（原文教科書閱讀器）用到 MuPDF 的部分全部集中在這個服務：抽字、頁面類型、頁面圖、書籤、頁面轉 SVG。
它只做「PDF 進、座標／圖片／SVG 出」，不含版面判斷、OCR、AI 或翻譯。服務跑在 Google Cloud Run，
依 AGPL-3.0 §13，`GET /v1/source` 回傳這個儲存庫的網址與目前部署的 commit。

## API

除了 `GET /v1/source`，每個請求都是 `POST`、body 是 JSON，並帶 `Authorization: Bearer <Firebase ID token>`。
`source` 是呼叫者自己在 Firebase Storage 的 `users/{uid}/books/{bookId}/source.pdf`（uid 和 token 不同時回 403）。

| 端點 | body | 回應 |
|---|---|---|
| `GET /v1/source` | — | `{ engineVersion, license, repository, commit }` |
| `POST /v1/info` | `{ source }` | `{ pageCount, pageSizes[], outline[{ depth, title, pdfPage }], labels[] }` |
| `POST /v1/classify` | `{ source }` | `{ pageCount, pages[{ kind, visibleGlyphs, invisibleGlyphs, imageCoverage }] }` |
| `POST /v1/pages` | `{ source, pages[], text?, imageDpi? }` | `{ pages[{ page, width, height, label, text, image }], next[] }`＋頁面圖 |
| `POST /v1/extract` | `{ source, pages[] }` | `{ pages[{ page, width, height, classification, words[], drawings[], images[], image, ocrImage }], next[] }`＋150 dpi 頁面圖（掃描頁另給 300 dpi） |
| `POST /v1/render` | `{ source, items[{ page, clip? }] }` | `{ items[{ page, box, svg, bytes }], next[] }`＋SVG（文字轉路徑） |

- 每個回應都有 `engineVersion`（例如 `mupdf-1.28.1/engine-1`）、`sourceSha256`、`pageCount`。
- 有檔案的回應是 `multipart/form-data`：`meta` 是上面的 JSON，其他部分的名稱就是 JSON 裡的檔名（`p0041.png`、`p0041@300.png`、`r000.svg`）。
- 座標是 PDF 座標：pt，原點在頁面左上角，矩形是 `[x, y, width, height]`。單字的 ID 是 `p0041w0001`（頁＋頁內序號）。
- 一次回應最多約 24 MB、做 200 秒；做不完的頁（或 render 的項目索引）放在 `next`，照樣再請求一次。
- 錯誤：`{ error: { code, message } }`。`401 unauthenticated`、`403 forbidden`、`404 source_not_found`、`400 bad_request`／`page_out_of_range`、`429 busy`（同一個帳號同時只能有一個請求）／`daily_limit`（每人每天 3000 頁，台北時間）。

## 執行

```bash
npm ci   # package-lock.json 固定所有依賴的版本
# 本機：用 GOOGLE_APPLICATION_CREDENTIALS 指向的憑證讀 Firebase
PORT=8790 node src/main.ts
npm test
```

環境變數：`PORT`、`ENGINE_PROJECT_ID`、`ENGINE_BUCKET`、`ENGINE_DAILY_PAGE_LIMIT`、`ENGINE_CACHE_DIR`、`ENGINE_CACHE_MAX_BYTES`、`ENGINE_SOURCE_REPOSITORY`、`ENGINE_SOURCE_COMMIT`。

部署（Cloud Run，asia-east1、最少 0／最多 2 個執行個體、2 GiB、逾時 300 秒）用這個資料夾的 `Dockerfile`；
部署中的版本就是這個儲存庫 `main` 的 commit（`GET /v1/source` 的 `commit`）。
