/**
 * On-canvas dimension annotations: the lines and labels drawn for every
 * constraint that carries a value, so you can see what is already sized.
 *
 * Pure — `SketchLayer` only maps the result onto drei `<Line>` and `<Html>`.
 * This is the densest piece of geometry in the view layer (nine constraint kinds,
 * each with its own witness-line convention), and none of it needs a renderer to
 * be checked: a distance dimension either stands its line off the geometry or it
 * doesn't.
 *
 * Non-dimensional constraints (horizontal, coincident, …) are not drawn: they
 * remove DOF but aren't "sizes".
 */

const TWO_PI = Math.PI * 2;
const normAngle = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

/** Round a dimension for display — two decimals, no trailing noise. */
export const fmtDim = (v) => String(Math.round(v * 100) / 100);

/**
 * Geometry for an axis-locked (distanceX / distanceY) dimension: the on-axis
 * dimension line, the witness lines dropped from each measured point, and where
 * the value sits. Re-exported from `edit.js`, which owns it.
 */
export { axisDimensionGeometry } from './edit.js';
import { axisDimensionGeometry } from './edit.js';

/**
 * Build the annotation geometry for a sketch.
 *
 * @param {object} sk  sketch document
 * @param {{z?:number}} [opts]  z to lift the drawing off the pick plane
 * @returns {{segs:{key:string,pts:number[][]}[], labels:{key:string,ci:number,pos:number[],text:string}[]}}
 */
