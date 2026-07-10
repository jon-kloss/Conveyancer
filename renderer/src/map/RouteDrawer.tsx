// Route inspector (belt routes, Phase 2). A3 grammar: every route is an
// entity with an inspector; planned routes are ◇ with italic projections.
// The full rail/truck/drone math block arrives in Phase 4.

import { useStore } from "../state/store";
import { fmtKm, fmtPercent, fmtPower, fmtRate } from "../lib/format";
import type { Route } from "../state/types";

export default function RouteDrawer({ route }: { route: Route }) {
  const plan = useStore((s) => s.plan);
  const derived = useStore((s) => s.derived);
  const gamedata = useStore((s) => s.gamedata);
  const setSelection = useStore((s) => s.setSelection);
  const dispatch = useStore((s) => s.dispatch);

  if (route.kind.kind === "power") return <PowerLineDrawer route={route} />;

  const dr = derived.routes[route.id];
  const srcPort = plan.ports[route.endpoints[0]];
  const dstPort = plan.ports[route.endpoints[1]];
  const srcFactory = srcPort ? plan.factories[srcPort.factory] : null;
  const dstFactory = dstPort ? plan.factories[dstPort.factory] : null;
  const tier = route.kind.kind === "belt" ? route.kind.tier : 0;
  const sat = dr?.saturation ?? 0;
  const level = sat >= 0.95 ? "crit" : sat >= 0.7 ? "warn" : "";

  return (
    <aside className="drawer summary-drawer" data-testid="route-drawer">
      <header className="drawer-header">
        <div className="icon-ph s40" />
        <div className="drawer-title-block">
          <div className="t-title">BELT ROUTE</div>
          <div className="mono drawer-sub">
            {dr ? fmtKm(dr.lengthM) : "—"} · MK.{tier} · {fmtRate(dr?.capacity ?? 0)}/min CAP
          </div>
        </div>
        <span className="chip planned">◇ PLANNED</span>
        <button className="drawer-close" onClick={() => setSelection(null)} aria-label="Close">
          ×
        </button>
      </header>

      <section className="drawer-section">
        <h3 className="t-label">ENDPOINTS</h3>
        <div className="drawer-row">
          <button
            className="chip"
            onClick={() => srcFactory && setSelection({ kind: "factory", id: srcFactory.id })}
          >
            ◇ {srcFactory?.name.toUpperCase() ?? "?"}
          </button>
          <span className="mono" style={{ color: "var(--ink-500)" }}>
            ⟶
          </span>
          <button
            className="chip"
            onClick={() => dstFactory && setSelection({ kind: "factory", id: dstFactory.id })}
          >
            ◇ {dstFactory?.name.toUpperCase() ?? "?"}
          </button>
        </div>
      </section>

      <section className="drawer-section">
        <h3 className="t-label">MANIFEST</h3>
        {route.manifest.map(([item, rate]) => (
          <div className="drawer-row" key={item}>
            <div className="icon-ph s20" />
            <span className="drawer-row-name">{gamedata.items[item]?.displayName ?? item}</span>
            <span className="t-data-12 projected">
              {fmtRate(rate)}
              <span className="unit">/min</span>
            </span>
          </div>
        ))}
      </section>

      <section className="drawer-section">
        <h3 className="t-label">LOAD</h3>
        <div className="drawer-row">
          <span className="drawer-row-name">Belt tier</span>
          <select
            className="mono"
            style={{ height: 24 }}
            value={tier}
            onChange={(e) => void dispatch([{ type: "set_route_tier", id: route.id, tier: Number(e.target.value) }])}
            data-testid="route-tier-select"
          >
            {[1, 2, 3, 4, 5, 6].map((t) => (
              <option key={t} value={t}>
                MK.{t}
              </option>
            ))}
          </select>
        </div>
        {dr && dr.climbUpM + dr.climbDownM > 0.5 && (
          <div className="drawer-row">
            <span className="drawer-row-name">Climb</span>
            <span className="t-data-12 projected">
              ↑{Math.round(dr.climbUpM)}
              <span className="unit">m</span> ↓{Math.round(dr.climbDownM)}
              <span className="unit">m</span>
            </span>
          </div>
        )}
        <div className="drawer-row">
          <span className="drawer-row-name">Throughput</span>
          <span className="minibar">
            <span className={level} style={{ width: `${Math.min(100, sat * 100)}%` }} />
          </span>
          <span className={`t-data-12 projected ${level ? level : ""}`}>
            {fmtRate(dr?.flow ?? 0)}/{fmtRate(dr?.capacity ?? 0)} · {fmtPercent(sat)}
          </span>
        </div>
        {dr && dr.supplied > dr.flow + 1e-6 && (
          <div className="insp-note">
            Upstream ships {fmtRate(dr.supplied)}/min; the consumer draws {fmtRate(dr.flow)} — slack stays on the
            belt.
          </div>
        )}
      </section>

      <footer className="drawer-footer">
        <button
          className="btn btn-ghost"
          onClick={() => {
            setSelection(null);
            void dispatch([{ type: "delete_route", id: route.id }]);
          }}
        >
          DELETE ROUTE
        </button>
      </footer>
    </aside>
  );
}

