// PR 3: the SHARED NEXT-MOVES feed. One component renders in BOTH homes — the
// resume dashboard (`context="dashboard"`) and the docked advisor NEXT tab
// (`context="panel"`) — reading the single store-owned rank slice, so the two
// surfaces never double-bill the provider or disagree. It carries the header
// (title + count + preference chips + AI gear), the model headline, the ranked
// cards + notes, the empty/loading/+N-more states, and the wildcard block.
//
// `context` tunes ONLY post-action dismiss behaviour:
//  - dashboard: every action dismisses the resume overlay so the target shows
//    through (PR 9's exact behaviour).
//  - panel: the panel is a FOLLOW-ALONG surface — map selects/audit leave it
//    docked over the revealed map; only the modal wizard opens over it.

import { useEffect } from "react";
import { useStore } from "../state/store";
import AiSettings from "../dashboard/AiSettings";
import ItemIcon from "../lib/ItemIcon";
import type { NextPreferences, Opportunity, OpportunityKind, Wildcard } from "../state/types";
import "../dashboard/dashboard.css";

/** Family chip labels for NEXT MOVES cards (PR 9). */
const MOVE_LABEL: Record<OpportunityKind, string> = {
  power_deficit: "POWER",
  deficit_repair: "DEFICIT",
  route_bottleneck_fix: "ROUTE",
  power_margin: "MARGIN",
  milestone_gap: "MILESTONE",
  alt_adopt: "ALT",
  under_extracted: "CLOCK",
  untapped_node: "NODE",
};

const NO_PREFS: NextPreferences = { noTrains: false, ignorePower: false };

/** A wildcard's editable starting rate when the model offered none — an honest
 *  round default (one Mk.1 belt), never presented as a solver fact. */
const WILDCARD_DEFAULT_RATE = 60;

