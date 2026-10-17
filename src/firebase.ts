// 雲端的實作：Firebase Auth 驗 ID token、Storage 讀原始 PDF、Firestore 記每日用量。
// Cloud Run 上用執行個體的服務帳號；本機（npm run engine:dev）用 GOOGLE_APPLICATION_CREDENTIALS 指向的憑證。
import { initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { SourceNotFoundError, type SourceStore } from './sources.ts';
import type { UsageDoc, UsageDocStore } from './usage.ts';

export interface TokenVerifier {
  /** 無效時丟錯 */
  verify(idToken: string): Promise<{ uid: string }>;
}

export interface FirebaseServices {
  readonly verifier: TokenVerifier;
  readonly sources: SourceStore;
  readonly usageDocs: UsageDocStore;
}

export function firebaseServices(options: { projectId: string; bucket: string }): FirebaseServices {
  const app: App = initializeApp({ projectId: options.projectId, storageBucket: options.bucket }, `pdf-engine-${String(process.pid)}`);
  const auth = getAuth(app);
  const bucket = getStorage(app).bucket(options.bucket);
  const firestore = getFirestore(app);
  return {
    verifier: {
      async verify(idToken) {
        const decoded = await auth.verifyIdToken(idToken);
        return { uid: decoded.uid };
      },
    },
    sources: {
      async stat(path) {
        const file = bucket.file(path);
        let metadata;
        try {
          [metadata] = await file.getMetadata();
        } catch (error) {
          if ((error as { code?: unknown }).code === 404) throw new SourceNotFoundError(`找不到 ${path}`);
          throw error;
        }
        return {
          path,
          version: String(metadata.generation ?? metadata.etag ?? ''),
          bytes: Number(metadata.size ?? 0),
          download: async () => {
            const [buffer] = await file.download();
            return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          },
        };
      },
    },
    usageDocs: {
      async transact(uid, update) {
        const ref = firestore.doc(`users/${uid}/engine/usage`);
        return firestore.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          const next: UsageDoc = update(snap.exists ? (snap.data() as UsageDoc) : null);
          tx.set(ref, next);
          return next;
        });
      },
    },
  };
}