// Power line: no manifest, no tier — it joins two factories into one circuit.
// The inspector shows the resulting grid's margin (A2.1: power is a bus).
function PowerLineDrawer({ route }: { route: Route }) {
  const plan = useStore((s) => s.plan);
  const derived = useStore((s) => s.derived);
  const setSelection = useStore((s) => s.setSelection);
  const dispatch = useStore((s) => s.dispatch);

  const [aId, bId] = route.endpoints;
  const a = plan.factories[aId];
  const b = plan.factories[bId];
  const circuit = derived.circuits.find((c) => c.members.includes(aId));
  const gen = circuit?.generationMw ?? 0;
  const demand = circuit?.demandMw ?? 0;
  const headroom = gen > 0 ? (gen - demand) / gen : demand > 0 ? -1 : 1;
  const level = headroom < 0.05 ? "crit" : headroom < 0.2 ? "warn" : "";

  return (
    <aside className="drawer summary-drawer" data-testid="route-drawer">
      <header className="drawer-header">
        <div className="icon-ph s40" />
        <div className="drawer-title-block">
          <div className="t-title">POWER LINE</div>
          <div className="mono drawer-sub">{circuit?.name ?? "UNGRIDDED"}</div>
        </div>
        <span className="chip planned">◇ PLANNED</span>
        <button className="drawer-close" onClick={() => setSelection(null)} aria-label="Close">
          ×
        </button>
      </header>

      <section className="drawer-section">
        <h3 className="t-label">ENDPOINTS</h3>
        <div className="drawer-row">
          <button className="chip" onClick={() => a && setSelection({ kind: "factory", id: a.id })}>
            ◇ {a?.name.toUpperCase() ?? "?"}
          </button>
          <span className="mono" style={{ color: "var(--ink-500)" }}>
            ⚡
          </span>
          <button className="chip" onClick={() => b && setSelection({ kind: "factory", id: b.id })}>
            ◇ {b?.name.toUpperCase() ?? "?"}
          </button>
        </div>
      </section>

      <section className="drawer-section">
        <h3 className="t-label">CIRCUIT</h3>
        <div className="drawer-row">
          <span className="drawer-row-name">Generation</span>
          <span className="t-data-12 projected">{fmtPower(gen)}</span>
        </div>
        <div className="drawer-row">
          <span className="drawer-row-name">Demand</span>
          <span className="t-data-12 projected">{fmtPower(demand)}</span>
        </div>
        <div className="drawer-row">
          <span className="drawer-row-name">Margin</span>
          <span className="minibar">
            <span className={level} style={{ width: `${Math.min(100, gen > 0 ? (demand / gen) * 100 : 100)}%` }} />
          </span>
          <span className={`t-data-12 projected ${level}`}>
            {gen > 0 ? fmtPercent(headroom) : "—"} headroom
          </span>
        </div>
        {circuit && circuit.members.length > 2 && (
          <div className="insp-note">{circuit.members.length} factories share this grid.</div>
        )}
      </section>

      <footer className="drawer-footer">
        <button
          className="btn btn-ghost"
          onClick={() =>
            void dispatch([{ type: "add_priority_switch", route: route.id, priority: 4 }], { select: true })
          }
          data-testid="btn-add-switch"
        >
          + PRIORITY SWITCH
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            setSelection(null);
            void dispatch([{ type: "delete_route", id: route.id }]);
          }}
        >
          DELETE LINE
        </button>
      </footer>
    </aside>
  );
}
