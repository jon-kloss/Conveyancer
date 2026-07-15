import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the renderer runs against either the Tauri shell (devUrl) or the
// headless dev-bridge (proxy below). Prod (desktop): built into the Tauri
// bundle. WEB (`--mode web`): a fully client-side SPA + wasm — VITE_BACKEND=wasm
// (from .env.web) selects the WasmBackend, output goes to dist-web, and assets
// load relative (base "./") so the static bundle serves from any path.
export default defineConfig(({ mode }) => {
  const web = mode === "web";
  return {
    plugins: [react()],
    clearScreen: false,
    // A COMPILE-TIME boolean (not a runtime env access) so Rollup can statically
    // eliminate the WasmBackend branch in backend.ts: only the web build sets it
    // true, so a desktop/dev build dead-code-drops the dynamic `import` and never
    // emits the worker or the .wasm chunk. `import.meta.env.VITE_BACKEND` is left
    // as a runtime property access by Vite (not const-folded), which is why a
    // dedicated define is required to keep the desktop bundle byte-for-byte old.
    define: { __WASM_BACKEND__: JSON.stringify(web) },
    // Relative asset URLs for the web bundle so it serves from any static host
    // (Railway/Phase 4). Desktop/dev keep the default absolute base.
    ...(web ? { base: "./" } : {}),
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${process.env.FICSIT_BRIDGE_PORT ?? 8791}`,
          changeOrigin: true,
        },
      },
    },
    build: {
      target: "es2022",
      // Separate output so the web build never clobbers the desktop `dist`
      // the Tauri bundle embeds.
      ...(web ? { outDir: "dist-web" } : {}),
    },
    // The wasm session worker (state/wasmWorker.ts) is a MODULE worker that
    // statically imports the wasm-bindgen glue; the ES worker format is what
    // lets Vite bundle that import graph. Scoped to the web build so the
    // desktop/dev worker output (parseWorker) stays on the default format.
    ...(web ? { worker: { format: "es" as const } } : {}),
    // The save-parse Web Worker (src/import/parseWorker.ts) imports the heavy
    // @etothepii/satisfactory-file-parser. vite's dep scanner does not follow
    // `new Worker(new URL(...))`, so without this the parser's whole ESM tree is
    // transformed ON DEMAND the first time the worker loads — cheap on a warm dev
    // box, but pathologically slow cold on a constrained CI runner (the e2e save
    // import timed out at 120s there). Pre-bundling it at server startup makes the
    // first worker load instant. Dev-only; the production build is unaffected.
    optimizeDeps: { include: ["@etothepii/satisfactory-file-parser"] },
  };
});
