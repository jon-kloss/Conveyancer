// As-built logistics geometry (competitor-parity phase 1): the save stores
// every conveyor, pipeline, and rail as a spline actor (world transform +
// local control points with Hermite tangents) and every power line as a pair
// of world-space wire endpoints. This module reduces that to flat 2-D map
// polylines in world METERS — the same frame factory pins live in (save cm ÷
// 100, signs kept).
//
// This is deliberately NOT part of ImportSnapshot: the Rust core never solves
// on belt curves, so the geometry stays a renderer-side ambient layer (like
// terrain and world nodes), cached per save (geometryStore.ts) and refreshed
// by every import. Plan entities remain the only canonical state.

import { classOf, type RawObject } from "./parseSnapshot";

export type BuiltLineKind = "belt" | "pipe" | "rail" | "power";

export interface BuiltPolyline {
  kind: BuiltLineKind;
  /** Flat [x0, y0, x1, y1, …] in world meters — compact for IDB + iteration. */
  pts: number[];
}

export interface BuiltLogistics {
  version: 1;
  saveName: string;
  counts: Record<BuiltLineKind, number>;
  lines: BuiltPolyline[];
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}
interface SplinePointRaw {
  properties?: {
    Location?: { value?: Vec3 };
    ArriveTangent?: { value?: Vec3 };
    LeaveTangent?: { value?: Vec3 };
  };
}

/** Spline-actor class → kind. Lifts are vertical (no 2-D extent) and chain
 *  actors are the engine's replication batches over the same belts — both
 *  deliberately skipped. */
function kindOf(cls: string): BuiltLineKind | null {
  if (cls.startsWith("Build_ConveyorBeltMk")) return "belt";
  if (cls === "Build_Pipeline_C" || cls === "Build_PipelineMK2_C") return "pipe";
  if (cls === "Build_RailroadTrack_C" || cls === "Build_RailroadTrackIntegrated_C") return "rail";
  return null;
}

/** Quaternion-rotate a local point (most spline actors ship identity, but a
 *  rotated actor's points would land sideways without this). */
function rotate(q: { x: number; y: number; z: number; w: number }, v: Vec3): Vec3 {
  const { x, y, z, w } = q;
  // t = 2q × v; v' = v + w·t + q × t
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
}

/** Cubic Hermite between p0→p1 with UE-scaled tangents, sampled at t. */
function hermite(p0: Vec3, m0: Vec3, p1: Vec3, m1: Vec3, t: number): { x: number; y: number } {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return {
    x: h00 * p0.x + h10 * m0.x + h01 * p1.x + h11 * m1.x,
    y: h00 * p0.y + h10 * m0.y + h01 * p1.y + h11 * m1.y,
  };
}

/** Subdivisions per spline segment: enough that belt curves read as curves at
 *  factory zoom; straight runs collapse to collinear points the renderer
 *  draws cheaply anyway. */
const SEGMENT_STEPS = 4;

function splineToPts(obj: RawObject): number[] | null {
  const sd = (obj.properties?.mSplineData as { values?: SplinePointRaw[] } | undefined)?.values;
  const tr = obj.transform?.translation;
  if (!sd || sd.length < 2 || !tr) return null;
  const rot = (obj.transform as { rotation?: { x: number; y: number; z: number; w: number } })
    ?.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
  const world = (local: Vec3): Vec3 => {
    const r = rotate(rot, local);
    return { x: r.x + tr.x, y: r.y + tr.y, z: 0 };
  };
  const pts: number[] = [];
  const push = (p: { x: number; y: number }) => {
    pts.push(p.x / 100, p.y / 100); // cm → m
  };
  for (let i = 0; i < sd.length - 1; i++) {
    const a = sd[i].properties;
    const b = sd[i + 1].properties;
    const p0 = a?.Location?.value;
    const p1 = b?.Location?.value;
    if (!p0 || !p1) return null;
    const m0 = a?.LeaveTangent?.value;
    const m1 = b?.ArriveTangent?.value;
    if (i === 0) push(world(p0));
    if (m0 && m1) {
      for (let k = 1; k < SEGMENT_STEPS; k++) {
        const t = k / SEGMENT_STEPS;
        const local = hermite(p0, m0, p1, m1, t);
        push(world({ x: local.x, y: local.y, z: 0 }));
      }
    }
    push(world(p1));
  }
  return pts;
}

interface WireInstanceRaw {
  properties?: { Locations?: { value?: Vec3 }[] };
}

/** Power lines carry 1-2 wire instances, each a pair of WORLD-space endpoint
 *  locations (already absolute — no transform math). */
function wiresToPts(obj: RawObject): number[][] {
  const wires = (obj.properties?.mWireInstances as { values?: WireInstanceRaw[] } | undefined)
    ?.values;
  const out: number[][] = [];
  for (const w of wires ?? []) {
    const locs = (w.properties?.Locations ?? [])
      .map((l) => l.value)
      .filter((v): v is Vec3 => !!v);
    if (locs.length >= 2) {
      out.push(locs.flatMap((v) => [v.x / 100, v.y / 100]));
    }
  }
  return out;
}

export function extractLogistics(
  saveName: string,
  levels: Record<string, { objects?: RawObject[] }>,
): BuiltLogistics {
  const counts: Record<BuiltLineKind, number> = { belt: 0, pipe: 0, rail: 0, power: 0 };
  const lines: BuiltPolyline[] = [];
  for (const level of Object.values(levels ?? {})) {
    for (const obj of level.objects ?? []) {
      const cls = classOf(obj.typePath ?? "");
      const kind = kindOf(cls);
      if (kind) {
        const pts = splineToPts(obj);
        if (pts && pts.length >= 4) {
          lines.push({ kind, pts });
          counts[kind] += 1;
        }
      } else if (cls === "Build_PowerLine_C") {
        for (const pts of wiresToPts(obj)) {
          lines.push({ kind: "power", pts });
          counts.power += 1;
        }
      }
    }
  }
  return { version: 1, saveName, counts, lines };
}
