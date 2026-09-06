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
          // eslint-disable-next-line jest/valid-expect
          expect(Number.isFinite(len), `${mode}/${view} ${name} is finite`).toBe(true);
          // eslint-disable-next-line jest/valid-expect
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
        // eslint-disable-next-line jest/valid-expect
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

describe('framing — fitting around the floating chrome', () => {
  const CANVAS = { width: 1200, height: 800 };
  const BOX = { min: [0, 0, 0], max: [100, 60, 20] };

  /** Where a world point lands on screen, in pixels from the canvas centre. */
  const screen = (f, p) => {
    const d = [0, 1, 2].map((i) => p[i] - f.target[i]);
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return { x: dot(d, f.right) * f.zoom, y: dot(d, f.up) * f.zoom };
  };

  it('leaves the fit unchanged when nothing is covering the canvas', () => {
    const a = framing('mill', 'top', BOX, CANVAS);
    const b = framing('mill', 'top', BOX, CANVAS, { inset: {} });
    expect(b.zoom).toBeCloseTo(a.zoom, 9);
    expect(b.target).toEqual(a.center);
  });

  it('zooms out to fit what is left, not the whole canvas', () => {
    // The rail covers the top 70 px and the playback bar the bottom 60: fitting
    // to the full height put the geometry under both.
    const plain = framing('mill', 'top', BOX, CANVAS);
    const inset = framing('mill', 'top', BOX, CANVAS, { inset: { top: 70, bottom: 60 } });
    expect(inset.zoom).toBeLessThan(plain.zoom);
  });

  it('centres the geometry in the visible rectangle, not the canvas', () => {
    // A top-only overlay must push the geometry *down*, or a smaller fit is
    // still clipped — only more politely.
    const f = framing('mill', 'top', BOX, CANVAS, { inset: { top: 100 } });
    const centre = screen(f, f.center);
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.y).toBeCloseTo(-50, 6); // half the covered strip, downward
  });

  it('pushes the geometry away from a right-hand panel', () => {
    const f = framing('mill', 'top', BOX, CANVAS, { inset: { right: 200 } });
    expect(screen(f, f.center).x).toBeCloseTo(-100, 6);
  });

  it('keeps every corner of the box inside the visible rectangle', () => {
    const inset = { top: 70, bottom: 60, right: 240 };
    const f = framing('mill', 'top', BOX, CANVAS, { inset });
    const limit = {
      // Pixels from the canvas centre to each edge of the *visible* area.
      right: CANVAS.width / 2 - inset.right,
      left: -CANVAS.width / 2,
      up: CANVAS.height / 2 - inset.top,
      down: -(CANVAS.height / 2 - inset.bottom),
    };
    for (const xi of [0, 1]) {
      for (const yi of [0, 1]) {
        for (const zi of [0, 1]) {
          const p = [xi ? BOX.max[0] : BOX.min[0], yi ? BOX.max[1] : BOX.min[1], zi ? BOX.max[2] : BOX.min[2]];
          const s = screen(f, p);
          // eslint-disable-next-line jest/valid-expect
          expect(s.x, `corner x ${s.x}`).toBeGreaterThanOrEqual(limit.left - 1e-6);
          // eslint-disable-next-line jest/valid-expect
          expect(s.x, `corner x ${s.x}`).toBeLessThanOrEqual(limit.right + 1e-6);
          // eslint-disable-next-line jest/valid-expect
          expect(s.y, `corner y ${s.y}`).toBeGreaterThanOrEqual(limit.down - 1e-6);
          // eslint-disable-next-line jest/valid-expect
          expect(s.y, `corner y ${s.y}`).toBeLessThanOrEqual(limit.up + 1e-6);
        }
      }
    }
  });

  it('refuses to let the chrome squeeze the fit to nothing', () => {
    // A rail taller than the viewport would otherwise drive the zoom to zero.
    const f = framing('mill', 'top', BOX, CANVAS, { inset: { top: 2000, left: 2000 } });
    expect(f.zoom).toBeGreaterThan(0);
    expect(Number.isFinite(f.zoom)).toBe(true);
  });
});
