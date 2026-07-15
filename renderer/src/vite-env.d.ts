/// <reference types="vite/client" />

// Compile-time transport flag, replaced by Vite `define` (vite.config.ts): true
// only in the `--mode web` build, so backend.ts statically dead-code-drops the
// WasmBackend branch (worker + .wasm) out of the desktop/dev bundle.
declare const __WASM_BACKEND__: boolean;
