// 引擎的版本：mupdf 的版本＋引擎規則的版本。App 端用它當抽字結果的快取版本（extractor），
// 所以改了任何會影響輸出（單字、座標、旗標、頁面圖）的規則時，把 ENGINE_RULES 加一。
export const MUPDF_VERSION = '1.28.1';
export const ENGINE_RULES = 'engine-2';
export const ENGINE_VERSION = `mupdf-${MUPDF_VERSION}/${ENGINE_RULES}`;

/** 公開原始碼的位置（AGPL-3.0 §13）；部署時用環境變數覆寫成實際的儲存庫與 commit */
export const DEFAULT_REPOSITORY = 'https://github.com/n753951f/atria-pdf-engine';
