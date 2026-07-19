#!/usr/bin/env node
// Convert the MANIFOLD low-poly resource SVGs (brand handoff §3) into the
// shared polygon module renderer/src/lib/resourcePolys.ts. Each icon is ≤6
// primitives on a 24x24 grid; fills/strokes are emitted as TOKEN names (the
// "no hex ships outside the token system" law) resolved by consumers:
// CanvasLayer via css("--<token>"), DOM components via var(--<token>).
//   node scripts/gen-resource-polys.mjs <svg-dir>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: gen-resource-polys.mjs <svg-dir>");

// hex -> token, from crates/app/src/tokens.rs (base + MANIFOLD facet shades)
const toks = readFileSync("crates/app/src/tokens.rs", "utf8");
const hexToToken = {};
for (const m of toks.matchAll(/"(resource-[a-z-]+)"\s*=>\s*"(#[0-9A-Fa-f]{6})"/g)) {
  // first mapping wins so facet shades don't get shadowed by later dupes
  if (!(m[2].toUpperCase() in hexToToken)) hexToToken[m[2].toUpperCase()] = m[1];
}


const r2 = (v) => Math.round(v * 100) / 100;

/** Flatten one SVG path (M/L/C/A/Z on absolute coords — the vocabulary the
 *  handoff icons use) into polygon points, sampling curves so the ≤6-primitive
 *  budget stays a small point list. Throws on any command it can't handle —
 *  a silent drop ships a blank icon (the oil-bead regression). */
function flattenPath(d, file) {
  const toks = [...d.matchAll(/([MLCAZmlcaz])|(-?[\d.]+)/g)].map((m) => m[1] ?? Number(m[2]));
  const pts = [];
  let i = 0;
  const cur = () => pts[pts.length - 1];
  while (i < toks.length) {
    const cmd = toks[i++];
    if (typeof cmd !== "string") throw new Error(`${file}: stray number in path`);
    if (cmd === "Z" || cmd === "z") break;
    if (cmd === "M" || cmd === "L") {
      while (typeof toks[i] === "number") pts.push([toks[i++], toks[i++]]);
    } else if (cmd === "C") {
      while (typeof toks[i] === "number") {
        const [x1, y1, x2, y2, x, y] = [toks[i++], toks[i++], toks[i++], toks[i++], toks[i++], toks[i++]];
        const [x0, y0] = cur();
        for (let t = 1; t <= 8; t++) {
          const u = t / 8;
          const v = 1 - u;
          pts.push([
            r2(v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x),
            r2(v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y),
          ]);
        }
      }
    } else if (cmd === "A") {
      while (typeof toks[i] === "number") {
        const [rx, ry, rot, largeArc, sweep, x, y] = [
          toks[i++], toks[i++], toks[i++], toks[i++], toks[i++], toks[i++], toks[i++],
        ];
        // Endpoint → center parameterization (SVG spec B.2.4), then sample.
        const [x0, y0] = cur();
        const phi = (rot * Math.PI) / 180;
        const dx = (x0 - x) / 2;
        const dy = (y0 - y) / 2;
        const x1p = Math.cos(phi) * dx + Math.sin(phi) * dy;
        const y1p = -Math.sin(phi) * dx + Math.cos(phi) * dy;
        let rxs = rx * rx;
        let rys = ry * ry;
        const lam = (x1p * x1p) / rxs + (y1p * y1p) / rys;
        let rxa = rx;
        let rya = ry;
        if (lam > 1) {
          rxa = Math.sqrt(lam) * rx;
          rya = Math.sqrt(lam) * ry;
          rxs = rxa * rxa;
          rys = rya * rya;
        }
        const sign = largeArc !== sweep ? 1 : -1;
        const num = rxs * rys - rxs * y1p * y1p - rys * x1p * x1p;
        const den = rxs * y1p * y1p + rys * x1p * x1p;
        const co = sign * Math.sqrt(Math.max(0, num / den));
        const cxp = (co * rxa * y1p) / rya;
        const cyp = (-co * rya * x1p) / rxa;
        const cx = Math.cos(phi) * cxp - Math.sin(phi) * cyp + (x0 + x) / 2;
        const cy = Math.sin(phi) * cxp + Math.cos(phi) * cyp + (y0 + y) / 2;
        const ang = (ux, uy) => Math.atan2(uy, ux);
        const t1 = ang((x1p - cxp) / rxa, (y1p - cyp) / rya);
        let dt = ang((-x1p - cxp) / rxa, (-y1p - cyp) / rya) - t1;
        if (!sweep && dt > 0) dt -= 2 * Math.PI;
        if (sweep && dt < 0) dt += 2 * Math.PI;
        for (let t = 1; t <= 10; t++) {
          const a = t1 + (dt * t) / 10;
          const ex = rxa * Math.cos(a);
          const ey = rya * Math.sin(a);
          pts.push([
            r2(Math.cos(phi) * ex - Math.sin(phi) * ey + cx),
            r2(Math.sin(phi) * ex + Math.cos(phi) * ey + cy),
          ]);
        }
      }
    } else {
      throw new Error(`${file}: unsupported path command ${cmd}`);
    }
  }
  return pts;
}

