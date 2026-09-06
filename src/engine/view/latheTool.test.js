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

  it('seats the OD holder body under the rake face rather than flush with it', () => {
    // Flush meant coplanar, and coplanar meant the insert and the holder took
    // turns winning the depth test — the tool flickered gold/grey as it moved.
    const { thickY, standout } = toolScale(1.6);
    const g = odHolderGeometry(1.6, { sides: 4, angle: 35, lead: 93 });
    expect(standout).toBeGreaterThan(0);
    expect(g.bodyY).toBe(-standout);
    // Still an insert seated in a pocket, not one balanced on top of the holder.
    expect(standout).toBeLessThan(thickY / 2);
  });

  it('sets the holder back from the cutting corner, so only the insert reaches it', () => {
    // The head's walls run along the insert's two edges. Left at the tip they
    // were coplanar with the insert's flanks for the whole height of the head.
    const { standout } = toolScale(1.6);
    const g = odHolderGeometry(1.6, { sides: 4, angle: 35, lead: 93 });
    for (const [x] of g.outline) expect(x).toBeGreaterThanOrEqual(standout - 1e-9);
  });

  it('lets only the clamp screw stand proud of the rake face', () => {
    const g = odHolderGeometry(1.6, {});
    // A screw head sits above the face by design; nothing else may.
    expect(g.screwY + g.screwH / 2).toBeGreaterThan(0);
    expect(g.screwY - g.screwH / 2).toBeLessThan(0);
  });

  it('puts the boring bar under the plane too, with its insert on it', () => {
    const { standout } = toolScale(1.6);
    const g = boringBarGeometry(1.6, {});
    // The insert reaches the plane; the bar's crown clears it, so the two are
    // not tangent along a line the depth buffer would have to arbitrate.
    expect(g.insertY + g.insert.thickY / 2).toBeCloseTo(0, 12);
    expect(g.barY + g.barRadius).toBeCloseTo(-standout, 12);
  });

  it('puts the parting blade under the plane', () => {
    const { standout } = toolScale(1.6);
    const g = partingBladeGeometry(1.6, { grooveW: 3 });
    // Same again: the cutting tip is on the plane, the blade behind it is not.
    expect(g.tipY + (g.depth * 1.02) / 2).toBeCloseTo(0, 12);
    expect(g.bladeY + g.depth / 2).toBeCloseTo(-standout, 12);
  });
});

describe('OD holder silhouette', () => {
  it('starts on the tool position\'s own line, a hair back from the corner', () => {
    // The apex is on Z=0 — the holder is still pointed at the cutting corner and
    // not offset sideways — but it stops `standout` short of it, leaving the
    // corner to the insert.
    const g = odHolderGeometry(1.6, {});
    expect(g.outline[0]).toEqual([toolScale(1.6).standout, 0]);
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
