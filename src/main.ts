// 引擎的進入點（Cloud Run 與本機的 npm run engine:dev 都用這支）：Firebase 驗證、Storage 讀檔、Firestore 記用量。
import type { AddressInfo } from 'node:net';
import { readConfig } from './config.ts';
import { firebaseServices } from './firebase.ts';
import { createEngineServer } from './server.ts';
import { SourceCache } from './sources.ts';
import { docUsageStore } from './usage.ts';
import { ENGINE_VERSION } from './version.ts';

const config = readConfig();
const services = firebaseServices({ projectId: config.projectId, bucket: config.bucket });
const sources = new SourceCache(services.sources, {
  dir: config.cacheDir,
  maxBytes: config.cacheMaxBytes,
  maxOpen: config.maxOpenDocuments,
});
const server = createEngineServer({
  verifier: services.verifier,
  sources,
  usage: docUsageStore(services.usageDocs, config.dailyPageLimit),
  source: { repository: config.repository, commit: config.commit },
  log: (entry) => {
    process.stdout.write(`${JSON.stringify({ severity: Number(entry.status) >= 500 ? 'ERROR' : 'INFO', ...entry })}\n`);
  },
});
server.listen(config.port, config.host, () => {
  const { port } = server.address() as AddressInfo;
  process.stdout.write(`atria-pdf-engine ${ENGINE_VERSION} listening on http://${config.host}:${String(port)}\n`);
});
const stop = () => {
  server.close();
  sources.close();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
