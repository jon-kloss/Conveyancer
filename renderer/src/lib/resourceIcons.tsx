// MANIFOLD low-poly resource icons (brand handoff §3): faceted material
// chunks, ≤6 primitives each, colored ONLY through resource-* tokens. One
// polygon source (resourcePolys.ts) feeds both this DOM component and the
// map canvas (CanvasLayer.drawResourceIcon) so the two can never drift.

import { RESOURCE_POLYS, type ResourcePrim } from "./resourcePolys";

/** Extracted-resource item class → icon name. The same keying the map's
 *  resource tint uses; anything outside this set has no material icon. */
export const RESOURCE_ICON_BY_ITEM: Record<string, string> = {
  Desc_OreIron_C: "iron",
  Desc_OreCopper_C: "copper",
  Desc_Stone_C: "limestone",
  Desc_Coal_C: "coal",
  Desc_OreGold_C: "caterium",
  Desc_RawQuartz_C: "quartz",
  Desc_Sulfur_C: "sulfur",
  Desc_LiquidOil_C: "oil",
  Desc_OreBauxite_C: "bauxite",
  Desc_OreUranium_C: "uranium",
  Desc_SAM_C: "sam",
};

const prim = (p: ResourcePrim, i: number) => {
  if (p.kind === "line") {
    return (
      <line
        key={i}
        x1={p.pts[0][0]}
        y1={p.pts[0][1]}
        x2={p.pts[1][0]}
        y2={p.pts[1][1]}
        stroke={`var(--${p.token})`}
        strokeWidth={p.w}
      />
    );
  }
  if (p.kind === "circle") {
    return <circle key={i} cx={p.pts[0][0]} cy={p.pts[0][1]} r={p.r} fill={`var(--${p.token})`} />;
  }
  return <polygon key={i} points={p.pts.map(([x, y]) => `${x},${y}`).join(" ")} fill={`var(--${p.token})`} />;
};

/** Faceted material chunk on a transparent background. `icon` is a
 *  RESOURCE_POLYS key (use RESOURCE_ICON_BY_ITEM to map an item class);
 *  unknown names render the generic chunk. */
export default function ResourceIcon({ icon, size = 20 }: { icon: string; size?: number }) {
  const prims = RESOURCE_POLYS[icon] ?? RESOURCE_POLYS.generic;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      {prims.map(prim)}
    </svg>
  );
}
