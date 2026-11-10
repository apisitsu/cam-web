/**
 * Cut verification — does the program cut the part it was planned for?
 *
 * Runs the posted NC text through the same interpreter and material-removal models
 * the viewport uses, then compares what is left with the part:
 *
 * - **gouge**: part material the program removed. Must be zero.
 * - **excess**: material left on that the part does not have.
 *
 * Milling compares a height field, so it sees what a tool from above can reach;
 * turning compares outer and bore radius per slice. Cells beside a step in the part
 * are skipped, because which side of a wall a cell centre falls on says nothing
 * about the cut. A wall is therefore checked to about one cell sideways.
 *
 * Pure functions. No React, no store, no DOM.
 */
import { interpret } from '../gcode/interpreter.js';
import { eachTriangle } from '../mesh/slice.js';
import { createStock, simulate } from '../sim/dexel.js';
import { createTurningStock, carveTurning, detectFaceZ } from '../sim/turning.js';

const DEFAULT_TOLERANCE = 0.05;
const MILL_MIN_CELL = 0.2;
const MILL_MAX_CELLS = 400;
const TURN_CELL = 0.1;
/** Bar reaching past the last cut, so the chuck end of the model is never cut. */
const TURN_CHUCK = 5;
/** A height step over this many cells is a wall rather than a slope. */
const WALL_CELLS = 2;
const DRILL_POINT = 118;

function tally() {
  return { max: 0, cells: 0, volume: 0, at: null };
}

function record(t, amount, cellVolume, at) {
  t.cells += 1;
  t.volume += amount * cellVolume;
  if (amount > t.max) {
    t.max = amount;
    t.at = at;
  }
}

function finish(gouge, excess, cellSize, tolerance) {
  const round = (t) => ({
    ...t, max: Number(t.max.toFixed(3)), volume: Number(t.volume.toFixed(2)),
  });
  return {
    ok: gouge.cells === 0, cellSize, tolerance, gouge: round(gouge), excess: round(excess),
  };
}

/** The highest point of the mesh over each cell centre; -Infinity where there is none. */
function partHeights(mesh, stock) {
  const { nx, ny, xMin, yMin, cellSize: cs } = stock;
  const heights = new Float32Array(nx * ny).fill(-Infinity);
  eachTriangle(mesh, (a, b, c, p) => {
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) return;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - xMin) / cs - 0.5));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - xMin) / cs - 0.5));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - yMin) / cs - 0.5));
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by, cy) - yMin) / cs - 0.5));
    for (let j = j0; j <= j1; j++) {
      const y = yMin + (j + 0.5) * cs;
      for (let i = i0; i <= i1; i++) {
        const x = xMin + (i + 0.5) * cs;
        const l0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
        const l1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
        const l2 = 1 - l0 - l1;
        if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
        const z = l0 * az + l1 * bz + l2 * cz;
        const k = j * nx + i;
        if (z > heights[k]) heights[k] = z;
      }
    }
  });
  return heights;
}

function millCutter(tool) {
  if (tool.type === 'drill') return { radius: tool.diameter / 2, type: 'cone', angle: DRILL_POINT };
  if (tool.type === 'spot' || tool.type === 'csink') return { radius: tool.diameter / 2, type: 'cone', angle: tool.angle };
  // The part is modelled to the tap drill; the thread itself is not drawn.
  if (tool.type === 'tap') return { radius: tool.drill / 2, type: 'flat' };
  return { radius: tool.diameter / 2, type: tool.simType === 'ball' ? 'ball' : 'flat' };
}

function verifyMill(plan, nc, mesh, { tolerance, cellSize }) {
  const { stock, part, operations } = plan;
  const span = Math.max(stock.maxX - stock.minX, stock.maxY - stock.minY);
  const cs = cellSize ?? Math.max(MILL_MIN_CELL, span / MILL_MAX_CELLS);
  const sim = createStock({
    xMin: stock.minX,
    yMin: stock.minY,
    xMax: stock.maxX,
    yMax: stock.maxY,
    top: stock.top,
    base: part.bottom - 10,
    cellSize: cs,
  });
  const cutters = operations.map((op) => millCutter(op.tool));
  const { segments } = interpret(nc, { mode: 'mill' });
  simulate(sim, segments, (seg) => cutters[seg.tool - 1] ?? cutters[0]);

  const { nx, ny } = sim;
  const raw = partHeights(mesh, sim);
  const target = new Float32Array(nx * ny);
  for (let k = 0; k < target.length; k++) target[k] = Math.max(raw[k], part.bottom);

  const wall = new Uint8Array(nx * ny);
  const stepLimit = WALL_CELLS * cs;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const right = i + 1 < nx && Math.abs(target[k] - target[k + 1]) > stepLimit;
      const up = j + 1 < ny && Math.abs(target[k] - target[k + nx]) > stepLimit;
      if (!right && !up) continue;
      for (let dj = -1; dj <= 2; dj++) {
        for (let di = -1; di <= 2; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii >= 0 && ii < nx && jj >= 0 && jj < ny) wall[jj * nx + ii] = 1;
        }
      }
    }
  }

  // A round cutter cannot reach the corners of a rectangular blank; that is not
  // excess on the part.
  const rim = Math.ceil(Math.max(0, ...cutters.map((c) => c.radius)) / cs) + 1;
  const gouge = tally();
  const excess = tally();
  const cellVolume = cs * cs;
  for (let j = rim; j < ny - rim; j++) {
    for (let i = rim; i < nx - rim; i++) {
      const k = j * nx + i;
      if (wall[k]) continue;
      const at = [sim.xMin + (i + 0.5) * cs, sim.yMin + (j + 0.5) * cs];
      const h = sim.heights[k];
      if (raw[k] > part.bottom + 1e-6 && raw[k] - h > tolerance) record(gouge, raw[k] - h, cellVolume, at);
      if (h - target[k] > tolerance) record(excess, h - target[k], cellVolume, at);
    }
  }
  return finish(gouge, excess, cs, tolerance);
}

