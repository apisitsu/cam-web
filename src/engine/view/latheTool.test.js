import { describe, it, expect } from 'vitest';
import {
  odHolderGeometry, boringBarGeometry, partingBladeGeometry, markerYSpan, toolScale,
} from './latheTool.js';
import { STANDARD_TURN_TOOLS } from '../sim/turning.js';

describe('every lathe marker cuts on the spindle centre plane', () => {
  // The regression: the OD insert was mounted on the holder's side face and sat
  // entirely at positive Y — 1 to 5 mm clear of the plane where the cut happens.
  it.each(STANDARD_TURN_TOOLS.map((t) => [t.id, t]))('%s has its cutting corner at Y=0', (_id, tool) => {
    const [lo, hi] = markerYSpan(tool.kind, 1.6, tool);
    expect(hi).toBe(0);
    expect(lo).toBeLessThan(0);
  });

  it('hangs the OD holder below the plane, never above it', () => {
    const g = odHolderGeometry(1.6, { sides: 4, angle: 35, lead: 93 });
    expect(g.depth).toBeGreaterThan(0);
    // Insert body spans [insertY − thickY/2, insertY + thickY/2]; its top is the
    // rake face and must land exactly on Y=0.
    const { thickY } = toolScale(1.6);
    expect(g.insertY + thickY / 2).toBeCloseTo(0, 12);
    expect(g.insertY - thickY / 2).toBeLessThan(0);
  });

  it('lets only the clamp screw stand proud of the rake face', () => {
    const g = odHolderGeometry(1.6, {});
    // A screw head sits above the face by design; nothing else may.
    expect(g.screwY + g.screwH / 2).toBeGreaterThan(0);
    expect(g.screwY - g.screwH / 2).toBeLessThan(0);
  });

  it('puts the boring bar under the plane too, with its insert on it', () => {
    const g = boringBarGeometry(1.6, {});
    expect(g.barY + g.barRadius).toBeCloseTo(0, 12);
    expect(g.insertY + g.insert.thickY / 2).toBeCloseTo(0, 12);
  });

  it('puts the parting blade under the plane', () => {
    const g = partingBladeGeometry(1.6, { grooveW: 3 });
    expect(g.bladeY + g.depth / 2).toBeCloseTo(0, 12);
    expect(g.tipY + (g.depth * 1.02) / 2).toBeCloseTo(0, 12);
  });
});

describe('OD holder silhouette', () => {
  it('starts at the tip, which is the tool position', () => {
    expect(odHolderGeometry(1.6, {}).outline[0]).toEqual([0, 0]);
  });

  it('reads as one family: same shank width and height for every insert angle', () => {
    const widths = new Set();
    const heights = new Set();
    for (const angle of [35, 55, 80]) {
      const g = odHolderGeometry(1.6, { sides: 4, angle, lead: 93, flip: true });
      widths.add(g.shankWidth.toFixed(6));
      heights.add(g.height.toFixed(6));
    }
    expect(widths.size).toBe(1);
    expect(heights.size).toBe(1);
  });

  it('produces a finite, non-degenerate outline for every standard tool', () => {
    for (const tool of STANDARD_TURN_TOOLS) {
      const g = odHolderGeometry(1.6, tool);
      expect(g.outline).toHaveLength(5);
      for (const [x, z] of g.outline) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(z)).toBe(true);
      }
      // The head must have real height, or the wedge collapses.
      expect(g.outline[1][0]).toBeGreaterThan(0);
      expect(g.height).toBeGreaterThan(g.outline[1][0]);
    }
  });

  it('mirrors the insert when the holder is flipped', () => {
    const a = odHolderGeometry(1.6, { sides: 4, angle: 35, lead: 93, flip: false });
    const b = odHolderGeometry(1.6, { sides: 4, angle: 35, lead: 93, flip: true });
    expect(Math.sign(a.insert.rot)).toBe(-Math.sign(b.insert.rot));
  });

  it('scales with the marker radius', () => {
    const small = odHolderGeometry(0.5, {});
    const big = odHolderGeometry(3, {});
    expect(big.height).toBeGreaterThan(small.height);
    expect(big.depth).toBeGreaterThan(small.depth);
  });
});
