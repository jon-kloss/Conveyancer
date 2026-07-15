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
// WHICH dispatches snapshot is NOT a hand-kept allowlist here (that drifted:
// chat_send drafts a proposal but was omitted). `dispatch` returns an envelope
// `{ mutated, result }` and Rust is the single source of truth — each arm
// declares whether it wrote the store. The worker snapshots iff `mutated`.
//
// Requests are serialized through a promise chain so a mutation's snapshot
// write always completes before the next request mutates — matching the
// mutex-serialized desktop shell. `dispatch` itself is synchronous inside the
// worker (a Rust call), so within one request there is no interleaving.

import init, { WebSession } from "../wasm/web-pkg/web.js";
import wasmUrl from "../wasm/web-pkg/web_bg.wasm?url";

const DB_NAME = "ficsit-planner";
const STORE = "plans";
const KEY = "current";
/** Where a blob that fails to reconstruct a session is parked (M2) so a corrupt
 *  or version-mismatched save never bricks the app AND is not silently lost. */
const CORRUPT_KEY = "current-corrupt";
/** The uploaded Docs.json (Phase 4a), kept in the SAME object store under its
 *  own key so a real game catalog survives reloads. `undefined` → the bundled
 *  fixture compiled into web_bg.wasm. Stored as the raw uploaded bytes (the
 *  Rust `decode` handles gzip), and passed to `WebSession(docs, plan)` on boot. */
const DOCS_KEY = "docs";

/** The dispatch envelope Rust returns (M1): `mutated` is the authoritative
 *  "did this write the store?" signal; `result` is the marshaled reply. */
interface Envelope {
  mutated: boolean;
  result: unknown;
}

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

async function loadDocs(): Promise<Uint8Array | undefined> {
  const db = await openDb();
  return new Promise<Uint8Array | undefined>((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(DOCS_KEY);
    req.onsuccess = () => {
      const v = req.result as Uint8Array | ArrayBuffer | undefined;
      if (!v) resolve(undefined);
      else resolve(v instanceof Uint8Array ? v : new Uint8Array(v));
    };
    req.onerror = () => reject(req.error ?? new Error("indexedDB docs get failed"));
  });
}

async function saveDocs(bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(new Uint8Array(bytes), DOCS_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB docs put failed"));
  });
}

/** M2: park an unreadable blob under the `-corrupt` key so it is preserved for
 *  debugging/recovery but no longer sits on the boot path. Best-effort — a
 *  failure to back it up must not stop the app from booting fresh. */
async function backupCorruptBlob(bytes: Uint8Array): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(new Uint8Array(bytes), CORRUPT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("indexedDB backup put failed"));
    });
  } catch (e) {
    console.warn("[wasm-worker] could not back up the corrupt blob", e);
  }
}

let session: WebSession | null = null;
let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  ready ??= (async () => {
    await init({ module_or_path: wasmUrl });
    const [blob, docs] = await Promise.all([loadBlob(), loadDocs()]);
    // docs → a previously-uploaded real Docs.json (Phase 4a); undefined → the
    // bundled fixture catalog compiled into the wasm. blob → reconstruct the
    // saved plan, else a fresh empty one.
    if (blob) {
      try {
        session = new WebSession(docs, blob);
        return;
      } catch (e) {
        // M2: the saved blob is corrupt or from a mismatched SNAPSHOT_VERSION.
        // Durability of one plan must never cost the ability to open the app:
        // back the bad blob up, warn, and boot a FRESH session. (Caching the
        // rejected promise here would brick the app permanently.) The docs are
        // kept — a bad plan blob must not also discard the uploaded catalog.
        console.warn(
          "[wasm-worker] saved plan is unreadable — starting fresh; a backup was kept under the -corrupt key",
          e,
        );
        await backupCorruptBlob(blob);
      }
    }
    session = new WebSession(docs, undefined);
  })();
  return ready;
}

