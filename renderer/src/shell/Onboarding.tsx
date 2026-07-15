// First-run card (mock 7c step 4): land on the live empty map — three doors,
// no tour. Shown once per plan (dismiss persists via viewState) and only when
// the plan is genuinely empty.

import { useStore } from "../state/store";

export default function Onboarding() {
  const plan = useStore((s) => s.plan);
  const gamedata = useStore((s) => s.gamedata);
  const viewState = useStore((s) => s.viewState);
  const saveViewState = useStore((s) => s.saveViewState);
  const setWizard = useStore((s) => s.setWizard);
  const setPlacing = useStore((s) => s.setPlacingFactory);

  const empty = Object.keys(plan.factories).length === 0;
  const dismissed = viewState.onboarded === true;
  if (!empty || dismissed) return null;

  const done = () => saveViewState({ onboarded: true });

  const onFixture = gamedata.buildVersion === "fixture";
  // On the web build the catalog comes from an in-app Docs.json upload, not the
  // desktop FICSIT_DOCS_JSON env var — so give the web-honest instruction.
  const catalogHint = __WASM_BACKEND__
    ? onFixture
      ? "UPLOAD YOUR DOCS.JSON FOR THE FULL RECIPE CATALOG"
      : "REAL CATALOG LOADED"
    : "POINT FICSIT_DOCS_JSON AT A REAL INSTALL TO RE-EXTRACT";

  return (
    <div className="onboard-card" data-testid="onboarding">
      <div className="t-title" style={{ fontSize: 16 }}>
        THE MAP IS THE FACTORY PLANNER
      </div>
      <div className="mono onboard-source">
        CATALOG: {onFixture ? "BUNDLED FIXTURE" : `GAME BUILD ${gamedata.buildVersion}`} ·{" "}
        {Object.keys(gamedata.recipes).length} RECIPES · {catalogHint}
      </div>
      <div className="onboard-doors">
        <button
          className="onboard-door"
          onClick={() => {
            done();
            setPlacing(true);
          }}
          data-testid="door-factory"
        >
          <span className="mono onboard-key">N</span>
          <span>Place your first factory</span>
        </button>
        <button
          className="onboard-door"
          onClick={() => {
            done();
            setWizard({ open: true });
          }}
          data-testid="door-wizard"
        >
          <span className="mono onboard-key">P</span>
          <span>Plan a supply chain</span>
        </button>
        <button
          className="onboard-door"
          onClick={() => {
            done();
            document.querySelector<HTMLButtonElement>('[data-testid="btn-import"]')?.click();
          }}
          data-testid="door-import"
        >
          <span className="mono onboard-key">S</span>
          <span>Import a save as ◆ built</span>
        </button>
        {__WASM_BACKEND__ && onFixture && (
          <button
            className="onboard-door"
            onClick={() => {
              done();
              document.querySelector<HTMLButtonElement>('[data-testid="btn-upload-docs"]')?.click();
            }}
            data-testid="door-docs"
          >
            <span className="mono onboard-key">↑</span>
            <span>Upload your Docs.json</span>
          </button>
        )}
      </div>
      <button className="btn btn-ghost" onClick={done} style={{ alignSelf: "center" }} data-testid="onboard-skip">
        JUST THE MAP
      </button>
      <footer className="mono onboard-foot">NO TOUR. THE MAP TEACHES BY DOING — ⌘K WHENEVER LOST.</footer>
    </div>
  );
}
