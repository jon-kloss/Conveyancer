// Audit-only probe suite (renderer/e2e-audit) — NOT part of CI. Same bridge
// + dev-server plumbing as the main config; run with:
//   npx playwright test -c playwright.audit.config.ts
import base from "./playwright.config";
import { defineConfig } from "@playwright/test";

export default defineConfig({ ...base, testDir: "./e2e-audit" });
