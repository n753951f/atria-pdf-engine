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
| `POST /v1/render` | `{ source, items[{ page, clip? }] }` | `{ items[{ page, box, svg, bytes }], next[], warnings[] }`＋SVG（文字轉路徑） |

- 每個回應都有 `engineVersion`（例如 `mupdf-1.28.1/engine-2`）、`sourceSha256`、`pageCount`。
- 有檔案的回應是 `multipart/form-data`：`meta` 是上面的 JSON，其他部分的名稱就是 JSON 裡的檔名（`p0041.png`、`p0041@300.png`、`r000.svg`）。
- 座標是 PDF 座標：pt，原點在頁面左上角，矩形是 `[x, y, width, height]`。單字的 ID 是 `p0041w0001`（頁＋頁內序號）。
- 單字 `{ id, text, box, line, size, font, flags, conf, glyphs? }`：含沒有正確 Unicode 的字元（U+FFFD、私用區、控制字元，通常是 PDF 字型的 ToUnicode 缺漏）時多一個 `glyphs[{ at, font, gid }]`（第幾個字元、字型、字形編號），同一個字型的同一個 `gid` 畫出來是同一個字形。
- 一次回應最多約 24 MB、做 200 秒；做不完的頁（或 render 的項目索引）放在 `next`，照樣再請求一次。
- render 的 `warnings[{ item, page, skipped, count, reason }]`：畫的時候跳過的物件（`item` 是請求裡第幾項，`skipped` 是 `shading`／`image`／`path`／`text`，`reason` 是 mupdf 的訊息；沒有時空陣列）。單一物件畫不出來時不讓整項失敗：跳過那個物件重畫（最多畫 4 次：第 2、3 次跳過前面出錯的那幾個，第 4 次跳過出過錯的整個種類），其他內容照畫。裁切、群組、遮罩這類不能跳過的出錯、跳過之後還是不行、或頁面內容本身讀不了時回 `422 render_failed`（`message`「PDF 頁 N 畫不出來：原因」，另有 `page`、`item`）。
- 錯誤：`{ error: { code, message } }`。`401 unauthenticated`、`403 forbidden`、`404 source_not_found`、`400 bad_request`／`page_out_of_range`、`422 render_failed`（只有 render）、`429 busy`（同一個帳號同時只能有一個請求）／`daily_limit`（每人每天 3000 頁，台北時間）。
- Admins (ID tokens whose `admin` custom claim is `true`) are exempt from the daily page limit: requests are never rejected with `daily_limit`, pages are still counted in `users/{uid}/engine/usage` (which also records `unlimited: true`), and the one-request-at-a-time `busy` limit still applies. 管理員（ID token 的 `admin` 自訂宣告是 `true`）不受每日頁數上限：不回 `daily_limit`，頁數照樣記在 `users/{uid}/engine/usage`（另記 `unlimited: true`），同時 1 個請求（`busy`）照舊。

## 執行

```bash
npm ci   # package-lock.json 固定所有依賴的版本
# 本機：用 GOOGLE_APPLICATION_CREDENTIALS 指向的憑證讀 Firebase
PORT=8790 node src/main.ts
npm test
```

`fixtures/mesh-shading.pdf`：測試用的合成 PDF（`src/test-fixtures.ts` 的 `buildShadingPdf()` 產生，測試會檢查兩者一致）：第 1 頁有文字、ShadingType 4–7 的漸層網格、shading pattern、線性漸層，以及壞掉的 shading（ShadingType 97、115、資料截斷、BitsPerFlag 3）；第 2 頁只有文字。本機只想對這份 PDF 試 render 時用 `src/test-server.ts`（`ENGINE_TEST_SOURCE_DIR` 指到放 `users/<uid>/books/<bookId>/source.pdf` 的資料夾、`ENGINE_TEST_TOKENS='{"t":"<uid>"}'`，不碰 Firebase）。

環境變數：`PORT`、`ENGINE_PROJECT_ID`、`ENGINE_BUCKET`、`ENGINE_DAILY_PAGE_LIMIT`、`ENGINE_CACHE_DIR`、`ENGINE_CACHE_MAX_BYTES`、`ENGINE_SOURCE_REPOSITORY`、`ENGINE_SOURCE_COMMIT`。

部署（Cloud Run，asia-east1、最少 0／最多 2 個執行個體、2 GiB、逾時 300 秒）用這個資料夾的 `Dockerfile`；
部署中的版本就是這個儲存庫 `main` 的 commit（`GET /v1/source` 的 `commit`）。

## 已知問題

**mupdf.js 1.28.1 的 Shade 參考計數**：自訂 `Device` 的 `fillShade` callback 收到的 `Shade` 是 mupdf.js 用 `new Shade(pointer)` 包住借來的指標，沒有先 keep（`Path`、`Text`、`Image` 都有）；這個包裝被 GC 回收時 finalizer 多 drop 一次，shade 被提早釋放、PDF 的資源快取還指著它。之後再畫到同一個 shading 就讀到被覆寫的記憶體：`Error: Unexpected mesh type 97`／`115`（數字是殘留的位元組），或 wasm 直接 `memory access out of bounds`。引擎會快取打開的 PDF，所以同一本書之後的請求一直失敗。`src/operations.ts` 的 `borrowShade()` 在 callback 一開始取消那個包裝的 finalizer 登記（工單 67）；升級 mupdf 時確認上游修好了再拿掉。
