// IndexedDB cache for as-built logistics geometry (logisticsGeometry.ts).
// Renderer-side ambient data, same trust class as the world-node snapshot:
// derived from the player's save, refreshed by every import, never part of
// the plan file. Keyed by save name so multi-empire switching re-associates
// the right geometry via each plan's lastImport.saveName; only the most
// recent save's geometry is kept per name (a re-import overwrites in place).

import type { BuiltLogistics } from "./logisticsGeometry";

const DB = "manifold-geometry";
const STORE = "saves";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => {
          db.close();
          resolve(req.result);
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      }),
  );
}

export async function saveGeometry(g: BuiltLogistics): Promise<void> {
  await tx("readwrite", (s) => s.put(g, g.saveName));
}

export async function loadGeometry(saveName: string): Promise<BuiltLogistics | null> {
  try {
    const g = await tx<BuiltLogistics | undefined>("readonly", (s) => s.get(saveName));
    return g && g.version === 1 && Array.isArray(g.lines) ? g : null;
  } catch {
    // a missing/blocked IDB just means no as-built layer — never a dead end
    return null;
  }
}
