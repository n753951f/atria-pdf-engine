// 引擎的設定（環境變數）。Cloud Run 會設 PORT 與 K_SERVICE。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAILY_PAGE_LIMIT } from './usage.ts';
import { DEFAULT_REPOSITORY } from './version.ts';

export interface EngineConfig {
  readonly host: string;
  readonly port: number;
  readonly projectId: string;
  readonly bucket: string;
  readonly dailyPageLimit: number;
  readonly cacheDir: string;
  readonly cacheMaxBytes: number;
  readonly maxOpenDocuments: number;
  readonly repository: string;
  readonly commit: string;
}

function intOf(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const onCloudRun = Boolean(env.K_SERVICE);
  const projectId = env.ENGINE_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT ?? 'atria-f86ae';
  return {
    host: env.ENGINE_HOST ?? (onCloudRun ? '0.0.0.0' : '127.0.0.1'),
    port: intOf(env.PORT, 8790),
    projectId,
    bucket: env.ENGINE_BUCKET ?? `${projectId}.firebasestorage.app`,
    dailyPageLimit: intOf(env.ENGINE_DAILY_PAGE_LIMIT, DAILY_PAGE_LIMIT),
    cacheDir: env.ENGINE_CACHE_DIR ?? join(tmpdir(), 'atria-pdf-engine-cache'),
    // Cloud Run 的 /tmp 在記憶體裡（算進 2 GiB），所以預設只留 400 MB
    cacheMaxBytes: intOf(env.ENGINE_CACHE_MAX_BYTES, 400 * 1024 * 1024),
    maxOpenDocuments: Math.max(1, intOf(env.ENGINE_MAX_OPEN_DOCUMENTS, 2)),
    repository: env.ENGINE_SOURCE_REPOSITORY ?? DEFAULT_REPOSITORY,
    commit: env.ENGINE_SOURCE_COMMIT ?? 'unknown',
  };
}
