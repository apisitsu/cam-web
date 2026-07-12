#!/usr/bin/env node
/**
 * run-cam-web driver — exercises the cam-web G-code engine end-to-end and
 * renders the resulting toolpath as an SVG on disk.
 *
 * This is the primary agent-facing "run" surface for cam-web in a headless /
 * render-less environment: the R3F viewport needs WebGL (no browser render is
 * available here), so instead of a screenshot we drive the *pure-JS engine*
 * that feeds that viewport and project its output to 2D SVG we can look at.
 *
 * Usage:
 *   node .claude/skills/run-cam-web/driver.mjs                 # built-in sample
 *   node .claude/skills/run-cam-web/driver.mjs path/to/prog.nc # a real program
 *   node .claude/skills/run-cam-web/driver.mjs --out foo.svg   # choose output
 *
 * Exit code 0 on success, non-zero if the engine produced no motion.
 * Paths are resolved from the repo root regardless of cwd.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..'); // .claude/skills/run-cam-web -> repo root
const { parseGcode } = await import(
  new URL('../../../src/engine/gcode/index.js', import.meta.url)
);

// --- args -----------------------------------------------------------------
const args = process.argv.slice(2);
let outPath = resolve(REPO, 'image_tool', 'driver-backplot.svg');
let srcPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') {
    const val = args[++i];
    if (!val) {
      console.error('FAIL: --out requires a path argument');
      process.exit(2);
    }
    outPath = resolve(REPO, val);
  } else srcPath = resolve(REPO, args[i]);
}

// A small self-contained program: rapid in, a pocket with a G2 arc, rapid out.
const SAMPLE = `
( run-cam-web driver sample — mm, absolute )
G21 G90
G0 X0 Y0 Z5
G0 X10 Y10
G1 Z-2 F100
G1 X40 Y10 F300
G2 X50 Y20 I0 J10
G1 X50 Y40
G1 X10 Y40
G1 X10 Y10
G0 Z5
G0 X0 Y0
M30
`;

const text = srcPath ? readFileSync(srcPath, 'utf8') : SAMPLE;
const label = srcPath ? srcPath : '(built-in sample)';

// --- drive the real engine ------------------------------------------------
const { rapids, feeds, bounds, stats } = parseGcode(text);
const rapidSegs = rapids.length / 6;
const feedSegs = feeds.length / 6;

console.log(`source     : ${label}`);
console.log(`rapid segs : ${rapidSegs}`);
console.log(`feed segs  : ${feedSegs}`);
console.log(
  `bounds     : X[${fmt(bounds.min[0])},${fmt(bounds.max[0])}] ` +
    `Y[${fmt(bounds.min[1])},${fmt(bounds.max[1])}] ` +
    `Z[${fmt(bounds.min[2])},${fmt(bounds.max[2])}]`
);
if (stats) console.log(`stats      : ${JSON.stringify(stats)}`);

if (rapidSegs + feedSegs === 0) {
  console.error('FAIL: engine produced no motion segments');
  process.exit(1);
}

// --- render a 2D SVG backplot (XY top view) -------------------------------
const svg = renderSvg({ rapids, feeds, bounds });
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, svg);
console.log(`svg        : ${outPath}`);
console.log('OK');

// --- helpers --------------------------------------------------------------
function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(1) : String(n);
}

function renderSvg({ rapids, feeds, bounds }) {
  const W = 640, H = 480, pad = 30;
  const [minX, minY] = bounds.min;
  const [maxX, maxY] = bounds.max;
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const s = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  // world -> svg (flip Y so +Y is up)
  const px = (x) => pad + (x - minX) * s;
  const py = (y) => H - pad - (y - minY) * s;

  const line = (buf, i) =>
    `M${px(buf[i]).toFixed(1)},${py(buf[i + 1]).toFixed(1)} ` +
    `L${px(buf[i + 3]).toFixed(1)},${py(buf[i + 4]).toFixed(1)}`;

  const paths = (buf, stroke, dash) => {
    let d = '';
    for (let i = 0; i < buf.length; i += 6) d += line(buf, i) + ' ';
    return d
      ? `<path d="${d.trim()}" fill="none" stroke="${stroke}" stroke-width="1.5"` +
          (dash ? ` stroke-dasharray="4 3"` : '') + `/>`
      : '';
  };

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#0f172a"/>
  <text x="${pad}" y="18" fill="#94a3b8" font-family="monospace" font-size="12">cam-web toolpath (XY top view) — feeds cyan, rapids dashed grey</text>
  ${paths(rapids, '#64748b', true)}
  ${paths(feeds, '#38bdf8', false)}
</svg>`;
}
