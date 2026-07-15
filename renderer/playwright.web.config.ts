import { defineConfig } from "@playwright/test";

// Web smoke config — SEPARATE from playwright.config.ts (the 31 dev-bridge
// specs) so the two never share a project, server, or plan file. This one
// drives the BUILT web app (`pnpm build:web` → `dist-web`), served statically
// by `vite preview`, with NO backend server: the whole app runs client-side in
// a Web Worker over IndexedDB. The proof it exists to give is the one the
// dev-bridge suite structurally cannot — that the wasm bundle boots, edits, and
// PERSISTS across a reload in a real browser.
export default defineConfig({
  testDir: "./e2e-web",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: "http://localhost:4173",
    viewport: { width: 1920, height: 1080 },
    contextOptions: { reducedMotion: "reduce" },
    launchOptions: process.env.PW_EXECUTABLE ? { executablePath: process.env.PW_EXECUTABLE } : {},
  },
  webServer: {
    // Serve the already-built web bundle. `build:web` (wasm-pack + vite build
    // --mode web) must have produced dist-web first; the smoke asserts against
    // that artifact, not the dev server.
    command: "pnpm exec vite preview --outDir dist-web --port 4173 --strictPort",
    port: 4173,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
