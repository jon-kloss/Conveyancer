// Desktop save-sync parity: on the desktop/dev-bridge build the "Sync from
// save" + "Auto-sync" controls are available (they used to be web-only), driven
// through the bridge's sync mirror (Tauri IPC isn't scriptable by Playwright).
// The bridge's /api/sync/pick returns the fixture wired via FICSIT_SYNC_SAVE.

import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { resetView } from "./helpers";

const API = "http://localhost:8791/api";
const SAVES = fileURLToPath(new URL("../../fixtures/saves", import.meta.url));

async function importSave(page: Page, file: string) {
  await page.getByTestId("btn-data-menu").click();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId("btn-import").click(),
  ]);
  await chooser.setFiles(`${SAVES}/${file}`);
  await expect(page.getByTestId("import-preview")).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("btn-import-run").click();
  await expect(page.getByTestId("import-done")).toBeVisible({ timeout: 60_000 });
  await page.locator(".wizard-foot .btn-primary").click(); // DONE
}

test("desktop build exposes Sync-from-save + Auto-sync and re-reads the native save", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000); // two .sav parses in a cold worker
  // Clean slate on the shared bridge, and wipe again on exit so the imported
  // save doesn't leak into later specs (this file sorts before phase4-import).
  await request.post(`${API}/new_empire`, { data: "{}" });
  await resetView(request);
  try {
    await runDesktopSync(page);
  } finally {
    await request.post(`${API}/new_empire`, { data: "{}" }).catch(() => {});
  }
});

async function runDesktopSync(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("map-root")).toBeVisible();

  // The DATA pipeline renders on the DESKTOP build (sync was __WASM_BACKEND__-
  // gated). With nothing imported, step ③ "Keep in sync" is LOCKED: its status
  // chip states the reason inline (no action button rendered yet).
  await page.getByTestId("btn-data-menu").click();
  await expect(page.getByTestId("sync-status")).toContainText("NEEDS AN IMPORTED SAVE");
  await expect(page.getByTestId("btn-sync-save")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Import the save → now there's a ◆ built layer to sync against.
  await importSave(page, "Dunarr-076.sav");

  // Sync from save: step ③ unlocks — SYNC NOW is enabled. The bridge stands in
  // for the native picker (FICSIT_SYNC_SAVE) → reads the same save → reconciles.
  // Re-reading the just-imported save is in-sync, so this is deterministic; the
  // point is the desktop path runs.
  await page.getByTestId("btn-data-menu").click();
  const syncBtn = page.getByTestId("btn-sync-save");
  await expect(syncBtn).toBeVisible();
  await expect(syncBtn).not.toHaveAttribute("aria-disabled", "true");
  await syncBtn.click(); // closes the menu, runs the sync

  // Re-open: the step ③ chip now reports it re-read the native save (sync-meta
  // stuck → "SYNCED JUST NOW" / "SYNCED …M AGO", not the "NEVER SYNCED" idle
  // state — note "NEVER SYNCED" also contains "SYNCED", so match the timestamp).
  await expect
    .poll(
      async () => {
        await page.getByTestId("btn-data-menu").click();
        const txt = await page.getByTestId("sync-status").innerText().catch(() => "");
        await page.keyboard.press("Escape");
        return txt;
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toMatch(/SYNCED (JUST NOW|\d)/);

  // Auto-sync is available on desktop (native FS supports the silent re-read).
  await page.getByTestId("btn-data-menu").click();
  const auto = page.getByTestId("btn-auto-sync");
  await expect(auto).not.toHaveAttribute("aria-disabled", "true");
  await auto.click(); // turn on → one immediate pull + interval chips appear
  await expect(page.getByTestId("autosync-intervals")).toBeVisible();
  await expect(auto).toHaveAttribute("aria-checked", "true");
  // While auto owns the re-read, the manual SYNC NOW is aria-disabled (the timer
  // owns it) — turning auto off is the only way to sync by hand.
  await expect(page.getByTestId("btn-sync-save")).toHaveAttribute("aria-disabled", "true");
  // Picking an interval makes exactly that chip active and the step ③ status
  // chip report the running cadence (drive explicit values — the persisted
  // default varies).
  await page.getByTestId("autosync-10").click();
  await expect(page.getByTestId("autosync-10")).toHaveClass(/active/);
  await expect(page.getByTestId("autosync-5")).not.toHaveClass(/active/);
  await expect(page.getByTestId("sync-status")).toHaveText("AUTO · EVERY 10 MIN");
  await page.getByTestId("autosync-5").click();
  await expect(page.getByTestId("autosync-5")).toHaveClass(/active/);
  await expect(page.getByTestId("autosync-10")).not.toHaveClass(/active/);
  await expect(page.getByTestId("sync-status")).toHaveText("AUTO · EVERY 5 MIN");
}