export default function NextMovesFeed({ context }: { context: "dashboard" | "panel" }) {
  const rank = useStore((s) => s.rank);
  const gamedata = useStore((s) => s.gamedata);
  const plan = useStore((s) => s.plan);
  const world = useStore((s) => s.world);
  const rankEpoch = useStore((s) => s.rankEpoch);
  const setView = useStore((s) => s.setView);
  const setSelection = useStore((s) => s.setSelection);
  const setWizard = useStore((s) => s.setWizard);
  const openAuditTab = useStore((s) => s.openAuditTab);
  const requestFly = useStore((s) => s.requestFly);
  const setDashboardOpen = useStore((s) => s.setDashboardOpen);
  const setPreferences = useStore((s) => s.setPreferences);
  const bumpRankEpoch = useStore((s) => s.bumpRankEpoch);

  // Ref-count this surface so the shared model rank is issued once per
  // (planHash, epoch) across both homes, and refetched on a genuinely fresh
  // open (all surfaces closed). The register call itself kicks the first fetch.
  useEffect(() => {
    useStore.getState().registerFeed();
    return () => useStore.getState().unregisterFeed();
  }, []);
  // Re-rank on a config save or preference toggle (epoch bump); the guard in
  // openRankFeed keeps a second surface from re-billing at the same key.
  useEffect(() => {
    void useStore.getState().openRankFeed();
  }, [rankEpoch]);

  const moves = rank?.opportunities ?? null;
  const wildcards = rank?.engine === "model" ? (rank.wildcards ?? []) : [];
  const prefs = plan.meta.preferences ?? NO_PREFS;

  // dashboard dismisses on every action; the panel stays docked (follow-along).
  const dismiss = () => {
    if (context === "dashboard") setDashboardOpen(false);
  };

  // Where the camera should land for a select action (M5) — SAME node-position
  // precedence as the Rust untapped ranking: a cave node's ENTRANCE wins, the
  // plan-local override corrects entrance-less nodes, else the catalog x/y.
  const movePos = (a: Opportunity["action"]): { x: number; y: number } | null => {
    if (a.kind === "selectFactory") return plan.factories[a.id]?.position ?? null;
    if (a.kind === "selectNode") {
      const n = world.nodes.find((w) => w.id === a.id);
      const pos = n?.entrance ?? plan.nodeOverrides[a.id]?.pos ?? n;
      return pos ? { x: pos.x, y: pos.y } : null;
    }
    if (a.kind === "selectRoute") {
      const p = plan.routes[a.id]?.path ?? [];
      if (p.length === 0) return null;
      const lo = p[Math.floor((p.length - 1) / 2)];
      const hi = p[Math.ceil((p.length - 1) / 2)];
      return { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 };
    }
    return null;
  };

  // Open the wizard prefilled (FIX WITH SOLVER pattern). Shared by wizardGoal
  // cards and wildcard TRY IT. Dashboard dismisses so the wizard shows over the
  // map; the panel keeps the wizard's own modal layered over the docked panel.
  const openWizard = (prefill?: { item: string; rate: number }) => {
    dismiss();
    setWizard({ open: true, ...(prefill ? { prefill } : {}) });
  };

  // NEXT MOVES actions — every one lands on an existing pipe: the wizard
  // prefill, a map selection (+ camera fly) that leaves the panel docked, or an
  // audit tab. The dashboard dismisses so the target shows through.
  const actMove = (o: Opportunity) => {
    const a = o.action;
    if (a.kind === "wizardGoal") {
      openWizard({ item: a.item, rate: a.rate });
    } else if (a.kind === "selectRoute" || a.kind === "selectNode" || a.kind === "selectFactory") {
      setView({ mode: "map" });
      setSelection(
        a.kind === "selectRoute"
          ? { kind: "route", id: a.id }
          : a.kind === "selectNode"
            ? { kind: "node", id: a.id }
            : { kind: "factory", id: a.id },
      );
      const pos = movePos(a);
      if (pos) requestFly(pos);
      dismiss();
    } else {
      openAuditTab(a.tab);
      dismiss();
    }
  };

  const moveVerb = (o: Opportunity) =>
    o.action.kind === "wizardGoal" ? "PLAN IT" : o.action.kind === "openAudit" ? "OPEN" : "SHOW";

  // TRY IT hands a wildcard to the WIZARD — prefilled with the validated item
  // and a suggested rate (editable), or a bare wizard when there is no valid
  // item. NEVER writes plan state: the solver re-derives everything.
  const tryWildcard = (w: Wildcard) => {
    if (w.item) openWizard({ item: w.item, rate: w.rate ?? WILDCARD_DEFAULT_RATE });
    else openWizard();
  };

  const togglePref = (key: keyof NextPreferences) => {
    void setPreferences({ ...prefs, [key]: !prefs[key] });
  };

  return (
    <section className="dash-section" data-testid="next-moves">
      <div className="dash-move-head">
        <h3 className="t-label">NEXT MOVES{moves ? ` (${moves.length})` : ""}</h3>
        <AiSettings onSaved={bumpRankEpoch} />
      </div>

      {/* PR 3 preference chips — advisory filters that hide suggestions (never
          facts). Toggling persists and re-ranks. */}
      <div className="dash-prefs" data-testid="next-prefs">
        <span className="t-label">PREFERENCES</span>
        <button
          className={`chip dash-pref-chip ${prefs.noTrains ? "on" : ""}`}
          data-testid="pref-no-trains"
          aria-pressed={prefs.noTrains}
          onClick={() => togglePref("noTrains")}
          title="Hide rail/consist suggestions"
        >
          NO TRAINS
        </button>
        <button
          className={`chip dash-pref-chip ${prefs.ignorePower ? "on" : ""}`}
          data-testid="pref-ignore-power"
          aria-pressed={prefs.ignorePower}
          onClick={() => togglePref("ignorePower")}
          title="Deprioritize power — an overdraw is still shown, just demoted"
        >
          IGNORE POWER
        </button>
      </div>

      {/* Model headline: attributed prose, never confusable with solver
          evidence (AI chip + dim italic). */}
      {rank?.engine === "model" && rank.headline && (
        <div className="dash-ai-line" data-testid="ai-headline">
          <span className="dash-badge ai mono">AI · {rank.model}</span>
          <span className="dash-ai-text">{rank.headline}</span>
        </div>
      )}

      {(moves ?? []).slice(0, 3).map((o) => (
        <div className="dash-move" key={o.id} data-testid="next-move">
          <span className="dash-badge dash-move-kind">{MOVE_LABEL[o.kind]}</span>
          {o.item && (
            <ItemIcon item={o.item} displayName={gamedata.items[o.item]?.displayName} size={20} />
          )}
          <span className="dash-step-main">
            <span className="dash-step-label">{o.title}</span>
            <span className="dash-step-detail mono" data-testid="next-move-evidence">
              {o.evidence}
            </span>
            {rank?.engine === "model" && o.note && (
              <span className="dash-ai-note" data-testid="next-move-note">
                <span className="dash-badge ai mono">AI</span>
                <span className="dash-ai-text">{o.note}</span>
              </span>
            )}
          </span>
          <button className="chip warn dash-move-act" data-testid="next-move-action" onClick={() => actMove(o)}>
            {moveVerb(o)}
          </button>
        </div>
      ))}
      {moves && moves.length > 3 && (
        <div className="dash-line mono dim" data-testid="next-moves-more">
          +{moves.length - 3} more
        </div>
      )}
      {moves && moves.length === 0 && (
        <div className="dash-line mono dim" data-testid="next-moves-empty">
          No open moves — the solver sees nothing to improve.
        </div>
      )}

      {/* PR 3 WILDCARD IDEAS — the ONE labeled firewall exception. Dashed
          border + AI attribution + an honest "unverified" disclaimer; TRY IT
          hands the idea to the wizard, which alone makes it real. */}
      {wildcards.length > 0 && (
        <div className="dash-wildcards" data-testid="wildcards">
          <div className="dash-wildcards-head">
            <span className="dash-badge ai mono">AI · {rank?.model}</span>
            <span className="t-label">WILDCARD IDEAS</span>
          </div>
          <p className="dash-wildcards-disclaimer">
            Unverified — the model's brainstorm; solve one to make it real.
          </p>
          {wildcards.map((w, i) => (
            <div className="dash-wildcard" key={i} data-testid="wildcard">
              {w.item && (
                <ItemIcon item={w.item} displayName={gamedata.items[w.item]?.displayName} size={20} />
              )}
              <span className="dash-wildcard-main">
                <span className="dash-wildcard-title">{w.title}</span>
                {w.rationale && <span className="dash-wildcard-rationale">{w.rationale}</span>}
              </span>
              <button
                className="chip dash-wildcard-try"
                data-testid="wildcard-try"
                onClick={() => tryWildcard(w)}
              >
                TRY IT
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
