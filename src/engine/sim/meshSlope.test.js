/**
 * Is a machined **slope** drawn as a slope?
 *
 * The reported symptom: "chamfer simulate แล้วผิวไม่เรียบ เป็น step" — a chamfer
 * comes out of the simulation as a staircase instead of a flat 45° face. Like
 * the leaning-wall bug before it (`meshSquare.test.js`), the height field was
 * never wrong: a chamfer mill stamps a cone, and the heights it leaves ARE a
 * ramp. The triangulation drew every cell as a flat tread with a riser beside
 * it, and turned the ramp into stairs on the way to the screen.
 *
 * The rule that settles both cases is one threshold: cells that agree to within
 * `SLOPE_CELLS` cell widths are one surface and share their corner heights;
 * cells that do not are a step, and a vertical riser closes it. So this file
 * asserts the half `meshSquare.test.js` does not — that a cone, a ramp and a
 * ball nose come out as the shapes the cutter actually left — while the wall
 * stays square, and the shell stays sealed either way.
 */
import { describe, it, expect } from 'vitest';
import { createStock, cutSegment } from './dexel.js';
import { heightmapToSolidMesh, SLOPE_CELLS } from './mesh.js';

const BASE = -10;

function block(cellSize = 0.5) {
  return createStock({
    xMin: 0, yMin: 0, xMax: 20, yMax: 20, top: 0, base: BASE, cellSize,
  });
}

