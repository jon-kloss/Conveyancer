// Custom titlebar (36px): logo square, app name, breadcrumb, save-sync chip,
// solver status, window controls. Frameless in Tauri; controls hidden in bridge mode.

import { useEffect, useState } from "react";
import { useStore, solveChip } from "../state/store";
import DataMenu from "./DataMenu";
import EmpireMenu from "./EmpireMenu";
import "./shell.css";

const isTauri = "__TAURI_INTERNALS__" in window;

async function windowAction(action: "minimize" | "toggleMaximize" | "close") {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  if (action === "minimize") await w.minimize();
  else if (action === "toggleMaximize") await w.toggleMaximize();
  else await w.close();
}

export default function Titlebar({ overlayMode }: { overlayMode: boolean }) {
  const view = useStore((s) => s.view);
  const plan = useStore((s) => s.plan);
  const derived = useStore((s) => s.derived);
  const setView = useStore((s) => s.setView);
  const reviewing = useStore((s) => s.reviewing);

  // Only one titlebar dropdown open at a time — opening one closes the other.
  const [openMenu, setOpenMenu] = useState<"empire" | "data" | null>(null);
  // A proposal review unmounts both menus (below). Reset the lifted open state
  // too, or a menu that was open when a background auto-pull opened the review
  // would silently reopen (with its click-swallowing backdrop) on review close.
  useEffect(() => {
    if (reviewing) setOpenMenu(null);
  }, [reviewing]);

  const factory = view.mode === "factory" ? plan.factories[view.factoryId] : null;
  const chip = solveChip(factory ? derived.factories[factory.id] : undefined);

  return (
    <header className="titlebar" data-tauri-drag-region>
      {/* MANIFOLD mark (brand handoff §1, titlebar-20 geometry): the
          header-pipe manifold in on-signal dark on the container's existing
          signal-500 square — one source diamond feeds a bus, three taps
          deliver to sinks. Diamond = factory, square = infrastructure. */}
      <div className="titlebar-logo" aria-hidden>
        <svg viewBox="0 0 64 64" width="14" height="14">
          <path
            d="M32 14 V26 M14 26 H50 M14 26 V40 M32 26 V40 M50 26 V40"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            opacity="0.6"
          />
          <path d="M32 0 L42 10 L32 20 L22 10 Z" fill="currentColor" />
          <path d="M14 37 L22 45 L14 53 L6 45 Z" fill="currentColor" />
          <path d="M32 37 L40 45 L32 53 L24 45 Z" fill="currentColor" />
          <path d="M50 37 L58 45 L50 53 L42 45 Z" fill="currentColor" />
        </svg>
      </div>
      {/* #117: no wordmark — the user knows what the tool is. The crumb stays
          (WORLD MAP is the way home from a factory), search sits CENTERED in
          the bar and is context-aware (map view portals the node/factory
          search here; the factory graph portals its machine/item search), and
          the save/load DATA menu docks in the right corner. */}
      <div className="titlebar-slot titlebar-slot-search" id="titlebar-search-slot" />
      <nav className={`titlebar-crumb mono ${overlayMode ? "truncate" : ""}`}>
        <button className="crumb-link" onClick={() => setView({ mode: "map" })}>
          WORLD MAP
        </button>
        {factory && (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb-here">{factory.name}</span>
          </>
        )}
      </nav>
      <div className="titlebar-right">
        {/* save/load corner: the EMPIRE switcher + DATA pipeline menus live
            HERE (not portaled from a view) so they exist on the map AND inside
            factories, and auto-sync's timer keeps ticking everywhere. Hidden
            during proposal review — loading more data or switching empires
            mid-review would fight the open proposal. */}
        {!reviewing && (
          <>
            <EmpireMenu
              open={openMenu === "empire"}
              onOpen={() => setOpenMenu("empire")}
              onClose={() => setOpenMenu(null)}
            />
            <DataMenu
              open={openMenu === "data"}
              onOpen={() => setOpenMenu("data")}
              onClose={() => setOpenMenu(null)}
            />
          </>
        )}
        <span className="chip" title="Every commit writes the plan file — there is no unsaved state.">
          SAVED ✓
        </span>
        {factory && (
          <span className={`chip ${chip.over ? "warn" : ""}`} data-testid="solve-chip">
            {chip.text}
          </span>
        )}
        {isTauri && (
          <div className="win-controls">
            <button onClick={() => windowAction("minimize")} aria-label="Minimize">
              –
            </button>
            <button onClick={() => windowAction("toggleMaximize")} aria-label="Maximize">
              ▢
            </button>
            <button className="win-close" onClick={() => windowAction("close")} aria-label="Close">
              ×
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
