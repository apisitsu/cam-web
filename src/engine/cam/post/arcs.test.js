import { describe, it, expect } from 'vitest';
import { fitArcs } from './arcs.js';
import { postMilling, postTurning } from './fanuc.js';
import { interpret } from '../../gcode/interpreter.js';

const circlePoints = (cx, cy, r, from, to, n) => Array.from({ length: n + 1 }, (_, k) => {
  const a = from + ((to - from) * k) / n;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
});

const millMoves = (pts, z = -1) => [
  { t: 'rapid', x: pts[0][0], y: pts[0][1], z: 5 },
  { t: 'feed', x: pts[0][0], y: pts[0][1], z },
  ...pts.slice(1).map(([x, y]) => ({ t: 'feed', x, y, z })),
];

const millOp = (moves) => ({
  name: 'Test',
  tool: { label: 'EM' },
  speeds: { rpm: 1000, feed: 300 },
  moves,
});

describe('fitArcs', () => {
  it('turns a counter-clockwise run into one arc', () => {
    const out = fitArcs(millMoves(circlePoints(10, 20, 5, 0, Math.PI / 2, 12)));
    const arcs = out.filter((m) => m.t === 'arc');
    expect(arcs).toHaveLength(1);
    expect(arcs[0].cw).toBe(false);
    expect(arcs[0].i).toBeCloseTo(-5, 3);
    expect(arcs[0].j).toBeCloseTo(0, 3);
    expect(arcs[0].x).toBeCloseTo(10, 3);
    expect(arcs[0].y).toBeCloseTo(25, 3);
  });

  it('marks a clockwise run clockwise', () => {
    const [arc] = fitArcs(millMoves(circlePoints(0, 0, 5, Math.PI / 2, 0, 12))).filter((m) => m.t === 'arc');
    expect(arc.cw).toBe(true);
  });

  it('splits a full circle into arcs of at most a half turn', () => {
    const out = fitArcs(millMoves(circlePoints(0, 0, 5, 0, 2 * Math.PI, 48)));
    expect(out.filter((m) => m.t === 'arc').length).toBeGreaterThanOrEqual(2);
    expect(out.filter((m) => m.t === 'feed')).toHaveLength(1);
  });

  it('leaves straight lines alone', () => {
    const pts = Array.from({ length: 10 }, (_, k) => [k, 2 * k]);
    expect(fitArcs(millMoves(pts)).some((m) => m.t === 'arc')).toBe(false);
  });

  it('leaves a real polygon alone', () => {
    const out = fitArcs(millMoves(circlePoints(0, 0, 20, 0, 2 * Math.PI, 8)));
    expect(out.some((m) => m.t === 'arc')).toBe(false);
  });

  it('does not join points at different heights', () => {
    const pts = circlePoints(0, 0, 5, 0, Math.PI / 2, 12);
    const moves = pts.map(([x, y], k) => ({ t: 'feed', x, y, z: -k * 0.1 }));
    expect(fitArcs(moves).some((m) => m.t === 'arc')).toBe(false);
  });

  it('keeps straight lines either side of an arc', () => {
    const arc = circlePoints(0, 0, 5, 0, Math.PI / 2, 12);
    const moves = millMoves([[5, -20], [5, -10], ...arc, [-10, 5], [-20, 5]]);
    const out = fitArcs(moves);
    expect(out.filter((m) => m.t === 'arc')).toHaveLength(1);
    expect(out[out.length - 1].x).toBe(-20);
  });

  it('stops a run at a canned cycle', () => {
    const moves = [{ cycle: 'G81', x: 0, y: 0, z: -5 }, { cycle: 'G81', x: 5, y: 0, z: -5 }];
    expect(fitArcs(moves)).toEqual(moves);
  });
});

describe('arcs through the post and back', () => {
  const reachedAll = (segments, pts, axes, tol) => {
    for (const [u, v] of pts) {
      const near = segments.some((s) => Math.hypot(s.b[axes[0]] - u, s.b[axes[1]] - v) < tol
        || Math.hypot(s.a[axes[0]] - u, s.a[axes[1]] - v) < 0.3);
      expect(near).toBe(true);
    }
  };

  it('a milled arc reads back on the same circle', () => {
    const pts = circlePoints(10, 20, 5, 0, 1.5 * Math.PI, 36);
    const nc = postMilling({ name: 'a', operations: [millOp(millMoves(pts))] });
    expect(nc).toMatch(/^G03 /m);
    const { segments } = interpret(nc, { mode: 'mill' });
    const cut = segments.filter((s) => s.type !== 'rapid' && Math.abs(s.a[2] + 1) < 1e-3 && Math.abs(s.b[2] + 1) < 1e-3);
    expect(cut.length).toBeGreaterThan(0);
    for (const s of cut) expect(Math.hypot(s.b[0] - 10, s.b[1] - 20)).toBeCloseTo(5, 2);
    const end = cut[cut.length - 1].b;
    expect(end[0]).toBeCloseTo(pts[pts.length - 1][0], 2);
    expect(end[1]).toBeCloseTo(pts[pts.length - 1][1], 2);
    reachedAll(cut, pts, [0, 1], 0.05);
  });

  it('a turned ball end reads back on the same circle, on diameter', () => {
    // A convex R10 at the free end: radius grows as Z runs towards the chuck.
    const pts = Array.from({ length: 31 }, (_, k) => {
      const a = (k / 30) * (Math.PI / 2);
      return { r: 10 * Math.sin(a), z: 10 * Math.cos(a) };
    });
    const op = {
      name: 'Finish',
      tool: { label: 'CNMG' },
      speeds: { clampRpm: 3000, vc: 200, fn: 0.1 },
      moves: [
        { t: 'rapid', x: 0, z: 12 },
        { t: 'feed', x: pts[0].r, z: pts[0].z },
        ...pts.slice(1).map((p) => ({ t: 'feed', x: p.r, z: p.z })),
      ],
    };
    const nc = postTurning({ name: 'b', operations: [op] });
    expect(nc).toMatch(/^G0[23] .*I.*K/m);
    const { segments } = interpret(nc, { mode: 'turn', diameterMode: true });
    const cut = segments.filter((s) => s.type !== 'rapid');
    for (const s of cut) expect(Math.hypot(s.b[0], s.b[2])).toBeCloseTo(10, 1);
    expect(cut[cut.length - 1].b[0]).toBeCloseTo(10, 2);
    expect(cut[cut.length - 1].b[2]).toBeCloseTo(0, 2);
  });
});