const out = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith(".svg")).sort()) {
  const name = f.replace(".svg", "");
  const svg = readFileSync(join(dir, f), "utf8");
  const prims = [];
  for (const p of svg.matchAll(/<path d="([^"]+)" fill="(#[0-9A-Fa-f]{6})"><\/path>/g)) {
    const pts = flattenPath(p[1], f);
    const token = hexToToken[p[2].toUpperCase()];
    if (!token) throw new Error(`${f}: no token for fill ${p[2]}`);
    prims.push({ kind: "poly", token, pts });
  }
  // <ellipse> (oil's specular highlight): flatten to a polygon so both
  // consumers stay on the poly/line/circle primitive vocabulary.
  for (const e of svg.matchAll(
    /<ellipse cx="([\d.-]+)" cy="([\d.-]+)" rx="([\d.]+)" ry="([\d.]+)"(?: transform="rotate\((-?[\d.]+) ([\d.-]+) ([\d.-]+)\)")? fill="(#[0-9A-Fa-f]{6})"><\/ellipse>/g,
  )) {
    const [cx, cy, rx, ry] = [Number(e[1]), Number(e[2]), Number(e[3]), Number(e[4])];
    const rot = ((Number(e[5] ?? 0) || 0) * Math.PI) / 180;
    const token = hexToToken[e[8].toUpperCase()];
    if (!token) throw new Error(`${f}: no token for ellipse ${e[8]}`);
    const pts = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const x = rx * Math.cos(a);
      const y = ry * Math.sin(a);
      pts.push([
        r2(cx + x * Math.cos(rot) - y * Math.sin(rot)),
        r2(cy + x * Math.sin(rot) + y * Math.cos(rot)),
      ]);
    }
    prims.push({ kind: "poly", token, pts });
  }
  for (const l of svg.matchAll(
    /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" stroke="(#[0-9A-Fa-f]{6})" stroke-width="([\d.]+)"><\/line>/g,
  )) {
    const token = hexToToken[l[5].toUpperCase()];
    if (!token) throw new Error(`${f}: no token for stroke ${l[5]}`);
    prims.push({
      kind: "line",
      token,
      pts: [
        [Number(l[1]), Number(l[2])],
        [Number(l[3]), Number(l[4])],
      ],
      w: Number(l[6]),
    });
  }
  // circles (oil bead / uranium glow may use them)
  for (const c of svg.matchAll(
    /<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="(#[0-9A-Fa-f]{6})"><\/circle>/g,
  )) {
    const token = hexToToken[c[4].toUpperCase()];
    if (!token) throw new Error(`${f}: no token for circle ${c[4]}`);
    prims.push({ kind: "circle", token, pts: [[Number(c[1]), Number(c[2])]], r: Number(c[3]) });
  }
  // The guard counts EVERY drawable element the SVG contains — a primitive
  // kind this script can't parse must fail loudly, never ship a blank icon
  // (the oil ellipse originally slipped through a path/line/circle-only count).
  const total = [...svg.matchAll(/<(path|line|circle|ellipse|rect|polygon) /g)].length;
  if (prims.length !== total) throw new Error(`${f}: parsed ${prims.length} of ${total} primitives`);
  out[name] = prims;
}

const banner = `// GENERATED by scripts/gen-resource-polys.mjs from the MANIFOLD brand handoff
// resource SVGs — do not hand-edit; re-run the script against the asset dir.
// Colors are TOKEN names (no hex outside the token system): canvas resolves
// them via css("--<token>"), DOM via var(--<token>). 24x24 design grid.

export type ResourcePrim =
  | { kind: "poly"; token: string; pts: [number, number][] }
  | { kind: "line"; token: string; pts: [number, number][]; w: number }
  | { kind: "circle"; token: string; pts: [number, number][]; r: number };

export const RESOURCE_POLYS: Record<string, ResourcePrim[]> = `;
writeFileSync(
  "renderer/src/lib/resourcePolys.ts",
  banner + JSON.stringify(out, null, 2).replace(/"kind"/g, "kind").replace(/"token"/g, "token").replace(/"pts"/g, "pts").replace(/"w"/g, "w").replace(/"r"/g, "r") + ";\n",
);
console.log(`wrote ${Object.keys(out).length} icons`);
