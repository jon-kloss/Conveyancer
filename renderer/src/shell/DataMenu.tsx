// The DATA pipeline panel, docked in the titlebar's right corner (design handoff:
// "DATA Screen Redesign"). Present on BOTH the map and the factory graph so
// auto-sync's timer keeps ticking everywhere. Reframed from a flat list into a
// 3-step status pipeline — ① Game catalog → ② Import save → ③ Keep in sync — each
// step a card with a status chip, its action(s), and its path hints inline; a
// locked step states WHY in visible text, not a hover tooltip. Empire switching
// and the destructive wipe moved out to EmpireMenu. Controlled open state lives
// in Titlebar so only one titlebar menu is open at once. Escape (and invoking
// ⌘K search) closes the dropdown — its fixed backdrop would otherwise swallow
// clicks while the menu quietly stayed open.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../state/store";
import Glyph from "../lib/glyphs";
import ImportModal from "../import/ImportModal";
import {
  syncAutoCapable,
  needsClassicPicker,
  pickSaveForSync,
  readStoredSilently,
  getSyncMeta,
  recordSyncMeta,
  relTime,
  type SyncMeta,
} from "../import/syncSource";
import "./shell.css";

export default function DataMenu({
  open,
  onOpen,
  onClose,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const importFile = useStore((s) => s.importFile);
  const setImportFile = useStore((s) => s.setImportFile);
  const uploadingDocs = useStore((s) => s.uploadingDocs);
  const uploadDocs = useStore((s) => s.uploadDocs);
  const syncImport = useStore((s) => s.syncImport);
  const pushToast = useStore((s) => s.pushToast);
  const lastImport = useStore((s) => s.lastImport);
  const buildVersion = useStore((s) => s.gamedata.buildVersion);
  const catalogLoaded = useStore((s) => {
    const bv = s.gamedata.buildVersion;
    return !!bv && bv !== "fixture";
  });
  // "Sync from save" re-reads a previously imported save to reconcile — with
  // no imported save in the plan there is nothing to sync against, so the
  // control stays disabled until an import has landed (import-provenance
  // factories; syncMeta below also counts once a first sync recorded one).
  const hasImportedSave = useStore((s) =>
    Object.values(s.plan.factories).some((f) => f.createdBy?.kind === "import"),
  );
  const autoSync = useStore((s) => s.autoSync);
  const setAutoSync = useStore((s) => s.setAutoSync);
  const autoPull = useStore((s) => s.autoPull);

  const fileRef = useRef<HTMLInputElement>(null);
  const docsRef = useRef<HTMLInputElement>(null);

  // Escape closes the dropdown (top layer first — capture, so it works even
  // while focus sits in the header search input), and invoking the ⌘K search
  // closes it too: the menu's fixed backdrop sits above the search results'
  // stacking context, so the two must never be open at once.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // consumed: closing the menu must not ALSO clear the map selection
        // (this capture listener runs before the views' bubble handlers)
        e.stopPropagation();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        onClose(); // NOT consumed — ⌘K continues on to focus the search
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const loadDocsFile = useCallback(
    async (f: File) => {
      const bytes = new Uint8Array(await f.arrayBuffer());
      await uploadDocs(bytes); // uploadingDocs flag is store-managed
    },
    [uploadDocs],
  );

  // Sync Phase 2: "Sync from save" re-reads the retained save handle and
  // reconciles in one click. Gated on a real Docs.json (a fixture catalog would
  // quarantine most recipes → junk diffs). Chrome/Edge get the no-re-pick handle
  // path; elsewhere it falls back to the classic file input (re-pick each time).
  const [syncMeta, setSyncMetaState] = useState<SyncMeta | undefined>();
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    // A missing/blocked handle store just means no "last synced" affordance —
    // never a dead end. Runs on both builds now (desktop reads the meta KV).
    void getSyncMeta().then(setSyncMetaState).catch(() => {});
  }, []);
  // The catalog gate is WEB-only: web enforces "upload Docs.json first" (a
  // fixture catalog quarantines recipes → junk diffs), and there IS an upload
  // remedy. Desktop's catalog is host-provided (FICSIT_DOCS_JSON) with no
  // in-app upload, and import itself isn't catalog-gated there — so sync isn't
  // either.
  const catalogReady = !__WASM_BACKEND__ || catalogLoaded;
  const syncReady = catalogReady && (hasImportedSave || !!syncMeta);
  const onSync = useCallback(async () => {
    if (!syncReady || syncing) return; // defensive; the button is disabled too
    if (needsClassicPicker()) {
      // No File System Access (non-Chrome/Edge web) — reuse the classic picker
      // + ImportModal. Desktop always retains a native path, so it never lands here.
      fileRef.current?.click();
      return;
    }
    setSyncing(true);
    try {
      const file = await pickSaveForSync();
      if (!file) return; // user cancelled the picker / denied permission
      const outcome = await syncImport(file);
      if (outcome) setSyncMetaState(await recordSyncMeta(file.name));
    } catch (e) {
      // IDB/permission-layer failure (syncImport itself never rejects) — toast
      // instead of leaking an unhandled rejection.
      pushToast(`Couldn't sync from save — ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSyncing(false);
    }
  }, [syncReady, syncing, syncImport, pushToast]);

  // Sync Phase 3: auto-pull. Needs both the Docs.json gate AND File System
  // Access (the timer re-reads the retained handle with no user gesture, so it
  // is Chrome/Edge-only). Option B (in store.autoPull): conflict-free drift
  // applies silently; real conflicts open review. Mounted at titlebar level,
  // the timer now keeps running inside factory views too.
  const autoSyncReady = syncReady && syncAutoCapable();
  const autoPullBusy = useRef(false);
  const recordSync = useCallback(async (name: string) => {
    setSyncMetaState(await recordSyncMeta(name));
  }, []);
  const onToggleAutoSync = useCallback(async () => {
    if (!autoSyncReady) return; // defensive; the row is aria-disabled too
    if (autoSync.enabled) {
      setAutoSync(false);
      return;
    }
    if (syncing) return; // a pick/sync is already in flight — no double picker
    setSyncing(true);
    try {
      // Establish the source up front (this click is the user gesture the
      // silent timer can't provide later); bail if the user cancels the pick.
      let file = await readStoredSilently();
      if (!file) file = await pickSaveForSync();
      if (!file) return;
      setAutoSync(true);
      pushToast(
        __WASM_BACKEND__
          ? `Auto-sync on — every ${autoSync.intervalMin} min while this tab is open (Chrome/Edge)`
          : `Auto-sync on — re-reads your save every ${autoSync.intervalMin} min while the app is open`,
        "info",
      );
      const outcome = await autoPull(file); // one immediate pull so it visibly works
      if (outcome) await recordSync(file.name);
    } catch (e) {
      pushToast(`Couldn't start auto-sync — ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSyncing(false);
    }
  }, [autoSyncReady, autoSync, setAutoSync, pushToast, autoPull, recordSync, syncing]);
  useEffect(() => {
    if (!autoSync.enabled || !autoSyncReady) return;
    let cancelled = false;
    const tick = async () => {
      // Skip a tick that would collide: another pull running, or an open review
      // (never clobber a proposal the user is mid-decision on).
      if (cancelled || autoPullBusy.current || useStore.getState().reviewing) return;
      autoPullBusy.current = true;
      try {
        const file = await readStoredSilently();
        if (!file) return; // permission lapsed / no handle / path gone — skip quietly
        const outcome = await autoPull(file);
        if (outcome && !cancelled) await recordSync(file.name);
      } catch {
        /* transient read failure — the next tick retries */
      } finally {
        autoPullBusy.current = false;
      }
    };
    const id = window.setInterval(() => void tick(), autoSync.intervalMin * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [autoSync.enabled, autoSync.intervalMin, autoSyncReady, autoPull, recordSync]);

  // ── Pipeline state ───────────────────────────────────────────────────────
  // Web must load the catalog BEFORE a save so classes resolve; desktop's
  // catalog is host-provided, so step ① is always done there.
  const catalogDone = catalogReady; // !__WASM_BACKEND__ || catalogLoaded
  const importDone = hasImportedSave;
  const syncedOnce = !!syncMeta;
  const doneCount = [catalogDone, importDone, syncedOnce].filter(Boolean).length;
  const platform = __WASM_BACKEND__ ? "WEB" : "DESKTOP";
  const summaryOk = doneCount === 3;

  // "running" reflects a timer that is ACTUALLY ticking — autoSyncReady gates
  // the interval effect, so `autoSync.enabled` alone can lie (it persists
  // independently of plan contents; if the gate later drops, the toggle goes
  // aria-disabled and the timer stops, yet enabled stays true). Guard both the
  // marker state and the chip on autoSyncReady so the UI never claims auto-sync
  // is running while it's stopped and un-turn-off-able.
  const autoRunning = autoSync.enabled && autoSyncReady;
  type StepState = "done" | "current" | "locked" | "running";
  const step1: StepState = catalogDone ? "done" : "current";
  const step2: StepState = importDone ? "done" : catalogDone ? "current" : "locked";
  const step3: StepState = autoRunning
    ? "running"
    : syncedOnce
      ? "done"
      : syncReady
        ? "current"
        : "locked";

  const importFromInput = () => {
    onClose();
    fileRef.current?.click();
  };

  const syncStatus = autoRunning
    ? `AUTO · EVERY ${autoSync.intervalMin} MIN`
    : syncMeta
      ? `SYNCED ${relTime(syncMeta.lastSyncedAt).toUpperCase()}`
      : "NEVER SYNCED";

  return (
    <div className="data-menu-wrap">
      <button
        className={`btn btn-ghost ${open ? "active" : ""}`}
        onClick={() => (open ? onClose() : onOpen())}
        data-testid="btn-data-menu"
        title="Load your game's Docs.json, import a save, and keep it in sync"
      >
        {uploadingDocs ? "LOADING CATALOG…" : "DATA ▾"}
      </button>
      {open && (
        <>
          <div className="data-menu-backdrop" onClick={onClose} />
          <div className="data-menu data-pipeline" data-testid="data-menu">
            <div className="data-pipeline-head">
              <span className="t-panel-header data-pipeline-title">Game data</span>
              <span className={`data-pipeline-summary mono ${summaryOk ? "ok" : ""}`}>
                {summaryOk ? "ALL SYSTEMS FED" : `${doneCount} OF 3 STEPS DONE`} · {platform}
              </span>
            </div>

            {/* ── Step ① Game catalog ─────────────────────────────────────── */}
            <StepCard n={1} state={step1} connectDone={step1 === "done" && step2 === "done"}>
              <div className="pl-title-row">
                <span className="pl-title">Game catalog</span>
                {step1 === "done" ? (
                  <span className="pl-chip ok">
                    {/* On desktop the catalog is host-provided; show its build
                        only when it's a real one. "fixture"/empty is the same
                        sentinel `catalogLoaded` treats as not-a-real-catalog —
                        never surface it as a build label ("LOADED · BUILD FIXTURE"). */}
                    {__WASM_BACKEND__ || !buildVersion || buildVersion === "fixture"
                      ? "CATALOG LOADED"
                      : `LOADED · BUILD ${buildVersion}`}
                  </span>
                ) : (
                  <span className="pl-chip warn">NOT LOADED — START HERE</span>
                )}
              </div>
              {__WASM_BACKEND__ ? (
                catalogLoaded ? (
                  <>
                    <span className="pl-sub">Uploaded catalog is live — swap it if you change game versions.</span>
                    <div className="pl-action">
                      <button
                        className="btn btn-ghost pl-btn"
                        onClick={() => {
                          onClose();
                          docsRef.current?.click();
                        }}
                        disabled={uploadingDocs}
                        data-testid="btn-upload-docs-first"
                      >
                        SWAP GAME VERSION
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="pl-sub">
                      Docs.json from your game install — resolves every recipe before a save can import.
                    </span>
                    <div className="pl-action">
                      <button
                        className="btn btn-primary pl-btn"
                        onClick={() => {
                          onClose();
                          docsRef.current?.click();
                        }}
                        disabled={uploadingDocs}
                        data-testid="btn-upload-docs-first"
                      >
                        UPLOAD DOCS.JSON
                      </button>
                      <span className="pl-microcopy mono">or drop the file anywhere</span>
                    </div>
                    {/* Full fixed path segments — the leading … stands only for
                        the variable library/drive root; steamapps\common and
                        Epic Games are real fixed dirs, so keep them (a help path
                        that omits them sends the user to a folder that isn't there). */}
                    <div className="pl-hints mono">
                      <div>
                        <span className="pl-hint-key">STEAM</span>…\steamapps\common\Satisfactory\CommunityResources\Docs\en-US.json
                      </div>
                      <div>
                        <span className="pl-hint-key">EPIC</span>…\Epic Games\SatisfactoryEarlyAccess\CommunityResources\Docs\en-US.json
                      </div>
                    </div>
                  </>
                )
              ) : (
                <span className="pl-sub">host-provided via FICSIT_DOCS_JSON — resolves your save's recipes.</span>
              )}
            </StepCard>

            {/* ── Step ② Import save ───────────────────────────────────────── */}
            <StepCard n={2} state={step2} connectDone={step2 === "done" && step3 !== "locked"}>
              <div className="pl-title-row">
                <span className="pl-title">
                  <Glyph name="import" size={14} /> Import save
                </span>
                {step2 === "locked" ? (
                  <span className="pl-chip">NEEDS CATALOG</span>
                ) : importDone ? (
                  <span className="pl-chip">{(lastImport?.saveName ?? "SAVE IMPORTED").toUpperCase()}</span>
                ) : (
                  <span className="pl-chip">NO SAVE YET</span>
                )}
              </div>
              {step2 === "locked" ? (
                <>
                  <span className="pl-sub">
                    .sav — your factories land as the ◆ built layer. Unlocks after step ①.
                    <br />
                    %LOCALAPPDATA%\FactoryGame\Saved\SaveGames\
                  </span>
                  {/* The button stays present (aria-disabled) so it's reachable,
                      but the VISIBLE lock reason is the text above — not a
                      hover-only tooltip. */}
                  <div className="pl-action">
                    <button
                      className="btn btn-ghost pl-btn"
                      aria-disabled
                      title="Upload your Docs.json first (step ① above) — then import your save"
                      data-testid="btn-import"
                    >
                      IMPORT .SAV
                    </button>
                  </div>
                </>
              ) : importDone ? (
                <>
                  <span className="pl-sub">
                    {lastImport
                      ? `${lastImport.factoriesAdded} ${lastImport.factoriesAdded === 1 ? "factory" : "factories"} as ◆ built · imported ${relTime(new Date(lastImport.at).getTime())}`
                      : "your factories are live as the ◆ built layer"}
                  </span>
                  <div className="pl-action">
                    <button className="btn btn-ghost pl-btn" onClick={importFromInput} data-testid="btn-import">
                      IMPORT ANOTHER SAVE
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="pl-sub">
                    .sav — your factories land as the ◆ built layer ·
                    %LOCALAPPDATA%\FactoryGame\Saved\SaveGames\
                  </span>
                  <div className="pl-action">
                    <button className="btn btn-primary pl-btn" onClick={importFromInput} data-testid="btn-import">
                      IMPORT .SAV
                    </button>
                  </div>
                </>
              )}
            </StepCard>

            {/* ── Step ③ Keep in sync ──────────────────────────────────────── */}
            <StepCard n={3} state={step3} connectDone={false} last>
              <div className="pl-title-row">
                <span className="pl-title">Keep in sync</span>
                <span className="pl-chip" data-testid="sync-status">
                  {step3 === "locked" ? (catalogReady ? "NEEDS AN IMPORTED SAVE" : "NEEDS CATALOG") : syncStatus}
                </span>
              </div>
              {step3 === "locked" ? (
                <span className="pl-sub">re-reads your save & reconciles — manually or on a timer.</span>
              ) : (
                <>
                  <span className="pl-sub">
                    applies safe changes silently, asks on conflicts — one undo step either way.
                  </span>
                  <div className="pl-sync-row">
                    <button
                      className="btn btn-ghost pl-btn"
                      onClick={() => {
                        if (!syncReady || syncing || autoSync.enabled) return;
                        onClose();
                        void onSync();
                      }}
                      aria-disabled={!syncReady || syncing || autoSync.enabled}
                      title={autoSync.enabled ? "Auto-sync is on — turn it off to sync manually" : undefined}
                      data-testid="btn-sync-save"
                    >
                      {syncing ? "SYNCING…" : "SYNC NOW"}
                    </button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={autoSync.enabled}
                      aria-disabled={!autoSyncReady}
                      className={`sync-auto ${autoSync.enabled ? "on" : ""}`}
                      onClick={() => void onToggleAutoSync()}
                      title={
                        autoSyncReady
                          ? autoSync.enabled
                            ? "Auto-sync on — click to turn off"
                            : __WASM_BACKEND__
                              ? "Auto-sync: re-read on a timer (Chrome/Edge, this tab open)"
                              : "Auto-sync: re-read your save on a timer while the app is open"
                          : "Auto-sync needs the File System Access API — use Chrome or Edge"
                      }
                      data-testid="btn-auto-sync"
                    >
                      <span className="sync-auto-text mono">AUTO</span>
                      <span className="sync-auto-track" aria-hidden>
                        <span className="sync-auto-knob" />
                      </span>
                    </button>
                    {autoSync.enabled && autoSyncReady && (
                      <div className="autosync-intervals" data-testid="autosync-intervals">
                        {[5, 10, 15].map((n) => (
                          <button
                            key={n}
                            type="button"
                            className={`autosync-chip ${n === autoSync.intervalMin ? "active" : ""}`}
                            onClick={() => setAutoSync(true, n)}
                            data-testid={`autosync-${n}`}
                          >
                            {n}m
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </StepCard>
          </div>
        </>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".sav"
        style={{ display: "none" }}
        data-testid="import-file-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setImportFile(f);
          e.currentTarget.value = "";
        }}
      />
      {__WASM_BACKEND__ && (
        <input
          ref={docsRef}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          data-testid="docs-file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.currentTarget.value = "";
            if (f) void loadDocsFile(f);
          }}
        />
      )}
      {/* Portal to <body>: the modal's absolute inset-0 scrim must cover the
          viewport, not this titlebar-corner wrapper (position: relative). */}
      {importFile &&
        createPortal(<ImportModal file={importFile} onClose={() => setImportFile(null)} />, document.body)}
    </div>
  );
}

// One pipeline step: a left rail (marker + connector line) beside the card body.
function StepCard({
  n,
  state,
  connectDone,
  last,
  children,
}: {
  n: number;
  state: "done" | "current" | "locked" | "running";
  connectDone: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`pl-card ${state === "locked" ? "locked" : ""} ${last ? "last" : ""}`}>
      <div className="pl-rail">
        <span className={`pl-marker ${state}`} aria-hidden>
          {state === "done" ? "✓" : state === "running" ? "◇" : n}
        </span>
        {!last && <span className={`pl-connector ${connectDone ? "done" : ""}`} aria-hidden />}
      </div>
      <div className="pl-body">{children}</div>
    </div>
  );
}
