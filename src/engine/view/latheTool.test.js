import { describe, it, expect } from 'vitest';
import {
  odHolderGeometry, boringBarGeometry, partingBladeGeometry, drillGeometry,
  markerYSpan, toolScale, offerToolToggle,
} from './latheTool.js';
import { STANDARD_TURN_TOOLS } from '../sim/turning.js';

describe('every lathe marker cuts on the spindle centre plane', () => {
  // The regression: the OD insert was mounted on the holder's side face and sat
  // entirely at positive Y — 1 to 5 mm clear of the plane where the cut happens.
  //
  // `boring` is the one exception, and deliberately so: its bar is centred
  // on Y=0 (matching the stock, which is centred on the same spindle axis —
  // see `boringBarGeometry`'s header), so its crown reaches *above* Y=0
  // rather than stopping there. Its insert still keeps the Y=0 invariant.
  it.each(STANDARD_TURN_TOOLS.map((t) => [t.id, t]))('%s has its cutting corner at Y=0', (_id, tool) => {
    const [lo, hi] = markerYSpan(tool.kind, 1.6, tool);
    if (tool.kind === 'boring') {
      expect(hi).toBeGreaterThan(0);
    } else {
      expect(hi).toBe(0);
    }
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

  it("centres the boring bar on the spindle axis, matching the stock", () => {
    // Not a `standout`-clear of the cutting plane the way every other
    // marker's body is: the bar is centred on Y=0 exactly, since that's the
    // axis the stock itself is centred on too (see boringBarGeometry's
    // header for the visible-stock regression this fixed).
    const g = boringBarGeometry(1.6, {});
    expect(g.barY).toBe(0);
  });

  it('keeps the boring insert at Y=0, the same invariant every marker here keeps', () => {
    // A centring pass once moved this insert to the bar's own axis instead,
    // which left it sitting well clear of the stock's own centre (the stock
    // is centred on Y=0, same as every other marker's insert) once the
    // stock was visible alongside it. `Viewport.jsx` still draws it with
    // `depthTest: false` + a higher `renderOrder`, now because the bar's
    // *own* crown reaches above Y=0 (see the previous test) and would
    // otherwise occlude the insert in Top view.
    const g = boringBarGeometry(1.6, {});
    const { thickY } = toolScale(1.6);
    expect(g.insertY).toBeCloseTo(-thickY / 2, 12);
    expect(g.insertY + g.insert.thickY / 2).toBeCloseTo(0, 12);
  });

  it("lands the insert's real cutting-corner vertex on (0, 0) in X/Z, for a triangular insert as much as a diamond one, tilted or not", () => {
    // The regression this guards: a later attempt solved the insert's own Z
    // so its *near* corner (the one facing the bar) landed exactly on the
    // bar's face, no wedge needed. That corner's natural distance from the
    // tip runs to several units — not a small margin — so solving for it
    // dragged the tip itself off the programmed cutting position by that
    // same several units, in the wrong direction, for every tilt including
    // zero. The tip must stay pinned at the world origin regardless of
    // `insertTilt`; `boringConnectorWedge` is what makes the near corner
    // read as flush with the bar without moving the insert to do it.
    for (const [sides, angle, insertTilt] of [[4, 35, 0], [3, 60, 0], [4, 35, -35], [3, 60, 20]]) {
      const g = boringBarGeometry(1.6, { sides, angle, insertTilt });
      const { insert } = g;
      const rot = insert.rot;
      const x = insert.x + (0 * Math.cos(rot) + insert.r * insert.zScale * Math.sin(rot));
      const z = insert.z + (-0 * Math.sin(rot) + insert.r * insert.zScale * Math.cos(rot));
      expect(x).toBeCloseTo(0, 9);
      expect(z).toBeCloseTo(0, 9);
    }
  });

  it("mounts the insert on its own axis of symmetry, so its base is parallel to Z (not a diagonal lean)", () => {
    // The regression: two earlier fixes both pinned a *real* vertex to the
    // tip, but neither was guaranteed to be the insert's own symmetry axis
    // — a vertex off that axis makes the two flanks either side of the
    // point unequal lengths/angles on screen, reading as a skewed insert
    // even though its tip sits correctly at (0, 0). `zScale` only scales
    // local Z, so only the vertex that already sits ON local Z (index 0)
    // keeps its own mirror symmetry after that scale; every other vertex's
    // line is off-axis and the anisotropic scale breaks symmetry about it.
    // A threading insert's real cutting edges are each other's mirror
    // image about that axis, so this is what "looks right", not a 4-sided
    // convention (the old 45°/−45°) being carried over onto a triangle.
    for (const [sides, angle] of [[4, 35], [3, 60]]) {
      const g = boringBarGeometry(1.6, { sides, angle });
      const { insert } = g;
      const worldOf = (i) => {
        const theta = (i / sides) * 2 * Math.PI;
        const lx = insert.r * Math.sin(theta);
        const lz = insert.r * Math.cos(theta) * insert.zScale;
        return {
          x: insert.x + (lx * Math.cos(insert.rot) + lz * Math.sin(insert.rot)),
          z: insert.z + (-lx * Math.sin(insert.rot) + lz * Math.cos(insert.rot)),
        };
      };
      const tip = worldOf(0);
      expect(tip.x).toBeCloseTo(0, 9);
      expect(tip.z).toBeCloseTo(0, 9);
      // Every other vertex has a mirror partner (index `sides - i`) at the
      // same X, opposite Z — the "base parallel to Z" the insert's own
      // shape guarantees once it's mounted on its true symmetry axis.
      for (let i = 1; i < sides; i++) {
        const a = worldOf(i);
        const b = worldOf(sides - i);
        expect(b.x).toBeCloseTo(a.x, 9);
        expect(b.z).toBeCloseTo(-a.z, 9);
      }
    }
  });

  it('bridges the insert to the bar with the connector wedge, tip to near corner to the bar face — untilted only', () => {
    // The wedge is what makes the near corner read as flush with the bar's
    // face without moving the insert off the tip-at-origin invariant (see
    // the test above). Its first point must be the insert's own tip — not
    // an assumed (0, 0), so it stays correct if the tip invariant ever
    // changes — and its last point must sit on the bar's own face.
    for (const [sides, angle] of [[4, 35], [3, 60]]) {
      const g = boringBarGeometry(1.6, { sides, angle });
      const [tipPt, , barPt] = g.connectorWedge.points;
      expect(tipPt[0]).toBeCloseTo(0, 9);
      expect(tipPt[1]).toBeCloseTo(0, 9);
      expect(barPt[1]).toBeCloseTo(g.barNearZ, 12);
    }
  });

  it('skips the connector wedge for a tilted mount, rather than drawing an oversized one', () => {
    // The regression: the wedge's far corner is a *real* insert vertex,
    // which (being a rigid rotation about the pinned tip) swings out to an
    // X several units from the tip's own as soon as a real tilt is applied
    // — far enough that the "small" triangle became a second, wide, flat
    // face roughly the insert's own size, sitting in open air in front of
    // the bar rather than hidden inside it. It read as a slab of excess bar
    // material. There is no tilt-aware bend of this triangle that stays a
    // thin sliver, so a tilted mount gets no wedge at all.
    const g = boringBarGeometry(1.6, { sides: 4, angle: 35, insertTilt: -35 });
    expect(g.connectorWedge).toBeNull();
  });

  it('puts the parting blade under the plane', () => {
    const { standout } = toolScale(1.6);
    const g = partingBladeGeometry(1.6, { grooveW: 3 });
    // Same again: the cutting tip is on the plane, the blade behind it is not.
    expect(g.tipY + (g.depth * 1.02) / 2).toBeCloseTo(0, 12);
    expect(g.bladeY + g.depth / 2).toBeCloseTo(-standout, 12);
  });

  it('draws its width true to scale with grooveW — the bug this exists for', () => {
    // `width` is the one real, measured dimension here: it is the kerf,
    // and `turningGrooveWidthResolver` carves exactly this many mm wide.
    // Running it through `toolScale()`'s proportional blow-up (as every
    // other dimension here still is) drew a groove narrower than the one
    // actually cut, whatever the marker radius.
    expect(partingBladeGeometry(1.6, { grooveW: 3 }).width).toBeCloseTo(3, 6);
    expect(partingBladeGeometry(1.6, { grooveW: 4.5 }).width).toBeCloseTo(4.5, 6);
    expect(partingBladeGeometry(0.8, {}).width).toBeCloseTo(3, 6); // default
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

  it('produces a finite, non-degenerate outline for every tool actually drawn with it', () => {
    // Only 'od' (and, loosely, 'boring' — its own geometry doesn't share this
    // math, but its angles happen to live in the same safe range) ever reach
    // odHolderGeometry in the real app; `LatheTool` routes 'drill' to
    // `drillGeometry` instead. A 'drill' entry's angle is a literal tool
    // angle (118° for a twist drill) and is *expected* to be unsafe here —
    // see the catalogue's own comment — so it is deliberately excluded
    // rather than constraining real drill angles to stay odHolderGeometry-safe.
    for (const tool of STANDARD_TURN_TOOLS.filter((t) => t.kind !== 'drill')) {
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

describe('drillGeometry — a coaxial axial tool, not a boring bar', () => {
  it('stays on the spindle axis: nothing here is offset in X the way a boring bar is', () => {
    // drillGeometry itself never returns an X offset — the marker's tip and
    // shaft are both built centred on X=0 in Viewport.jsx. This is the
    // property that distinguishes it from boringBarGeometry, whose insert
    // and bar are both deliberately shifted sideways.
    const g = drillGeometry(1.6, { angle: 118 });
    expect(g).not.toHaveProperty('barRadius'); // not a boring bar in disguise
    expect(g.shaftRadius).toBeGreaterThan(0);
  });

  it('does not go singular as the angle passes 90°, unlike odHolderGeometry', () => {
    // The whole reason this shape exists instead of reusing the OD/boring
    // one: a real twist drill is ~118°, which drove odHolderGeometry's head
    // height to blow up (see the catalogue's own comment on this).
    for (const angle of [45, 90, 118, 150]) {
      const g = drillGeometry(1.6, { angle });
      expect(Number.isFinite(g.tipHeight)).toBe(true);
      expect(g.tipHeight).toBeGreaterThan(0);
    }
  });

  it('a wider included angle makes a shorter, blunter tip', () => {
    const sharp = drillGeometry(1.6, { angle: 45 });
    const blunt = drillGeometry(1.6, { angle: 118 });
    expect(blunt.tipHeight).toBeLessThan(sharp.tipHeight);
  });

  it('scales with the marker radius', () => {
    const small = drillGeometry(0.5, { angle: 118 });
    const big = drillGeometry(3, { angle: 118 });
    expect(big.shaftRadius).toBeGreaterThan(small.shaftRadius);
    expect(big.shaftLength).toBeGreaterThan(small.shaftLength);
  });

  it('draws true to scale — the bug this exists for', () => {
    // Unlike the OD/boring/parting markers, which run `radius` through
    // `toolScale()`'s proportional blow-up, a drill's radius *is* the hole
    // it cuts: `turningCutRadiusResolver` carves this exact number. A
    // decorated shaft drew visibly narrower than the bore around it (a
    // ⌀8.5 drill's bore reaches 4.25, but the old formula drew a ⌀1.8 bit).
    expect(drillGeometry(4.25, { angle: 118 }).shaftRadius).toBeCloseTo(4.25, 6);
    expect(drillGeometry(0.8, { angle: 118 }).shaftRadius).toBeCloseTo(0.8, 6);
  });

  it('markerYSpan reaches exactly 0 — the apex, which needs no standout of its own', () => {
    const [lo, hi] = markerYSpan('drill', 1.6, { angle: 118 });
    expect(hi).toBe(0);
    expect(lo).toBeLessThan(0);
  });
});

describe('offerToolToggle', () => {
  it('is offered for turning', () => {
    expect(offerToolToggle({ mode: 'turn' })).toBe(true);
  });

  it('is withheld for milling — that is what the arbor toggle is for', () => {
    expect(offerToolToggle({ mode: 'mill' })).toBe(false);
  });

  it('is withheld on the sketch page, where there is no tool', () => {
    expect(offerToolToggle({ mode: 'turn', sketching: true })).toBe(false);
  });
});
