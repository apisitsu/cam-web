/**
 * Where to draw each sketch relation's symbol — SolidWorks' little relation
 * badges beside the geometry (— | // ⊥ = ◎ …), so what is already tied down is
 * visible without opening the relations list.
 *
 * Pure: `SketchLayer` maps the result onto `<Html>`. One glyph per entity a
 * relation touches, at that entity's midpoint (a line's middle, a curve's top
 * quadrant, two points' midway). Glyphs landing on the same anchor get
 * increasing `slot`s, which the view spreads sideways in screen pixels.
 *
 * Relations that only say "this point is on that" (coincident, point on line or
 * curve) are left out, as SolidWorks does by default: every joined corner has
 * one, and drawing them would bury the sketch.
 */

import { isCurve, curveOf } from './curves.js';

const SYMBOL = {
  horizontal: '—',
  vertical: '|',
  parallel: '//',
  perpendicular: '⊥',
  collinear: '/-/',
  equalLength: '=',
  equalRadius: '=',
  tangent: 'T',
  tangentArc: 'T',
  tangentArcArc: 'T',
  tangentEllipse: 'T',
  tangentSpline: 'T',
  midpoint: 'M',
  symmetric: '><',
  concentric: '◎',
};

export function relationGlyphs(sk) {
  const out = [];
  if (!sk?.constraints) return out;
  const E = (id) => sk.entities.get(id);
  const centreOf = new Map();
  for (const e of sk.entities.values()) {
    if ((e.type === 'circle' || e.type === 'arc') && !centreOf.has(e.center)) centreOf.set(e.center, e.id);
  }
  const anchorOf = (id) => {
    const e = E(id);
    if (!e) return null;
    if (e.type === 'point') return [e.x, e.y];
    if (e.type === 'line') {
      const a = E(e.p1); const b = E(e.p2);
      return a && b ? [(a.x + b.x) / 2, (a.y + b.y) / 2] : null;
    }
    if (isCurve(e)) {
      const c = curveOf(sk, e);
      const k = c ? Math.floor(c.points.length / 4) * 2 : 0;
      return c ? [c.points[k], c.points[k + 1]] : null;
    }
    const c = E(e.center);
    return c ? [c.x, c.y + e.r] : null;
  };
  const used = new Map();
  const push = (ci, kind, pos, key) => {
    if (!pos) return;
    const k = `${Math.round(pos[0] * 1e3)},${Math.round(pos[1] * 1e3)}`;
    const slot = used.get(k) ?? 0;
    used.set(k, slot + 1);
    out.push({ key, ci, kind, text: SYMBOL[kind], pos, slot });
  };

  sk.constraints.forEach((c, ci) => {
    const { kind, refs } = c;
    if (kind === 'horizontal' || kind === 'vertical') {
      // Stored on two points; show it on the line joining them when there is one.
      const line = [...sk.entities.values()].find((e) => e.type === 'line'
        && ((e.p1 === refs[0] && e.p2 === refs[1]) || (e.p1 === refs[1] && e.p2 === refs[0])));
      const a = anchorOf(refs[0]); const b = anchorOf(refs[1]);
      push(ci, kind, line ? anchorOf(line.id) : a && b && [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], `g${ci}`);
      return;
    }
    if (kind === 'coincident') {
      const ca = centreOf.get(refs[0]); const cb = centreOf.get(refs[1]);
      if (ca != null && cb != null) {
        push(ci, 'concentric', anchorOf(ca), `g${ci}a`);
        push(ci, 'concentric', anchorOf(cb), `g${ci}b`);
      }
      return;
    }
    if (!SYMBOL[kind]) return;
    const shown = kind === 'midpoint' ? [refs[0]] : kind === 'symmetric' ? refs.slice(0, 2) : refs;
    shown.forEach((id, i) => push(ci, kind, anchorOf(id), `g${ci}_${i}`));
  });
  return out;
}
