// Collapsible legend (mock 2a, bottom-left, 230px): status glyphs, node states.

import { useState } from "react";

// Node fill = extracted resource (map data, not a UI signal). Compact key so a
// player can decode the map's colours at a glance.
const RESOURCE_KEY: [string, string][] = [
  ["iron", "Iron"],
  ["copper", "Copper"],
  ["limestone", "Limestone"],
  ["coal", "Coal"],
  ["caterium", "Caterium"],
  ["quartz", "Quartz"],
  ["sulfur", "Sulfur"],
  ["oil", "Oil"],
  ["bauxite", "Bauxite"],
  ["uranium", "Uranium"],
  ["sam", "SAM"],
];

export default function Legend() {
  const [open, setOpen] = useState(true);
  return (
    <div className="map-legend">
      <button className="t-label legend-toggle" onClick={() => setOpen(!open)}>
        LEGEND {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="legend-body">
          <div className="legend-row">
            <span className="status-planned">◇</span> Planned
            <span className="status-under_construction">◈</span> U/C
            <span className="status-built">◆</span> Built
          </div>
          <div className="legend-row">
            <span className="legend-node pure" /> Pure
            <span className="legend-node normal" /> Normal
            <span className="legend-node impure" /> Impure
          </div>
          <div className="legend-row">
            <span className="legend-node claimed" /> Claimed
            <span className="legend-node conflict" /> Conflict
          </div>
          <div className="legend-resources">
            {RESOURCE_KEY.map(([key, label]) => (
              <span className="legend-res" key={key}>
                <span className="legend-res-dot" style={{ background: `var(--resource-${key})` }} />
                {label}
              </span>
            ))}
          </div>
          <div className="legend-row">
            <span className="legend-tether" /> Claim tether (node → factory)
          </div>
          <div className="legend-row">
            <span className="legend-tether replaces" /> Replaces tether (◆ → ◇)
          </div>
          {/* efficiency grammar: full is optimal — red only when the link
              provably caps demanded throughput, never from % alone */}
          <div className="legend-row" title="Utilization: ≤50% = under-used (over-built or starved upstream); >50% incl. a FULL belt meeting demand = good">
            <span className="legend-load under" /> ≤50 under-used
            <span className="legend-load" /> &gt;50 good
          </div>
          <div className="legend-row" title="Bottleneck: the route runs at full capacity while downstream demand goes unmet — this link caps throughput">
            <span className="legend-load bottleneck" /> bottleneck — caps demand
          </div>
          <div className="legend-row mono">
            <span>❯ flow</span> <span>╫ rail</span> <span>▪ truck</span> <span>┄ drone</span>
          </div>
        </div>
      )}
    </div>
  );
}