/** Phase 4a: swap in an uploaded Docs.json without losing the current plan.
 *  gamedata is set only at construction, so this REBUILDS the WebSession from
 *  the uploaded catalog bytes plus the current plan's exported snapshot, then
 *  persists both (docs under DOCS_KEY, the re-exported plan under KEY). If no
 *  session exists yet (upload before first hydrate), construct fresh over the
 *  saved plan blob. Throws are surfaced to the caller's rejected promise. */
async function uploadDocs(bytes: Uint8Array): Promise<void> {
  await ensureReady();
  const planBlob = session ? session.export_blob() : await loadBlob();
  // Copy off the wasm heap before the old session is dropped/replaced.
  const planCopy = planBlob && planBlob.length > 0 ? new Uint8Array(planBlob) : undefined;
  const next = new WebSession(bytes, planCopy);
  session = next;
  await saveDocs(bytes);
  await saveBlob(session.export_blob());
}

interface Req {
  id: number;
  /** Control message kind. Absent → the normal `dispatch(cmd, args)` path.
   *  "upload_docs" → rebuild the session over an uploaded Docs.json (Phase 4a). */
  kind?: "upload_docs";
  cmd?: string;
  args?: unknown;
  /** upload_docs payload: the raw uploaded Docs.json bytes. */
  bytes?: Uint8Array;
}

// Serialize every request behind a single promise chain (see header): a
// mutation's snapshot write completes before the next request runs.
let chain: Promise<void> = Promise.resolve();

// L1: view-state writes (map pan/zoom fire one per gesture) are coalesced. A
// `set_view_state` mutation arms a trailing timer instead of snapshotting
// inline; a subsequent REAL mutation flushes it immediately so no view-state
// write is ever lost or reordered ahead of a plan edit.
const VIEW_DEBOUNCE_MS = 500;
let viewFlushTimer: ReturnType<typeof setTimeout> | null = null;
let viewSnapshotPending = false;

function cancelViewTimer(): void {
  if (viewFlushTimer !== null) {
    clearTimeout(viewFlushTimer);
    viewFlushTimer = null;
  }
}

/** Snapshot the store to IndexedDB now, clearing any pending debounced
 *  view-state write (this snapshot subsumes it). */
async function snapshotNow(): Promise<void> {
  cancelViewTimer();
  viewSnapshotPending = false;
  await saveBlob(session!.export_blob());
}

/** Arm (or re-arm) the trailing debounce that flushes a view-state snapshot.
 *  The timer body runs on the serialization chain so it never races a request. */
function scheduleViewSnapshot(): void {
  viewSnapshotPending = true;
  cancelViewTimer();
  viewFlushTimer = setTimeout(() => {
    viewFlushTimer = null;
    chain = chain.then(async () => {
      if (!viewSnapshotPending || !session) return;
      viewSnapshotPending = false;
      try {
        await saveBlob(session.export_blob());
      } catch (e) {
        console.warn("[wasm-worker] debounced view-state snapshot failed", e);
      }
    });
  }, VIEW_DEBOUNCE_MS);
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, kind, cmd, args, bytes } = e.data;
  chain = chain.then(async () => {
    try {
      // Control path: rebuild the session over an uploaded Docs.json (Phase 4a).
      // Not a `dispatch` — gamedata is construction-only — so it is handled here,
      // on the same serialization chain so no request interleaves the swap.
      if (kind === "upload_docs") {
        await uploadDocs(bytes ?? new Uint8Array());
        self.postMessage({ id, ok: true, result: undefined });
        return;
      }
      await ensureReady();
      const env = session!.dispatch(cmd!, args) as Envelope;
      if (env.mutated) {
        // L1: coalesce the frequent view-state write; every other mutation
        // snapshots inline (and flushes any pending view-state write with it).
        if (cmd === "set_view_state") scheduleViewSnapshot();
        else await snapshotNow();
      }
      self.postMessage({ id, ok: true, result: env.result });
    } catch (err) {
      // dispatch rejects with the Session error MESSAGE (a JsValue string) or a
      // panic Error; normalize to a string the renderer surfaces on its chip.
      const message = err instanceof Error ? err.message : String(err);
      self.postMessage({ id, ok: false, error: message });
    }
  });
};
