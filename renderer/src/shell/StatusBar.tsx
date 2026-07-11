// Status bar (24px): power draw, ◈ under-construction count, ⚠ CRIT belts
// (clickable), right-side totals. Counts collapse to a ⋯ chip in overlay mode.

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../state/store";
import { fmtPower, flowLevel } from "../lib/format";

export default function StatusBar({ overlayMode }: { overlayMode: boolean }) {
  const plan = useStore((s) => s.plan);
  const derived = useStore((s) => s.derived);
  const setView = useStore((s) => s.setView);
  const setSelection = useStore((s) => s.setSelection);
  const cmdError = useStore((s) => s.cmdError);
  const clearCmdError = useStore((s) => s.clearCmdError);
  const [expanded, setExpanded] = useState(false);

  // auto-clear after ~6s; the `at` handshake keeps a stale timer from
  // dismissing an error that arrived after the timer was armed.
  useEffect(() => {
    if (!cmdError) return;
    const at = cmdError.at;
    const t = window.setTimeout(() => clearCmdError(at), 6000);
    return () => window.clearTimeout(t);
  }, [cmdError, clearCmdError]);

  const ucCount = useMemo(
    () =>
      Object.values(plan.groups).filter((g) => g.status === "under_construction").length +
      Object.values(plan.factories).filter((f) => f.status === "under_construction").length,
    [plan],
  );

  const critEdges = useMemo(() => {
    const out: { factory: string; edge: string }[] = [];
    for (const [fid, df] of Object.entries(derived.factories)) {
      for (const [eid, e] of Object.entries(df.edges)) {
        if (flowLevel(e.saturation) === "crit") out.push({ factory: fid, edge: eid });
      }
    }
    return out;
  }, [derived]);

  const jumpToCrit = () => {
    const first = critEdges[0];
    if (!first) return;
    setView({ mode: "factory", factoryId: first.factory });
    setSelection({ kind: "edge", id: first.edge });
  };

  const counts = (
    <>
      <span className="sb-item mono" title="Planned machines under construction">
        ◈ {ucCount}
      </span>
      <button
        className={`sb-item mono ${critEdges.length ? "sb-crit" : ""}`}
        onClick={jumpToCrit}
        disabled={!critEdges.length}
        title="Saturated belts (≥95%)"
      >
        ⚠ {critEdges.length}
      </button>
    </>
  );

  return (
    <footer className="statusbar">
      <span className="sb-item mono" data-testid="sb-power">
        PWR {fmtPower(derived.totalPowerMw)}
        {derived.totalGenerationMw > 0 && <span className="sb-gen"> / {fmtPower(derived.totalGenerationMw)}</span>}
        <span className="sb-powerbar" aria-hidden>
          <span
            style={{
              width: `${Math.min(
                100,
                derived.totalGenerationMw > 0
                  ? (derived.totalPowerMw / derived.totalGenerationMw) * 100
                  : derived.totalPowerMw / 5,
              )}%`,
            }}
          />
        </span>
      </span>
      {overlayMode ? (
        <span style={{ position: "relative" }}>
          <button className="sb-item mono" onClick={() => setExpanded((e) => !e)}>
            ⋯
          </button>
          {expanded && <span className="sb-popover">{counts}</span>}
        </span>
      ) : (
        counts
      )}
      {cmdError && (
        <button
          className="sb-item mono sb-error"
          data-testid="sb-error"
          onClick={() => clearCmdError(cmdError.at)}
          title={cmdError.message}
        >
          ⚠ <span className="sb-error-msg">{cmdError.message}</span>
        </button>
      )}
      <span className="sb-spring" />
      <span className="sb-item mono">
        {Object.keys(plan.factories).length} FACTORIES · {Object.keys(plan.groups).length} GROUPS ·{" "}
        {Object.keys(plan.nodeClaims).length} CLAIMS
      </span>
    </footer>
  );
}
