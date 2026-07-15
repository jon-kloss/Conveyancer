import { defineConfig } from "vitest/config";

// Unit tests for the renderer's pure logic (e.g. the save-parse reducer in
// src/import/parseSnapshot.ts). Kept separate from vite.config.ts so the build
// config (react plugin, dev proxy, worker pre-bundle) stays untouched. The
// reducer under test is pure TS with no DOM/worker dependency → node env.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
