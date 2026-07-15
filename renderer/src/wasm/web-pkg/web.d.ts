/* tslint:disable */
/* eslint-disable */

/**
 * A browser-resident planner session: one canonical `Session` over an
 * in-memory store, driven by the renderer through a `WasmBackend`. The worker
 * owns this and the IndexedDB snapshot around it.
 */
export class WebSession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * THE router. `cmd` selects a `Session` operation mirroring the dev-bridge
     * `(method, url)` route table; `args` carries that route's request body
     * (the exact shapes the `WasmBackend` sends). Results marshal back with the
     * same `json_compatible` convention the renderer already consumes, wrapped
     * in an envelope `{ mutated, result }`.
     *
     * `mutated` is the Rust-driven mutation signal (M1): each arm declares
     * whether it WROTE the store — mirroring the dev-bridge GET-vs-store-writing
     * -POST distinction — so the worker knows, authoritatively and without a
     * hand-kept allowlist that can drift, exactly when to snapshot to IndexedDB.
     */
    dispatch(cmd: string, args: any): any;
    /**
     * Apply one or more commands as a single undoable step. `cmds` is a JS
     * array of `Command` objects; returns the `EditResponse`.
     */
    edit(cmds: any): any;
    /**
     * Serialize the WHOLE store to bytes for the IndexedDB snapshot. The worker
     * calls this after every mutating dispatch and `put`s the result under the
     * current-plan key. Never fails observably: an in-memory store always
     * encodes, but if it somehow could not, an empty blob is returned rather
     * than trapping (the next mutation re-snapshots).
     */
    export_blob(): Uint8Array;
    /**
     * Full projection for the renderer's initial hydration.
     */
    hydrate(): any;
    /**
     * Build a session. `docs_json` is the raw bytes of an uploaded `Docs.json`
     * (real game catalog); `None` falls back to the bundled fixture, exactly
     * like the desktop app's fixture path. `blob` is a previously-exported
     * snapshot (from [`WebSession::export_blob`], read back out of IndexedDB);
     * `None` starts a fresh empty plan. Panics are routed to the console for
     * legible wasm stack traces.
     */
    constructor(docs_json?: Uint8Array | null, blob?: Uint8Array | null);
    /**
     * Read-only ranked next moves (heuristic engine) over a fresh solve.
     */
    next_moves(): any;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_websession_free: (a: number, b: number) => void;
    readonly websession_dispatch: (a: number, b: number, c: number, d: any) => [number, number, number];
    readonly websession_edit: (a: number, b: any) => [number, number, number];
    readonly websession_export_blob: (a: number) => [number, number];
    readonly websession_hydrate: (a: number) => [number, number, number];
    readonly websession_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly websession_next_moves: (a: number) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
