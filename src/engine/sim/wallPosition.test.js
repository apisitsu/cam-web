/**
 * A wall goes where the wall is, not where the lattice is.
 *
 * The height field knows which CELL a bore's rim falls in and nothing finer, so
 * a riser drawn on the cell boundary made every circle a staircase one cell
 * deep — the same 0.31 mm out of round on a Ø10 bore and a Ø80 one, and the
 * chamfer around it inherited the identical scallop. Refining the grid was the
 * only lever, and it costs area.
 *
 * `stock.edge` records the signed horizontal distance from each cell's centre to
 * the nearest cut boundary, and the mesher slides each grid node onto the zero
 * crossing before building anything from it. Tops and risers are both built from
 * those nodes, so both follow.
 *
 * What is pinned here is the property, not the numbers: **the rim's roundness
 * must stop being a function of the cell size.**
 */
import { describe, it, expect } from 'vitest';
import { createSession, carveTo } from './session.js';
import { heightmapToSolidMesh } from './mesh.js';
import { createStock, cutSegment, resetStock, EDGE_FAR } from './dexel.js';

/** Mill a bore of diameter `d` with a Ø6 endmill. */
const boreProgram = (d) => {
  const r = d / 2 - 3;
  return `%
O9970 (BORE)
G21 G17 G90 G54
T1 M6 (ENDMILL D6)
S6000 M3
G0 X${r.toFixed(3)} Y0 Z5
G1 Z-4 F200
G2 X${r.toFixed(3)} Y0 I-${r.toFixed(3)} J0 F500
G0 Z25
M30
`;
};

/** Spread of the radii of every mesh vertex near the rim, in mm. */
function rimSpread(mesh, d, band = 1.0) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const r = Math.hypot(mesh.positions[i], mesh.positions[i + 1]);
    if (Math.abs(r - d / 2) > band) continue;
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  return hi - lo;
}

function boreAt(cell) {
  const s = createSession(boreProgram(30), {
    cellSize: cell, radius: 3, cutter: 'endmill', margin: 5,
    stockSize: { x: 50, y: 50, z: 20 },
  });
  carveTo(s, s.totalFeeds);
  return s.stock;
}

describe('the bore rim', () => {
  it('is far rounder than the lattice it was carved on', () => {
    const stock = boreAt(0.25);
    const placed = rimSpread(heightmapToSolidMesh(stock), 30);
    // The same field, with the edge record withheld: the old lattice mesh.
    const lattice = rimSpread(heightmapToSolidMesh({ ...stock, edge: null }), 30);
    expect(placed).toBeLessThan(lattice / 4);
    expect(placed).toBeLessThan(stock.cellSize / 4);
  });

  it('no longer gets its roundness from the cell size', () => {
    // Halving the grid used to halve the error. It must now barely matter —
    // the rim is limited by the toolpath and the field, not the lattice.
    const coarse = rimSpread(heightmapToSolidMesh(boreAt(0.25)), 30);
    const fine = rimSpread(heightmapToSolidMesh(boreAt(0.125)), 30);
    expect(Math.abs(coarse - fine)).toBeLessThan(0.05);
  });

  it('beats the old mesh at TWICE the resolution', () => {
    // The point of the whole change: quality without paying for area.
    const coarsePlaced = rimSpread(heightmapToSolidMesh(boreAt(0.25)), 30);
    const fineStock = boreAt(0.125);
    const fineLattice = rimSpread(heightmapToSolidMesh({ ...fineStock, edge: null }), 30);
    expect(coarsePlaced).toBeLessThan(fineLattice);
  });
});

describe('the edge record itself', () => {
  it('is negative inside the cut, positive outside, and far away elsewhere', () => {
    const s = createStock({
      xMin: -10, yMin: -10, xMax: 10, yMax: 10, top: 0, base: -10, cellSize: 0.25,
    });
    cutSegment(s, [0, 0, -2], [0, 0, -2], { radius: 2, type: 'flat' });
    const at = (x, y) => s.edge[
      Math.floor((y - s.yMin) / 0.25) * s.nx + Math.floor((x - s.xMin) / 0.25)
    ];
    // Near the middle the field reads about the tool's radius, less however far
    // the cell's own centre sits from the axis — no centre lands exactly on it.
    expect(at(0, 0)).toBeGreaterThan(-2);
    expect(at(0, 0)).toBeLessThan(-1.7);
    expect(at(1.9, 0)).toBeLessThan(0);       // just inside the rim
    expect(at(2.1, 0)).toBeGreaterThan(0);    // just outside it
    expect(at(9, 9)).toBe(EDGE_FAR);          // nowhere near the cut
  });

  it('records the union when cuts overlap — the nearer boundary wins', () => {
    const s = createStock({
      xMin: -10, yMin: -10, xMax: 20, yMax: 10, top: 0, base: -10, cellSize: 0.25,
    });
    cutSegment(s, [0, 0, -2], [0, 0, -2], { radius: 2, type: 'flat' });
    cutSegment(s, [3, 0, -2], [3, 0, -2], { radius: 2, type: 'flat' });
    const at = (x, y) => s.edge[
      Math.floor((y - s.yMin) / 0.25) * s.nx + Math.floor((x - s.xMin) / 0.25)
    ];
    // Between the two, both reach: the point is inside their union.
    expect(at(1.5, 0)).toBeLessThan(0);
    // Over the second cut's axis the second cut is the nearer boundary, so its
    // radius is what is recorded — the first cut's 3 mm away does not win.
    expect(at(3, 0)).toBeLessThan(-1.7);
    expect(at(3, 0)).toBeGreaterThan(-2);
  });

  it('is withheld for a cutter the grid cannot resolve', () => {
    // A tool narrower than a cell leaves a field whose zero crossing is nowhere
    // near the real wall; interpolating it would move nodes further than the
    // lattice error it replaces.
    const s = createStock({
      xMin: -10, yMin: -10, xMax: 10, yMax: 10, top: 0, base: -10, cellSize: 1,
    });
    cutSegment(s, [0, 0, -2], [5, 0, -2], { radius: 0.1, type: 'flat' });
    expect([...s.edge].every((e) => e === EDGE_FAR)).toBe(true);
  });

  it('is cleared when the stock is scrubbed back', () => {
    const s = createStock({
      xMin: -10, yMin: -10, xMax: 10, yMax: 10, top: 0, base: -10, cellSize: 0.25,
    });
    cutSegment(s, [0, 0, -2], [0, 0, -2], { radius: 2, type: 'flat' });
    expect([...s.edge].some((e) => e < 0)).toBe(true);
    resetStock(s);
    expect([...s.edge].every((e) => e === EDGE_FAR)).toBe(true);
  });
});
