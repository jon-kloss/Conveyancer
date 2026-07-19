#!/usr/bin/env node
// Rasterize the MANIFOLD app-icon SVG (renderer/src/assets/brand/
// app-icon-96.svg) into the Tauri desktop icons: crates/app/icons/icon.png
// (512px) and icon.ico (16/32/48/256, PNG-compressed entries — Vista+).
// Uses the repo's pinned playwright chromium; no native image tooling needed.
// Run from the repo root: node scripts/gen-app-icons.mjs
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

const require = createRequire(new URL("../renderer/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const svg = readFileSync("renderer/src/assets/brand/app-icon-96.svg", "utf8");
// Handoff §1: "Prefer favicon.svg geometry below 24px" — the heavy-cut mark
// (sw 6, larger diamonds) so the icon reads at 16px; the standard app-icon
// mark's 3px runs render at ~0.45px in a 16px tile and vanish. Compose the
// small-size tile as the app-icon frame + the favicon mark at 62%.
const favicon = readFileSync("renderer/src/assets/brand/favicon.svg", "utf8");
const faviconPaths = favicon.replace(/^.*?<path/s, "<path").replace(/<\/svg>.*$/s, "");
const smallSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">` +
  `<rect width="96" height="96" rx="20" fill="#15181B" stroke="#333A41"></rect>` +
  `<g transform="translate(18,18) scale(0.9375)">${faviconPaths}</g></svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();

async function png(size, source = svg) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>*{margin:0}body{background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
  );
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

const sizes = [16, 32, 48, 256];
const pngs = {};
for (const s of sizes) pngs[s] = await png(s, s < 24 ? smallSvg : svg);
writeFileSync("crates/app/icons/icon.png", await png(512));

// ICO container with PNG-compressed images (supported since Vista).
const dir = Buffer.alloc(6 + 16 * sizes.length);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type: icon
dir.writeUInt16LE(sizes.length, 4);
let offset = dir.length;
const blobs = [];
sizes.forEach((s, i) => {
  const b = pngs[s];
  const e = 6 + i * 16;
  dir.writeUInt8(s === 256 ? 0 : s, e); // 0 = 256
  dir.writeUInt8(s === 256 ? 0 : s, e + 1);
  dir.writeUInt8(0, e + 2); // palette
  dir.writeUInt8(0, e + 3); // reserved
  dir.writeUInt16LE(1, e + 4); // planes
  dir.writeUInt16LE(32, e + 6); // bpp
  dir.writeUInt32LE(b.length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += b.length;
  blobs.push(b);
});
writeFileSync("crates/app/icons/icon.ico", Buffer.concat([dir, ...blobs]));
await browser.close();
console.log("wrote crates/app/icons/icon.png + icon.ico");