/** Radius of a `{z, r}` profile at z; 0 outside it. */
function radiusAt(points, z) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (z < Math.min(a.z, b.z) || z > Math.max(a.z, b.z)) continue;
    if (Math.abs(b.z - a.z) < 1e-9) return Math.max(a.r, b.r);
    return a.r + ((b.r - a.r) * (z - a.z)) / (b.z - a.z);
  }
  return 0;
}

function verifyTurn(plan, nc, { tolerance, cellSize, diameterMode }) {
  const { stock, profile, operations } = plan;
  const cs = cellSize ?? TURN_CELL;
  const { segments } = interpret(nc, { mode: 'turn', diameterMode });
  const sim = createTurningStock(
    { min: [0, 0, stock.zMin], max: [stock.radius, 0, stock.zMax] },
    {
      cellSize: cs, margin: 0, rStock: stock.radius, faceZ: detectFaceZ(segments), chuckClear: TURN_CHUCK,
    },
  );
  // A lathe T word packs station and offset: T0202 is station 2.
  const opOf = (seg) => operations[Math.floor(seg.tool / 100) - 1];
  carveTurning(
    sim,
    segments,
    { noseR: 0 },
    (seg) => (opOf(seg)?.tool.type === 'turn-id' ? 'id' : 'od'),
    () => 0,
    (seg) => opOf(seg)?.tool.width ?? 0,
  );

  const gouge = tally();
  const excess = tally();
  const zOf = (k) => sim.zMin + (k + 0.5) * cs;
  const step = (points, k) => Math.abs(radiusAt(points, zOf(k)) - radiusAt(points, zOf(k + 1))) > WALL_CELLS * cs;
  for (let k = 1; k < sim.nz - 1; k++) {
    const z = zOf(k);
    if (z < profile.zMin + 2 * cs || z > profile.zMax - 2 * cs) continue;
    const cellVolume = 2 * Math.PI * radiusAt(profile.outer, z) * cs;
    if (!step(profile.outer, k) && !step(profile.outer, k - 1)) {
      const diff = sim.radius[k] - radiusAt(profile.outer, z);
      if (diff < -tolerance) record(gouge, -diff, cellVolume, [z]);
      if (diff > tolerance) record(excess, diff, cellVolume, [z]);
    }
    if (profile.hasBore && !step(profile.bore, k) && !step(profile.bore, k - 1)) {
      const diff = sim.bore[k] - radiusAt(profile.bore, z);
      if (diff > tolerance) record(gouge, diff, cellVolume, [z]);
      if (diff < -tolerance) record(excess, -diff, cellVolume, [z]);
    }
  }
  return finish(gouge, excess, cs, tolerance);
}

/**
 * Compare what a posted program cuts with the part it was planned for.
 *
 * @param {object} plan  from `planJob`
 * @param {string} nc  from `post`
 * @param {{tolerance?:number, cellSize?:number, diameterMode?:boolean}} [opts]
 *   `diameterMode` is how a turning program was posted (X on diameter by default).
 * @returns {{ok:boolean, cellSize:number, tolerance:number,
 *   gouge:{max:number,cells:number,volume:number,at:number[]|null},
 *   excess:{max:number,cells:number,volume:number,at:number[]|null}}
 *   |{ok:null, skipped:string}}
 */
export function verifyCut(plan, nc, opts = {}) {
  const options = {
    tolerance: opts.tolerance ?? DEFAULT_TOLERANCE,
    cellSize: opts.cellSize,
    diameterMode: opts.diameterMode ?? true,
  };
  if (plan.operations.length === 0) return { ok: null, skipped: 'There are no operations to check yet.' };
  if (plan.mode === 'turn') return verifyTurn(plan, nc, options);
  if (plan.operations.some((op) => op.indexA)) {
    return { ok: null, skipped: 'A rotary index turns the part between cuts; a top-down height field cannot compare that.' };
  }
  return verifyMill(plan, nc, plan.orientedMesh.welded, options);
}
