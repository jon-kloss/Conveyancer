// Save import (SDD §8, onboarding step-3 grammar): .sav → worker parse →
// preview table with honest counts + quarantine → IMPORT AS BUILT. First
// import writes the ◆ Built layer (one undo step); re-imports never write —
// drift arrives as a SaveReimport proposal reviewed like any other.

import { useCallback, useRef, useState } from "react";
import { useStore } from "../state/store";
import { backend } from "../state/backend";
import { parseSaveFile } from "./parseSave";
import type { BuiltLogistics } from "./logisticsGeometry";
import type { ImportSnapshot } from "../state/types";

type Phase =
  | { step: "parsing"; name: string }
  | { step: "preview"; snapshot: ImportSnapshot }
  | { step: "importing" }
  | { step: "error"; message: string }
  | { step: "done"; message: string };

export default function ImportModal({ file, onClose }: { file: File; onClose: () => void }) {
  const hydrate = useStore((s) => s.hydrate);
  const setReviewing = useStore((s) => s.setReviewing);
  const adoptLogistics = useStore((s) => s.adoptLogistics);
  // As-built geometry from the same parse — adopted only when the user
  // commits the import (a cancelled preview must not repaint the map).
  const logisticsRef = useRef<BuiltLogistics | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const started = useRef(false);

  // Live until run, then latched. The scrim blocks clicks but not keys: ⌘Z can
  // flip the ◆ built layer while the preview is open, and the backend re-derives
  // has_built when the import actually runs — so the header/warning/CTA must
  // track live plan state or they'd promise a diff while the click performs a
  // first import (or vice versa). Once the user commits we latch the value the
  // run saw, so the done-state header keeps describing the flow that ran instead
  // of relabeling itself "RE-IMPORT SAVE" the instant its own write lands.
  const liveHasBuilt = useStore((s) => Object.values(s.plan.factories).some((f) => f.status === "built"));
  const [latched, setLatched] = useState<boolean | null>(null);
  const hasBuilt = latched ?? liveHasBuilt;

  const start = useCallback(async () => {
    setPhase({ step: "parsing", name: file.name });
    try {
      const { snapshot, logistics } = await parseSaveFile(file);
      logisticsRef.current = logistics;
      setPhase({ step: "preview", snapshot });
    } catch (e) {
      // no dead ends: parse failure degrades to manual entry
      setPhase({ step: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [file]);

  if (!started.current) {
    started.current = true;
    void start();
  }

  const runImport = async (snapshot: ImportSnapshot) => {
    setLatched(liveHasBuilt); // freeze the label to what this run is about to do
    setPhase({ step: "importing" });
    try {
      const outcome = await backend.importRun(snapshot);
      if (logisticsRef.current) void adoptLogistics(logisticsRef.current);
      await hydrate(); // the built layer landed backend-side; re-project
      if (outcome.outcome === "imported") {
        setPhase({
          step: "done",
          message: `${outcome.factories} factories · ${outcome.machines} machines imported as ◆ BUILT${
            outcome.quarantined > 0 ? ` · ${outcome.quarantined} unrecognized objects quarantined` : ""
          }`,
        });
      } else if (outcome.outcome === "drift") {
        onClose();
        setReviewing(outcome.proposal);
      } else {
        setPhase({ step: "done", message: "BUILT LAYER IN SYNC — no drift since this save." });
      }
    } catch (err) {
      setPhase({ step: "error", message: String(err) });
    }
  };

  const belts = (s: ImportSnapshot) => Object.values(s.belts ?? {}).reduce((a, b) => a + b, 0);
  const quarantined = (s: ImportSnapshot) => Object.values(s.quarantined ?? {}).reduce((a, b) => a + b, 0);

  return (
    <div className="wizard-scrim" data-testid="import-modal">
      <div className="wizard-modal" style={{ width: 720 }}>
        <header className="wizard-head">
          <span className="wizard-stamp mono">IMPORT</span>
          <span className="t-title">{hasBuilt ? "RE-IMPORT SAVE" : "IMPORT SAVE AS BUILT"}</span>
          <button className="drawer-close" onClick={onClose} aria-label="Close" style={{ marginLeft: "auto" }}>
            ×
          </button>
        </header>
        <div className="wizard-body import-body">
          {phase?.step === "parsing" && (
            <div className="mono" style={{ color: "var(--ink-500)", display: "flex", alignItems: "center", gap: 8 }}>
              <span className="diamond-spin" aria-hidden /> PARSING {phase.name}… (community-reverse-engineered format,
              in a worker)
            </div>
          )}

          {phase?.step === "preview" && (
            <>
              <div className="import-grid mono" data-testid="import-preview">
                <span>MACHINES</span>
                <span>{phase.snapshot.machines.length}</span>
                <span>EXTRACTORS</span>
                <span>{phase.snapshot.extractors?.length ?? 0}</span>
                <span>BELTS</span>
                <span>{belts(phase.snapshot)}</span>
                <span>RAIL SEGMENTS</span>
                <span>{phase.snapshot.rails ?? 0}</span>
                <span>POWER LINES</span>
                <span>{phase.snapshot.powerLines ?? 0}</span>
                <span>TRAINS</span>
                <span>
                  {phase.snapshot.locomotives ?? 0} LOCO + {phase.snapshot.wagons ?? 0} WAGON ·{" "}
                  {phase.snapshot.trainStations ?? 0} STATIONS
                </span>
                <span>UNRECOGNIZED</span>
                <span>{quarantined(phase.snapshot)} → ignored</span>
              </div>
              {quarantined(phase.snapshot) > 0 && (
                <details className="import-quarantine mono">
                  <summary>VIEW UNRECOGNIZED CLASSES</summary>
                  {Object.entries(phase.snapshot.quarantined ?? {})
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 12)
                    .map(([cls, n]) => (
                      <div key={cls} className="import-quarantine-row">
                        <span>{cls}</span>
                        <span>×{n}</span>
                      </div>
                    ))}
                  {Object.keys(phase.snapshot.quarantined ?? {}).length > 12 && (
                    <div className="import-quarantine-row">
                      <span>… {Object.keys(phase.snapshot.quarantined ?? {}).length - 12} more classes</span>
                    </div>
                  )}
                </details>
              )}
              <div className="wizard-infeasible" style={{ borderColor: "var(--flow-warn)" }}>
                <span className="wizard-foot-note" style={{ color: "var(--flow-warn)" }}>
                  The save format is community-reverse-engineered. Everything imports as ◆ BUILT
                  {hasBuilt
                    ? " — this re-import never writes: differences arrive as a reviewable drift proposal."
                    : " — your plan is never touched; future re-imports diff against built."}
                </span>
              </div>
              <footer className="wizard-foot">
                <button
                  className="btn btn-primary"
                  onClick={() => void runImport(phase.snapshot)}
                  data-testid="btn-import-run"
                >
                  {hasBuilt ? "DIFF AGAINST BUILT" : "IMPORT AS BUILT"}
                </button>
                <button className="btn btn-ghost" onClick={onClose}>
                  SKIP — MANUAL ENTRY
                </button>
              </footer>
            </>
          )}

          {phase?.step === "importing" && (
            <div className="mono" style={{ color: "var(--ink-500)" }}>
              CLUSTERING MACHINES INTO FACTORIES…
            </div>
          )}

          {phase?.step === "done" && (
            <>
              <div className="mono" data-testid="import-done">
                {phase.message}
              </div>
              <footer className="wizard-foot">
                <button className="btn btn-primary" onClick={onClose}>
                  DONE
                </button>
              </footer>
            </>
          )}

          {phase?.step === "error" && (
            <>
              <div className="wizard-infeasible">
                <span className="t-label" style={{ color: "var(--flow-warn)" }}>
                  PARSE FAILED — SKIP: EVERYTHING WORKS WITH MANUAL ENTRY
                </span>
                <span className="wizard-foot-note">{phase.message.slice(0, 300)}</span>
              </div>
              <footer className="wizard-foot">
                <button className="btn btn-ghost" onClick={onClose}>
                  CLOSE
                </button>
              </footer>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
