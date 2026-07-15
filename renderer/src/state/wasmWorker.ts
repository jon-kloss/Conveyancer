// WASM session worker (Web Phase 3). Runs the Rust `Session` (via the wasm
// `WebSession`) OFF the UI thread — the same off-thread pattern parseWorker.ts
// uses for save parsing — and OWNS the IndexedDB snapshot around it.
//
// Persistence is a SNAPSHOT layer, not a PlanStore impl: `PlanStore` is
// synchronous and IndexedDB is async, so the wasm Session keeps its in-memory
// `MemoryPlanStore` and durability is a blob. After every MUTATING dispatch the
// worker exports the whole store (`export_blob`) and `put`s it under one
// "current plan" key; on boot it reads that blob back and reconstructs the
// session from it (else the bundled fixture). IndexedDB `put` is atomic per
// key, so browser durability is a clean last-edit snapshot (no partial write).
//
// Requests are serialized through a promise chain so a mutation's snapshot
// write always completes before the next request mutates — matching the
// mutex-serialized desktop shell. `dispatch` itself is synchronous inside the
// worker (a Rust call), so within one request there is no interleaving.

import init, { WebSession } from "../wasm/web-pkg/web.js";
import wasmUrl from "../wasm/web-pkg/web_bg.wasm?url";

/** Commands that MUTATE the store and therefore require a fresh snapshot.
 *  `set_build_done` rides `edit`; `wizard_solve`/`t2_optimize`/reads do not
 *  mutate (a wizard result only becomes state when a later `edit` accepts it). */
const MUTATING = new Set([
  "edit",
  "undo",
  "redo",
  "import_run",
  "proposal_accept",
  "optimize_adopt",
  "plan_replacement",
  "set_next_preferences",
  "set_view_state",
  "advisor_dismiss",
  "advisor_unmute",
  "advisor_pause",
]);

const DB_NAME = "ficsit-planner";
const STORE = "plans";
const KEY = "current";

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
  return dbPromise;
}

async function loadBlob(): Promise<Uint8Array | undefined> {
  const db = await openDb();
  return new Promise<Uint8Array | undefined>((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
    req.onsuccess = () => {
      const v = req.result as Uint8Array | ArrayBuffer | undefined;
      if (!v) resolve(undefined);
      else resolve(v instanceof Uint8Array ? v : new Uint8Array(v));
    };
    req.onerror = () => reject(req.error ?? new Error("indexedDB get failed"));
  });
}

async function saveBlob(bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    // Copy off the wasm heap: the Uint8Array `export_blob` returns is a view
    // that a later mutation would invalidate; IndexedDB stores a structured
    // clone, but the clone must snapshot stable bytes, so hand it a fresh copy.
    tx.objectStore(STORE).put(new Uint8Array(bytes), KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB put failed"));
  });
}

let session: WebSession | null = null;
let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  ready ??= (async () => {
    await init({ module_or_path: wasmUrl });
    const blob = await loadBlob();
    // docs_json = undefined → the wasm build's bundled fixture catalog (upload
    // UX is Phase 4). blob → reconstruct the saved plan, else a fresh empty one.
    session = new WebSession(undefined, blob ?? undefined);
  })();
  return ready;
}

interface Req {
  id: number;
  cmd: string;
  args?: unknown;
}

// Serialize every request behind a single promise chain (see header): a
// mutation's snapshot write completes before the next request runs.
let chain: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, cmd, args } = e.data;
  chain = chain.then(async () => {
    try {
      await ensureReady();
      const result = session!.dispatch(cmd, args);
      if (MUTATING.has(cmd)) await saveBlob(session!.export_blob());
      self.postMessage({ id, ok: true, result });
    } catch (err) {
      // dispatch rejects with the Session error MESSAGE (a JsValue string) or a
      // panic Error; normalize to a string the renderer surfaces on its chip.
      const message = err instanceof Error ? err.message : String(err);
      self.postMessage({ id, ok: false, error: message });
    }
  });
};
