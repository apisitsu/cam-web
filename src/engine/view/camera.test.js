import { describe, it, expect } from 'vitest';
import {
  viewBasis, viewDir, worldUpFor, framing, unionBounds,
  VIEW_DIRS, TURN_VIEW_DIRS,
} from './camera.js';

/** Name a unit axis vector, e.g. [0,0,1] → '+Z'. */
const axis = (v) => {
  const names = ['X', 'Y', 'Z'];
  let best = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(v[i]) > Math.abs(v[best])) best = i;
  if (Math.abs(v[best]) < 0.9) return `(${v.map((n) => n.toFixed(2)).join(',')})`;
  return (v[best] < 0 ? '-' : '+') + names[best];
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('viewBasis — milling (Z up)', () => {
  const cases = [
    ['front', '+X', '+Z'],
    ['back', '-X', '+Z'],
    ['right', '+Y', '+Z'],
    ['left', '-Y', '+Z'],
    ['top', '+X', '+Y'],
    ['bottom', '-X', '+Y'],
  ];
  it.each(cases)('%s reads %s across, %s up', (view, right, up) => {
    const b = viewBasis('mill', view);
    expect(axis(b.right)).toBe(right);
    expect(axis(b.up)).toBe(up);
  });

  it('keeps Z up on every side view', () => {
    for (const view of ['front', 'back', 'right', 'left']) {
      expect(axis(viewBasis('mill', view).up)).toBe('+Z');
    }
  });
});

describe('viewBasis — turning (Y up, profile in X-Z)', () => {
  it('Top is the working plane: Z across, radius (X) up', () => {
    const b = viewBasis('turn', 'top');
    expect(axis(b.right)).toBe('+Z');
    expect(axis(b.up)).toBe('+X');
  });

  it('keeps the machine vertical (Y) up on every side view', () => {
    for (const view of ['front', 'back', 'right', 'left']) {
      expect(axis(viewBasis('turn', view).up)).toBe('+Y');
    }
  });

  it('runs Z the same way in Top, Front and Iso so the part never flips', () => {
    for (const view of ['top', 'front', 'iso']) {
      // +Z must point into the right half of the screen.
      expect(viewBasis('turn', view).right[2]).toBeGreaterThan(0);
    }
  });

  it('puts the iso camera above the work, not underneath', () => {
    expect(viewDir('turn', 'iso')[1]).toBeGreaterThan(0);
    // …and its screen-up is dominated by the machine vertical.
    expect(viewBasis('turn', 'iso').up[1]).toBeGreaterThan(0.5);
  });
});

describe('viewBasis — the degenerate case that broke the lathe views', () => {
  it('never returns a zero or NaN basis, in any mode or preset', () => {
    for (const mode of ['mill', 'turn']) {
      for (const view of [...Object.keys(VIEW_DIRS), ...Object.keys(TURN_VIEW_DIRS)]) {
        const { right, up, forward } = viewBasis(mode, view);
        for (const [name, v] of [['right', right], ['up', up], ['forward', forward]]) {
          const len = Math.hypot(...v);
          expect(Number.isFinite(len), `${mode}/${view} ${name} is finite`).toBe(true);
          expect(near(len, 1, 1e-9), `${mode}/${view} ${name} is unit (got ${len})`).toBe(true);
        }
      }
    }
  });

  it('returns an orthonormal right/up/forward triple everywhere', () => {
    for (const mode of ['mill', 'turn']) {
      for (const view of Object.keys(VIEW_DIRS)) {
        const { right, up, forward } = viewBasis(mode, view);
        const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        expect(Math.abs(d(right, up))).toBeLessThan(1e-9);
        expect(Math.abs(d(right, forward))).toBeLessThan(1e-9);
        expect(Math.abs(d(up, forward))).toBeLessThan(1e-9);
      }
    }
  });

  it('the screen up is never parallel to the view direction', () => {
    // This is the failure that rolled the camera arbitrarily: `camera.up` was set
    // from world-up, which for turning Top/Bottom points straight down the view.
    for (const mode of ['mill', 'turn']) {
      for (const view of Object.keys(VIEW_DIRS)) {
        const { up, forward } = viewBasis(mode, view);
        const cos = Math.abs(up[0] * forward[0] + up[1] * forward[1] + up[2] * forward[2]);
        expect(cos, `${mode}/${view}`).toBeLessThan(0.99);
      }
    }
  });

  it('world up is Z for milling and Y for turning', () => {
    expect(worldUpFor('mill')).toEqual([0, 0, 1]);
    expect(worldUpFor('turn')).toEqual([0, 1, 0]);
  });

  it('falls back to iso for an unknown preset instead of throwing', () => {
    expect(() => viewBasis('mill', 'nonsense')).not.toThrow();
    expect(viewDir('mill', 'nonsense')).toEqual(viewDir('mill', 'iso'));
  });
});

