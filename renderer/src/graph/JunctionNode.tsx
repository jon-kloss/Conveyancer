// Belt junction card (splitter/merger/storage): compact square-ish card —
// square = infrastructure grammar (A2.3). Shows the buildable's real name from
// the game-data catalog, its port budget, and the item it carries.

import { Handle, Position } from "@xyflow/react";
import { useStore } from "../state/store";
import { itemLabel } from "../lib/format";
import { JUNCTION_CAPS, type Junction } from "../state/types";

export interface JunctionNodeData {
  junction: Junction;
  factoryId: string;
  showFloorBadge?: boolean;
  [key: string]: unknown;
}

const KIND_GLYPH: Record<Junction["kind"], string> = {
  splitter: "⑂",
  smart_splitter: "⑂",
  programmable_splitter: "⑂",
  merger: "⑃",
  storage: "▤",
};

export default function JunctionNode({ data, selected }: { data: JunctionNodeData; selected?: boolean }) {
  const { junction } = data;
  const gamedata = useStore((s) => s.gamedata);
  const plan = useStore((s) => s.plan);

  const name = gamedata.buildables?.[junction.buildable]?.displayName ?? junction.kind.replace("_", " ");
  const [inCap, outCap] = JUNCTION_CAPS[junction.kind];
  const edges = Object.values(plan.edges).filter(
    (e) =>
      (e.from.kind === "junction" && e.from.id === junction.id) ||
      (e.to.kind === "junction" && e.to.id === junction.id),
  );
  const inUsed = edges.filter((e) => e.to.kind === "junction" && e.to.id === junction.id).length;
  const outUsed = edges.filter((e) => e.from.kind === "junction" && e.from.id === junction.id).length;
  const item = edges[0] ? itemLabel(gamedata.items, edges[0].item) : null;

  return (
    // A junction just routes belts — it produces nothing, so it reads as a small
    // square (infrastructure grammar), NOT a machine card. Name / port budget /
    // item live in the hover tooltip.
    <div
      className={`junction-card frame-${junction.status} ${selected ? "selected" : ""}`}
      data-testid={`junction-${junction.kind}-${junction.id}`}
      title={`${name} — in ${inUsed}/${inCap} · out ${outUsed}/${outCap}${item ? ` · ${item.toUpperCase()}` : ""}`}
    >
      <Handle type="target" position={Position.Left} className="belt-handle" />
      <span className="junction-glyph" aria-hidden>
        {KIND_GLYPH[junction.kind]}
      </span>
      {data.showFloorBadge && <span className="junction-floor mono">F{junction.floor}</span>}
      <Handle type="source" position={Position.Right} className="belt-handle" />
    </div>
  );
}
