import { describe, it, expect } from 'vitest';
import { createStock, stamp, cutSegment } from './dexel.js';
import { heightmapToSolidMesh } from './mesh.js';

describe('drilling deeper than the plate is thick', () => {
  /** A 40 × 40 plate, 20 mm thick, top at Z0. */
  const plate = () => createStock({
    xMin: 0, yMin: 0, xMax: 40, yMax: 40, top: 0, base: -20, cellSize: 1,
  });

  it('removes the plate, not more than the plate', () => {
    // Reported from the floor on 146A7631-3: a 20 mm part drilled 25 mm deep.
    // Nothing stopped the column being recorded below the bottom of the billet.
    const stock = plate();
    stamp(stock, 20, 20, -25, { radius: 5, type: 'flat' });
    let lowest = Infinity;
    for (const h of stock.heights) if (h < lowest) lowest = h;
    expect(lowest).toBeGreaterThanOrEqual(stock.base);
  });

  it('counts only the material that was there', () => {
    const stock = plate();
    const removed = stamp(stock, 20, 20, -25, { radius: 5, type: 'flat' });
    // The footprint is cell-quantised, so compare against the plate's thickness
    // times the area actually cleared rather than the exact cylinder.
    let cleared = 0;
    for (const h of stock.heights) if (h < 0) cleared += 1;
    expect(removed).toBeCloseTo(cleared * 20, 6);
    // And it must not be the 25 mm the drill travelled.
    expect(removed).toBeLessThan(cleared * 25);
  });

  it('leaves the rest of the block at its own thickness', () => {
    // The symptom on screen: the underside of the *whole* block followed the
    // deepest hole down, because the mesh takes its floor from the lowest column.
    const stock = plate();
    stamp(stock, 20, 20, -25, { radius: 5, type: 'flat' });
    const mesh = heightmapToSolidMesh(stock);
    let bottom = Infinity;
    for (let i = 2; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i] < bottom) bottom = mesh.positions[i];
    }
    expect(bottom).toBeGreaterThan(stock.base - 0.01);
  });

  it('still cuts to the right depth for a hole that does not break through', () => {
    const stock = plate();
    stamp(stock, 20, 20, -12, { radius: 5, type: 'flat' });
    let lowest = Infinity;
    for (const h of stock.heights) if (h < lowest) lowest = h;
    expect(lowest).toBeCloseTo(-12, 6);
  });

  it('clamps a swept cut too, not only a single plunge', () => {
    const stock = plate();
    cutSegment(stock, [5, 20, -30], [35, 20, -30], { radius: 4, type: 'flat' });
    let lowest = Infinity;
    for (const h of stock.heights) if (h < lowest) lowest = h;
    expect(lowest).toBeGreaterThanOrEqual(stock.base);
  });
});
