// 測試用的引擎（只在本機跑，Cloud Run 不會用到這支）：
// 原始 PDF 從本機資料夾讀（path 對應到 ENGINE_TEST_SOURCE_DIR 底下的檔案），
// token 是 ENGINE_TEST_TOKENS（JSON：token → uid），用量記在記憶體。只聽 127.0.0.1。
import type { AddressInfo } from 'node:net';
import { readConfig } from './config.ts';
import { createEngineServer } from './server.ts';
import { SourceCache, directorySourceStore } from './sources.ts';
import { memoryUsageStore } from './usage.ts';
import { ENGINE_VERSION } from './version.ts';

if (process.env.K_SERVICE) throw new Error('test-server 不能在 Cloud Run 上執行');
const dir = process.env.ENGINE_TEST_SOURCE_DIR;
if (!dir) throw new Error('缺少 ENGINE_TEST_SOURCE_DIR');
const tokens = new Map(Object.entries(JSON.parse(process.env.ENGINE_TEST_TOKENS ?? '{}') as Record<string, string>));
const config = readConfig({ ...process.env, ENGINE_HOST: '127.0.0.1' });
const sources = new SourceCache(directorySourceStore(dir), {
  dir: config.cacheDir,
  maxBytes: config.cacheMaxBytes,
  maxOpen: config.maxOpenDocuments,
});
const server = createEngineServer({
  verifier: {
    verify(token) {
      const uid = tokens.get(token);
      return uid ? Promise.resolve({ uid }) : Promise.reject(new Error('invalid token'));
    },
  },
  sources,
  usage: memoryUsageStore(config.dailyPageLimit),
  source: { repository: config.repository, commit: 'test' },
});
server.listen(config.port, '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo;
  process.stdout.write(`atria-pdf-engine ${ENGINE_VERSION} (test) listening on http://127.0.0.1:${String(port)}\n`);
});
process.on('SIGTERM', () => {
  server.close();
  sources.close();
  process.exit(0);
});