/** Every non-degenerate triangle as its three corners plus a unit normal. */
function facets(mesh) {
  const out = [];
  for (let k = 0; k < mesh.indices.length; k += 3) {
    const p = [0, 1, 2].map((n) => {
      const i = mesh.indices[k + n] * 3;
      return [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
    });
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const w = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const n = [
      u[1] * w[2] - u[2] * w[1],
      u[2] * w[0] - u[0] * w[2],
      u[0] * w[1] - u[1] * w[0],
    ];
    const len = Math.hypot(...n);
    if (len > 1e-9) out.push({ p, n: n.map((c) => c / len) });
  }
  return out;
}

/** Triangles wholly inside a box — the cut itself, away from its edges. */
const inside = (f, box) => f.p.every(([x, y, z]) => x >= box.x0 && x <= box.x1
  && y >= box.y0 && y <= box.y1 && z >= box.z0 && z <= box.z1);

const vertical = (f) => Math.abs(f.n[2]) < 1e-6;
const flat = (f) => Math.abs(f.n[2]) > 1 - 1e-6;

describe('a chamfer mill draws the cone it cut', () => {
  // A 90° chamfer mill run along X with its tip 3 mm down: the cone's flanks
  // rise 1 mm per mm out from the axis, so the groove is a V of two 45° planes,
  // 3 mm deep and 6 mm wide, and both flanks are as flat as any face the tool
  // can make.
  const grooved = (opts) => {
    const s = block();
    cutSegment(s, [4, 10, -3], [16, 10, -3], { radius: 6, type: 'cone', angle: 90 });
    return heightmapToSolidMesh(s, opts);
  };

  // The +Y flank, clear of both ends of the move and of the two places the grid
  // can only blunt: the V's own bottom and the top edge where it runs out into
  // uncut stock. Both are one cell wide, and both are the height field's
  // resolution rather than the triangulation's doing.
  const flank = { x0: 6, x1: 14, y0: 10.5, y1: 12.5, z0: -2.5, z1: -0.5 };

  it('leaves no staircase inside the groove', () => {
    const stairs = facets(grooved()).filter((f) => inside(f, flank) && vertical(f));
    expect(stairs).toHaveLength(0);
  });

  it('draws the flanks at the 45° the cutter grinds', () => {
    const fs = facets(grooved()).filter((f) => inside(f, flank));
    expect(fs.length).toBeGreaterThan(20);
    // |nz| = cos 45° on every one of them: the flank is one plane, not treads.
    for (const f of fs) expect(Math.abs(f.n[2])).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('is a staircase again if the slope rule is switched off', () => {
    // The bug this fixes, reproduced on demand: with nothing allowed to slope,
    // the same cone comes back as flat treads and vertical risers.
    const fs = facets(grooved({ slopeLimit: 1e-9 })).filter((f) => inside(f, flank));
    expect(fs.length).toBeGreaterThan(20);
    expect(fs.some(vertical)).toBe(true);
    for (const f of fs) expect(vertical(f) || flat(f)).toBe(true);
  });

  it('puts the groove where the cone reaches, 3 mm deep and 6 mm wide', () => {
    const mesh = grooved();
    let deepest = Infinity;
    let half = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const [x, y, z] = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
      if (z < deepest && z > BASE) deepest = z;
      if (x > 6 && x < 14 && z < -0.05 && z > BASE) half = Math.max(half, Math.abs(y - 10));
    }
    // Never past the tip, and within a cell of it: no cell centre sits exactly
    // on the axis, so the very bottom of the V is one cell blunt. That is the
    // field's sampling, and it was there before anything sloped.
    expect(deepest).toBeGreaterThanOrEqual(-3);
    expect(deepest).toBeLessThan(-3 + 0.5);
    expect(half).toBeCloseTo(3, 1);
  });
});

describe('the other surfaces a cutter genuinely leaves', () => {
  it('draws a ramped floor as one continuous ramp', () => {
    const s = block();
    cutSegment(s, [2, 10, -1], [18, 10, -8], { radius: 2, type: 'flat' });
    // Down the middle of the ramp, well inside the tool's width.
    const along = { x0: 5, x1: 15, y0: 9, y1: 11, z0: BASE, z1: -0.5 };
    const fs = facets(heightmapToSolidMesh(s)).filter((f) => inside(f, along));
    expect(fs.length).toBeGreaterThan(20);
    expect(fs.filter(vertical)).toHaveLength(0);
    // 7 mm down over 16 mm along. Not exact: the sweep stamps the flat disc
    // every half cell and each cell keeps the lowest stamp that reached it, so
    // the floor is the ramp plus a sub-cell sawtooth. Every facet is within a
    // tenth of the programmed slope — the field's own accuracy, and nothing
    // like the 0 of a tread.
    for (const f of fs) expect(Math.abs(Math.abs(f.n[0] / f.n[2]) - 7 / 16)).toBeLessThan(0.1);
  });

  it('draws a ball nose as a curve, not a flight of stairs', () => {
    const s = block();
    cutSegment(s, [4, 10, -4], [16, 10, -4], { radius: 3, type: 'ball' });
    // The whole bowl, from the flat right at the nose out to where its flank
    // steepens toward the rim.
    const bowl = { x0: 6, x1: 14, y0: 7.4, y1: 12.6, z0: -4.01, z1: -1.2 };
    const fs = facets(heightmapToSolidMesh(s)).filter((f) => inside(f, bowl));
    expect(fs.length).toBeGreaterThan(20);
    expect(fs.filter(vertical)).toHaveLength(0);
    // A real curve: the facets face a spread of directions, not two.
    const tilts = fs.map((f) => Math.abs(f.n[2]));
    expect(new Set(tilts.map((z) => z.toFixed(2))).size).toBeGreaterThan(2);
    expect(Math.max(...tilts) - Math.min(...tilts)).toBeGreaterThan(0.2);
  });
});

describe('the threshold that tells a slope from a step', () => {
  const ramped = (opts) => {
    const s = block();
    cutSegment(s, [2, 10, -1], [18, 10, -8], { radius: 2, type: 'flat' });
    return heightmapToSolidMesh(s, opts);
  };
  const along = { x0: 5, x1: 15, y0: 9, y1: 11, z0: BASE, z1: -0.5 };

  it('defaults to two cell widths — every cone up to 60°, no Z-level step', () => {
    expect(SLOPE_CELLS).toBe(2);
  });

  it('goes back to treads and risers when nothing may slope', () => {
    const fs = facets(ramped({ slopeLimit: 1e-9 })).filter((f) => inside(f, along));
    expect(fs.length).toBeGreaterThan(20);
    for (const f of fs) expect(vertical(f) || flat(f)).toBe(true);
  });

  it('keeps a 5 mm wall square at the default, and only loses it if told to', () => {
    const s = block();
    // A square-shouldered pocket: the wall is ten times the slope limit.
    for (let x = 6; x <= 14; x += 0.1) {
      for (let y = 6; y <= 14; y += 0.1) {
        cutSegment(s, [x, y, -5], [x, y, -5], { radius: 0.1, type: 'flat' });
      }
    }
    // The band the pocket's -X wall stands in, floor and rim included.
    const band = { x0: 5.4, x1: 6.6, y0: 7, y1: 13, z0: BASE, z1: 0 };
    const tilted = (mesh) => facets(mesh)
      .filter((f) => inside(f, band) && !vertical(f) && !flat(f));
    expect(tilted(heightmapToSolidMesh(s))).toHaveLength(0);
    // 20 mm of slack is the whole depth of cut: with that, the wall is "one
    // surface" with the floor and leans across the cell, which is the very bug
    // `meshSquare.test.js` was written for. It takes an explicit instruction.
    expect(tilted(heightmapToSolidMesh(s, { slopeLimit: 20 })).length).toBeGreaterThan(0);
  });
});

describe('the shell stays sealed', () => {
  /**
   * Every edge above the floor that spans any ground at all is shared by
   * exactly two triangles. A riser that failed to span what its two cells left
   * would show up here as an open edge — a crack you could see through.
   *
   * Checked on the **unmerged** mesh: merging flat runs leaves T-junctions,
   * where a run's long edge meets a row subdivided differently. That is not a
   * hole — the two are exactly coplanar — but it is not edge-matched either,
   * and "no hole" is what this is testing. That merging changes nothing but the
   * triangulation is the next block down.
   *
   * Purely vertical edges are exempt, and always were: four cells meet at a
   * grid node at four different heights, so the four risers that meet there
   * stack differently on each side. That leaves a slit of zero width, which is
   * a property of a height field and not something a triangulation can fix.
   */
  const openEdges = (mesh) => {
    const key = (a, b) => {
      const f = (q) => q.map((c) => c.toFixed(5)).join(',');
      const [u, w] = [f(a), f(b)].sort();
      return `${u}|${w}`;
    };
    const at = (k) => {
      const i = mesh.indices[k] * 3;
      return [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
    };
    const seen = new Map();
    // Every triangle as indexed, degenerate ones included — an edge left over
    // by a zero-area face is still an edge that has to pair up.
    for (let k = 0; k < mesh.indices.length; k += 3) {
      const p = [at(k), at(k + 1), at(k + 2)];
      for (let i = 0; i < 3; i++) {
        const a = p[i];
        const b = p[(i + 1) % 3];
        // The billet's flat bottom is one big quad against per-cell side walls,
        // so its rim is open by construction and is not what this is testing.
        if (a[2] < BASE + 0.5 || b[2] < BASE + 0.5) continue;
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) continue;
        const k2 = key(a, b);
        seen.set(k2, (seen.get(k2) || 0) + 1);
      }
    }
    return [...seen.values()].filter((n) => n % 2 !== 0).length;
  };

  const slopeIntoWall = () => {
    const s = block();
    // A cone groove running into a step: the node where they meet is broken on
    // one side and shared on the other, which is exactly where a gap would open.
    cutSegment(s, [4, 10, -1], [16, 10, -1], { radius: 3, type: 'cone', angle: 90 });
    cutSegment(s, [10, 4, -5], [10, 16, -5], { radius: 2, type: 'flat' });
    return s;
  };

  const ramp = () => {
    const s = block();
    cutSegment(s, [2, 10, -1], [18, 10, -8], { radius: 2, type: 'flat' });
    return s;
  };

  it('has no crack where a slope meets a wall', () => {
    expect(openEdges(heightmapToSolidMesh(slopeIntoWall(), { merge: false }))).toBe(0);
  });

  it('has no crack in a plain ramp', () => {
    expect(openEdges(heightmapToSolidMesh(ramp(), { merge: false }))).toBe(0);
  });
});

describe('merging flat runs changes the triangulation and nothing else', () => {
  /** Total area drawn at each height — the surface itself, however it is cut up. */
  const areaByHeight = (mesh) => {
    const at = (k) => {
      const i = mesh.indices[k] * 3;
      return [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
    };
    const acc = new Map();
    for (let k = 0; k < mesh.indices.length; k += 3) {
      const p = [at(k), at(k + 1), at(k + 2)];
      // Horizontal facets only: those are the ones merging touches.
      if (Math.abs(p[0][2] - p[1][2]) > 1e-9 || Math.abs(p[0][2] - p[2][2]) > 1e-9) continue;
      const area = Math.abs(
        (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]),
      ) / 2;
      const z = p[0][2].toFixed(4);
      acc.set(z, (acc.get(z) || 0) + area);
    }
    return acc;
  };

  const pocketed = () => {
    const s = block();
    for (let x = 6; x <= 14; x += 0.1) {
      for (let y = 6; y <= 14; y += 0.1) {
        cutSegment(s, [x, y, -5], [x, y, -5], { radius: 0.1, type: 'flat' });
      }
    }
    return s;
  };

  it('draws the same surface, at the same heights, over the same ground', () => {
    const s = pocketed();
    const merged = areaByHeight(heightmapToSolidMesh(s));
    const plain = areaByHeight(heightmapToSolidMesh(s, { merge: false }));
    expect([...merged.keys()].sort()).toEqual([...plain.keys()].sort());
    for (const [z, area] of plain) expect(merged.get(z)).toBeCloseTo(area, 6);
  });

  it('costs a fraction of the quads on a billet that is mostly flat', () => {
    const s = pocketed();
    const merged = heightmapToSolidMesh(s).positions.length;
    const plain = heightmapToSolidMesh(s, { merge: false }).positions.length;
    // This is the whole point: it is what lets the grid be fine enough to draw
    // a small bore as a circle rather than a dodecagon.
    expect(merged).toBeLessThan(plain / 4);
  });

  it('never merges across a slope — a chamfer keeps every cell it needs', () => {
    const s = block();
    cutSegment(s, [4, 10, -3], [16, 10, -3], { radius: 6, type: 'cone', angle: 90 });
    const flank = { x0: 6, x1: 14, y0: 10.5, y1: 12.5, z0: -2.5, z1: -0.5 };
    const fs = facets(heightmapToSolidMesh(s)).filter((f) => inside(f, flank));
    expect(fs.length).toBeGreaterThan(20);
    for (const f of fs) expect(Math.abs(f.n[2])).toBeCloseTo(Math.SQRT1_2, 6);
  });
});
