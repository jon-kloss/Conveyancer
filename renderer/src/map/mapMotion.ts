// MANIFOLD map-motion helpers (handoff §5: 7a accept sweep, 7b placement
// drop, 7c import cluster converge, 7e route draw, plus the map half of 7h).
// Pure math — the MapView detector and CanvasLayer overlays lean on it.

/** Transient canvas choreography, passed to MapCanvasLayer via setData.
 *  Timestamps are Date.now() ms. The layer animates while now < until (and
 *  the reduced-motion / visibility gates allow), then restores the static
 *  render — entities are only visually deferred while the loop truly runs. */
export interface MapMotion {
  until: number;
  /** claim tethers born this mutation: `${node.x},${node.y}` → bornAt
   *  (7a: tethers draw in over 400ms via dash-clip) */
  tetherBorn: Record<string, number>;
  /** route ids born this mutation → bornAt (7e: A→B draw over 200ms) */
  routeBorn: Record<string, number>;
  /** 7c: per imported cluster, iron-tint dots converge on the ◆ centroid
   *  (~1.6s from startAt), then the DOM pin pops via its own CSS delay */
  clusters: { x: number; y: number; dots: { dx: number; dy: number }[]; startAt: number }[];
}

export const TETHER_DRAW_MS = 400;
export const ROUTE_DRAW_MS = 200;
export const CONVERGE_MS = 1600;
/** 7c plays clusters sequentially; converge + pin pop per cluster. */
export const CLUSTER_STEP_MS = 1900;
/** Big imports would otherwise animate for minutes — play the first N
 *  clusters (left → right) and let the rest simply appear. */
export const CLUSTER_CAP = 8;

export const tetherKey = (node: { x: number; y: number }): string => `${node.x},${node.y}`;

/** Deterministic FNV-1a hash — seeds the 7c scatter so a cluster's dots are
 *  stable across renders (decorative positions, real machine COUNT). */
export function hashSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** `count` seeded offsets ring-scattered around a centroid (radius 0.45–1×
 *  `radius`): the "parsed machines" of a cluster before they converge. The
 *  save's true machine coordinates never reach the client — positions are
 *  decorative; the count is the factory's real group count. */
export function scatter(id: string, count: number, radius: number): { dx: number; dy: number }[] {
  let s = hashSeed(id) || 1;
  const rand = () => {
    // xorshift32 — cheap, deterministic, good enough for scatter
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 + rand() * 1.1;
    const r = radius * (0.45 + 0.55 * rand());
    return { dx: Math.cos(a) * r, dy: Math.sin(a) * r };
  });
}

/** Truncate a polyline to the leading `t` (0..1) of its total length — the
 *  7e route draw-in clips the planned path with this. */
export function partialPath(pts: ReadonlyArray<{ x: number; y: number }>, t: number): { x: number; y: number }[] {
  if (t >= 1 || pts.length < 2) return [...pts];
  if (t <= 0) return [];
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const L = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    segs.push(L);
    total += L;
  }
  let remain = total * t;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const L = segs[i - 1];
    if (remain >= L) {
      out.push(pts[i]);
      remain -= L;
      if (remain <= 0) break; // landed exactly on this vertex — done
    } else {
      const f = L > 0 ? remain / L : 0;
      out.push({
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f,
      });
      break;
    }
  }
  return out;
}

/** cubic ease-out (matches the pack's cubic-bezier(.2,0,0,1) feel). */
export const easeOut = (t: number): number => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