describe('framing', () => {
  const canvas = { width: 800, height: 600 };
  const box = { min: [-10, -20, 0], max: [10, 20, 5] };

  it('centres on the box and stands the camera off along the view direction', () => {
    const f = framing('mill', 'top', box, canvas);
    expect(f.center).toEqual([0, 0, 2.5]);
    expect(f.distance).toBeGreaterThan(f.radius);
    for (let i = 0; i < 3; i++) {
      expect(near(f.position[i], f.center[i] + f.dir[i] * f.distance, 1e-9)).toBe(true);
    }
    expect(f.near).toBeLessThan(f.far);
  });

  it('fits the in-plane extents, not the 3D diagonal', () => {
    // Front sees 20 wide (X) and 5 tall (Z); the 40 mm Y depth is out of plane
    // and must not affect the zoom. Width is the binding axis here.
    const f = framing('mill', 'front', box, canvas);
    expect(f.zoom).toBeCloseTo(800 / (20 * 1.08), 6);
    // Deepening the part out of plane leaves the fit alone.
    const deeper = framing('mill', 'front', { min: [-10, -500, 0], max: [10, 500, 5] }, canvas);
    expect(deeper.zoom).toBeCloseTo(f.zoom, 6);
  });

  it('binds on height when that is the tighter axis', () => {
    // Top sees 20 x 40; 600px/40mm is tighter than 800px/20mm. (VIEW_DIRS.top
    // carries a deliberate 1e-3 tilt off the axis, hence the loose precision.)
    const f = framing('mill', 'top', box, canvas);
    expect(f.zoom).toBeCloseTo(600 / (40 * 1.08), 2);
  });

  it('a wide-shallow part still fills the view', () => {
    const wide = { min: [-100, -1, 0], max: [100, 1, 0] };
    const f = framing('mill', 'top', wide, canvas);
    // Bound by width: 800px across 200mm.
    expect(f.zoom).toBeCloseTo(800 / (200 * 1.08), 6);
  });

  it('frames a calm working area when nothing is loaded', () => {
    const f = framing('mill', 'iso', null, canvas);
    expect(Number.isFinite(f.zoom)).toBe(true);
    expect(f.zoom).toBeGreaterThan(0);
    // Not zoomed absurdly far into a degenerate point.
    expect(f.zoom).toBeLessThan(50);
  });

  it('never returns a zero or infinite zoom for a flat or empty box', () => {
    for (const b of [
      { min: [0, 0, 0], max: [0, 0, 0] },      // a single point
      { min: [-5, 0, 0], max: [5, 0, 0] },      // flat in two axes
      null,
    ]) {
      const f = framing('turn', 'top', b, canvas);
      expect(Number.isFinite(f.zoom)).toBe(true);
      expect(f.zoom).toBeGreaterThan(0);
    }
  });
});

describe('unionBounds', () => {
  it('merges two boxes per axis', () => {
    const a = { min: [0, 0, 0], max: [10, 10, 10] };
    const b = { min: [-5, 2, 0], max: [5, 20, 3] };
    expect(unionBounds(a, b)).toEqual({ min: [-5, 0, 0], max: [10, 20, 10] });
  });

  it('passes the other through when one is missing', () => {
    const a = { min: [0, 0, 0], max: [1, 1, 1] };
    expect(unionBounds(a, null)).toBe(a);
    expect(unionBounds(null, a)).toBe(a);
    expect(unionBounds(null, null)).toBeNull();
  });
});
