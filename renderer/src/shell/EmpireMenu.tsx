// The EMPIRE switcher — its own titlebar control, split out of the DATA menu
// (design handoff: "DATA Screen Redesign"). A `● NAME ▾` chip shows the active
// empire; the dropdown switches / renames / creates / deletes empires and hosts
// the destructive "start over" wipe (moved here from DATA, where it semantically
// belongs). Each empire is its own plan; switching persists the outgoing one and
// re-hydrates the incoming one (store.empireSwitch). Controlled open state lives
// in Titlebar so only one of the two titlebar menus is ever open at once.

import { useCallback, useEffect, useState } from "react";
import { useStore } from "../state/store";
import "./shell.css";

export default function EmpireMenu({
  open,
  onOpen,
  onClose,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const planName = useStore((s) => s.plan.meta.name);
  const empireList = useStore((s) => s.empireList);
  const refreshEmpires = useStore((s) => s.refreshEmpires);
  const empireSwitch = useStore((s) => s.empireSwitch);
  const empireCreate = useStore((s) => s.empireCreate);
  const empireRename = useStore((s) => s.empireRename);
  const empireDelete = useStore((s) => s.empireDelete);
  const newEmpire = useStore((s) => s.newEmpire);
  const factoryCount = useStore((s) => Object.keys(s.plan.factories).length);

  // The active empire's name is authoritative from the last listing; before the
  // first refresh lands, the live plan's own name is the same thing.
  const active = empireList?.active ?? planName;
  const others = (empireList?.names ?? []).filter((n) => n !== active);

  // Inline-form / two-click-latch state. `renaming` holds which empire's rename
  // form is open (active or an other-row); the destructive latches (`confirmDelete`
  // per name, `confirmReset` for the wipe) all disarm whenever the menu closes.
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  // The list refetches on open, as the old menu did — a switch made from another
  // surface (or a fresh session) is reflected without a reload.
  useEffect(() => {
    if (open) void refreshEmpires();
  }, [open, refreshEmpires]);

  // Disarm every latch / close every inline form when the menu closes by ANY
  // path — an armed confirm surviving the close would wipe or delete on a single
  // later click.
  useEffect(() => {
    if (!open) {
      setConfirmReset(false);
      setConfirmDelete(null);
      setRenaming(null);
      setNewName("");
    }
  }, [open]);

  // Escape closes (capture, consumed so it doesn't also clear map selection),
  // and invoking ⌘K search closes without consuming — same contract as DataMenu,
  // since both menus share the one fixed-backdrop stacking layer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // a rename input eats Escape to cancel the rename only (below); this
        // top-level handler closes the whole menu otherwise.
        if (renaming) return;
        e.stopPropagation();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, renaming]);

  const startRename = useCallback((name: string) => {
    setRenaming(name);
    setRenameVal(name);
    setConfirmDelete(null);
  }, []);

  const doRename = useCallback(
    async (from: string) => {
      const to = renameVal.trim();
      if (!to || to === from) {
        setRenaming(null);
        return;
      }
      // empireRename catches and returns false on a refused (duplicate/invalid)
      // name — keep the form and the typed value open on failure so the user
      // can fix it rather than retype from scratch (the error surfaces as a toast).
      if (await empireRename(from, to)) setRenaming(null);
    },
    [renameVal, empireRename],
  );

  const doSwitch = useCallback(
    async (name: string) => {
      onClose();
      await empireSwitch(name);
    },
    [empireSwitch, onClose],
  );

  const doCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    // Only clear the field and close on success. A refused name (duplicate /
    // invalid → empireCreate returns false, surfaces a toast) leaves the menu
    // open with the typed value intact so the user can correct it.
    if (await empireCreate(name)) {
      setNewName("");
      onClose();
    }
  }, [newName, empireCreate, onClose]);

  const doDelete = useCallback(
    async (name: string) => {
      if (confirmDelete !== name) {
        setConfirmDelete(name);
        return;
      }
      setConfirmDelete(null);
      await empireDelete(name);
    },
    [confirmDelete, empireDelete],
  );

  const doReset = useCallback(async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    onClose();
    await newEmpire();
  }, [confirmReset, newEmpire, onClose]);

  return (
    <div className="empire-menu-wrap">
      <button
        className={`btn btn-ghost empire-chip ${open ? "active" : ""}`}
        onClick={() => (open ? onClose() : onOpen())}
        data-testid="btn-empire-menu"
        title="Switch, rename or create empires — each is its own plan"
      >
        <span className="empire-chip-dot" aria-hidden>
          ●
        </span>
        <span className="empire-chip-name">{active}</span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <>
          <div className="data-menu-backdrop" onClick={onClose} />
          <div className="empire-menu" data-testid="empires-section">
            <div className="empire-menu-head">
              <span className="t-panel-header empire-menu-title">Empires</span>
              <span className="empire-menu-note mono">EACH IS ITS OWN PLAN</span>
            </div>

            {/* Active empire — highlighted, not a switch; rename in place. */}
            <div className="empire-row active" data-testid={`empire-row-${active}`}>
              {renaming === active ? (
                <RenameForm
                  value={renameVal}
                  onChange={setRenameVal}
                  onSubmit={() => void doRename(active)}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <>
                  <span className="empire-row-dot" aria-hidden>
                    ●
                  </span>
                  <span className="empire-row-name is-active">{active}</span>
                  <span className="empire-row-tag mono">ACTIVE</span>
                  <button
                    className="empire-row-btn"
                    onClick={() => startRename(active)}
                    title="Rename this empire"
                    aria-label={`Rename ${active}`}
                    data-testid={`empire-rename-${active}`}
                  >
                    ✎
                  </button>
                </>
              )}
            </div>

            {/* Other empires — one click switches; rename / delete on the row. */}
            {others.map((name) => (
              <div className="empire-row" data-testid={`empire-row-${name}`} key={name}>
                {renaming === name ? (
                  <RenameForm
                    value={renameVal}
                    onChange={setRenameVal}
                    onSubmit={() => void doRename(name)}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <>
                    <button
                      className="empire-row-switch"
                      onClick={() => void doSwitch(name)}
                      data-testid={`empire-switch-${name}`}
                    >
                      <span className="empire-row-dot faint" aria-hidden>
                        ○
                      </span>
                      <span className="empire-row-name">{name}</span>
                    </button>
                    <button
                      className="empire-row-btn"
                      onClick={() => startRename(name)}
                      title="Rename this empire"
                      aria-label={`Rename ${name}`}
                      data-testid={`empire-rename-${name}`}
                    >
                      ✎
                    </button>
                    <button
                      className={`empire-row-btn danger ${confirmDelete === name ? "armed" : ""}`}
                      onClick={() => void doDelete(name)}
                      title={confirmDelete === name ? `Delete ${name} — click to confirm` : `Delete ${name}`}
                      aria-label={confirmDelete === name ? `Confirm delete ${name}` : `Delete ${name}`}
                      data-testid={`empire-delete-${name}`}
                    >
                      {confirmDelete === name ? "✕?" : "✕"}
                    </button>
                  </>
                )}
              </div>
            ))}

            {/* Create a new (empty) empire — becomes active on submit. */}
            <div className="empire-create-row">
              <input
                className="empire-create-input mono"
                placeholder="New empire name…"
                maxLength={64}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void doCreate();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    onClose();
                  }
                }}
                data-testid="empire-new-name"
              />
              <button
                className="btn btn-ghost empire-create-btn"
                disabled={!newName.trim()}
                onClick={() => void doCreate()}
                data-testid="empire-create"
              >
                + CREATE
              </button>
            </div>

            {/* Destructive wipe (moved from DATA) — only when there's something
                to clear. Two-click latch; disarms on any close. */}
            {factoryCount > 0 && (
              <button
                className={`empire-danger ${confirmReset ? "armed" : ""}`}
                onClick={() => void doReset()}
                data-testid="btn-new-empire"
              >
                <span className="empire-danger-label">
                  {confirmReset ? "Click again to wipe everything" : `Start ${active} over`}
                </span>
                <span className="empire-danger-sub">
                  {confirmReset
                    ? `deletes all ${factoryCount} ${factoryCount === 1 ? "factory" : "factories"} & routes — keeps your catalog`
                    : `wipes all ${factoryCount} ${factoryCount === 1 ? "factory" : "factories"} & routes — keeps your catalog · click twice`}
                </span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function RenameForm({
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="empire-rename-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <input
        autoFocus
        className="empire-create-input mono"
        maxLength={64}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
        data-testid="empire-rename-input"
      />
      <button type="submit" className="btn btn-ghost empire-create-btn" data-testid="empire-rename-ok">
        OK
      </button>
    </form>
  );
}