export function dimensionAnnotations(sk, { z: Z = 0 } = {}) {
  const P = (id) => sk?.entities?.get(id);
  const segs = [];
  const labels = [];
  let k = 0;
  if (!sk?.constraints) return { segs, labels };

  sk.constraints.forEach((c, ci) => {
    if (c.value == null) return;

    if (c.kind === 'distance') {
      const a = P(c.refs[0]);
      const b = P(c.refs[1]);
      if (!a || !b) return;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const px = -dy / len;
      const py = dx / len;
      const off = Math.max(len * 0.14, 4); // stand the dimension line off the geometry
      const a2 = [a.x + px * off, a.y + py * off, Z];
      const b2 = [b.x + px * off, b.y + py * off, Z];
      segs.push({ key: `s${k++}`, pts: [[a.x, a.y, Z], a2] }); // witness lines
      segs.push({ key: `s${k++}`, pts: [[b.x, b.y, Z], b2] });
      segs.push({ key: `s${k++}`, pts: [a2, b2] }); // dimension line
      labels.push({
        key: `b${k++}`, ci, text: fmtDim(c.value),
        pos: [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2, Z],
      });
    } else if (c.kind === 'distanceX' || c.kind === 'distanceY') {
      const g = axisDimensionGeometry(sk, c.kind, c.refs);
      if (!g) return;
      const xyz = (p) => [p.x, p.y, Z];
      for (const w of g.witness) segs.push({ key: `s${k++}`, pts: w.map(xyz) });
      segs.push({ key: `s${k++}`, pts: g.line.map(xyz) }); // dimension line, on-axis
      // The stored value is signed (planegcs `difference`); a dimension reads as
      // a magnitude.
      labels.push({ key: `b${k++}`, ci, pos: xyz(g.label), text: fmtDim(Math.abs(c.value)) });
    } else if (c.kind === 'pointLineDistance') {
      // The actual perpendicular: point → its foot on the line, with a witness
      // along the line when the foot lands past the drawn segment (the common
      // parallel-gap case).
      const p = P(c.refs[0]);
      const l = P(c.refs[1]);
      const a = l && P(l.p1);
      const b = l && P(l.p2);
      if (!p || !a || !b) return;
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const len2 = abx * abx + aby * aby || 1;
      const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
      const fx = a.x + abx * t;
      const fy = a.y + aby * t;
      segs.push({ key: `s${k++}`, pts: [[p.x, p.y, Z], [fx, fy, Z]] });
      if (t < 0 || t > 1) {
        const nearEnd = t < 0 ? a : b;
        segs.push({ key: `s${k++}`, pts: [[nearEnd.x, nearEnd.y, Z], [fx, fy, Z]] });
      }
      labels.push({
        key: `b${k++}`, ci, text: fmtDim(c.value),
        pos: [(p.x + fx) / 2, (p.y + fy) / 2, Z],
      });
    } else if (c.kind === 'radius') {
      const circ = P(c.refs[0]);
      const ctr = circ && P(circ.center);
      if (!ctr) return;
      labels.push({
        key: `b${k++}`, ci, text: `R${fmtDim(c.value)}`,
        pos: [ctr.x + circ.r * 0.7, ctr.y + circ.r * 0.7, Z],
      });
    } else if (c.kind === 'diameter') {
      const circ = P(c.refs[0]);
      const ctr = circ && P(circ.center);
      if (!ctr) return;
      // 45° diameter line, tidy and unambiguous. SQRT1_2 rather than a truncated
      // 0.7071, which drew the line a fifth of a micron short of the diameter.
      const u = Math.SQRT1_2;
      segs.push({
        key: `s${k++}`,
        pts: [
          [ctr.x - u * circ.r, ctr.y - u * circ.r, Z],
          [ctr.x + u * circ.r, ctr.y + u * circ.r, Z],
        ],
      });
      labels.push({
        key: `b${k++}`, ci, text: `Ø${fmtDim(c.value)}`,
        pos: [ctr.x + u * circ.r * 0.5, ctr.y + u * circ.r * 0.5, Z],
      });
    } else if (c.kind === 'arcRadius') {
      // A spoke from the centre to the arc's midpoint plus an R label at the rim,
      // so it reads as a radius rather than a diameter.
      const arc = P(c.refs[0]);
      const ctr = arc && P(arc.center);
      const s = arc && P(arc.start);
      const en = arc && P(arc.end);
      if (!ctr || !s || !en) return;
      const a0 = Math.atan2(s.y - ctr.y, s.x - ctr.x);
      const mid = a0 + (normAngle(Math.atan2(en.y - ctr.y, en.x - ctr.x) - a0) || TWO_PI) / 2;
      const rx = ctr.x + arc.r * Math.cos(mid);
      const ry = ctr.y + arc.r * Math.sin(mid);
      segs.push({ key: `s${k++}`, pts: [[ctr.x, ctr.y, Z], [rx, ry, Z]] });
      labels.push({
        key: `b${k++}`, ci, text: `R${fmtDim(c.value)}`,
        pos: [(ctr.x + rx) / 2, (ctr.y + ry) / 2, Z],
      });
    } else if (c.kind === 'angle') {
      // An arc swept between the two legs around their shared vertex, so a 2-line
      // angle dimension reads like a real angle rather than a bare number.
      const l1 = P(c.refs[0]);
      const l2 = P(c.refs[1]);
      if (!l1 || !l2) return;
      const sharedId = [l1.p1, l1.p2].find((id) => id === l2.p1 || id === l2.p2);
      const vId = sharedId != null ? sharedId : l1.p1;
      const v = P(vId);
      const f1 = P(l1.p1 === vId ? l1.p2 : l1.p1);
      const f2 = P(l2.p1 === vId ? l2.p2 : l2.p1);
      if (!v || !f1 || !f2) return;
      const a1 = Math.atan2(f1.y - v.y, f1.x - v.x);
      const a2 = Math.atan2(f2.y - v.y, f2.x - v.x);
      const legMin = Math.min(
        Math.hypot(f1.x - v.x, f1.y - v.y),
        Math.hypot(f2.x - v.x, f2.y - v.y),
      );
      const r = Math.max(3, Math.min(legMin * 0.4, 14));
      let d = a2 - a1; // sweep the shorter way between the legs
      while (d > Math.PI) d -= TWO_PI;
      while (d < -Math.PI) d += TWO_PI;
      const N = 24;
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const a = a1 + (d * i) / N;
        pts.push([v.x + r * Math.cos(a), v.y + r * Math.sin(a), Z]);
      }
      segs.push({ key: `s${k++}`, pts });
      const mid = a1 + d / 2;
      // Label the *interior* corner angle actually swept, so a 60° corner reads
      // 60° and not the 120° directed angle planegcs stores.
      labels.push({
        key: `b${k++}`, ci, text: `${fmtDim((Math.abs(d) * 180) / Math.PI)}°`,
        pos: [v.x + (r + 2) * Math.cos(mid), v.y + (r + 2) * Math.sin(mid), Z],
      });
    } else if (c.kind === 'lockX' || c.kind === 'lockY') {
      const p = P(c.refs[0]);
      if (!p) return;
      const dyOff = c.kind === 'lockY' ? 2 : -2;
      labels.push({
        key: `b${k++}`, ci, text: `${c.kind === 'lockX' ? 'X' : 'Y'}${fmtDim(c.value)}`,
        pos: [p.x + 1.6, p.y + dyOff, Z],
      });
    }
  });

  return { segs, labels };
}
