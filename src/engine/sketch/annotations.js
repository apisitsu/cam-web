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
// Hoisted above the file body. It sits next to its re-export further down in
// cam-web, which vite accepts; CRA's eslint config makes `import/first` a build
// error. The re-export stays where it is, with the prose explaining it.
import {
  angleGeometry, axisDimensionGeometry, dimensionLockDir, projectOnto,
} from './edit.js';

const TWO_PI = Math.PI * 2;
const normAngle = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

/** Round a dimension for display — three decimals, no trailing noise. */
export const fmtDim = (v) => String(Math.round(v * 1000) / 1000);

/**
 * Geometry for an axis-locked (distanceX / distanceY) dimension: the on-axis
 * dimension line, the witness lines dropped from each measured point, and where
 * the value sits. Re-exported from `edit.js`, which owns it.
 */
export { axisDimensionGeometry } from './edit.js';

/**
 * Build the annotation geometry for a sketch.
 *
 * @param {object} sk  sketch document
 * @param {{z?:number}} [opts]  z to lift the drawing off the pick plane
 * @returns {{
 *   segs:{key:string,ci:number,pts:number[][]}[],
 *   labels:{key:string,ci:number,pos:number[],text:string}[],
 *   arrows:{key:string,ci:number,pos:number[],dir:number[],span:number|null}[],
 * }} an arrow's tip is at `pos`, pointing along `dir`; `span` is the length of the
 *   dimension line it ends, null when it is the only arrow on it
 */
export function dimensionAnnotations(sk, { z: Z = 0 } = {}) {
  const P = (id) => sk?.entities?.get(id);
  const segs = [];
  const labels = [];
  const arrows = [];
  let k = 0;
  if (!sk?.constraints) return { segs, labels, arrows };

  const arrow = (pos, dir, span = null) => arrows.push({
    key: `a${k++}`, pos, dir, span,
  });
  /** A dimension line's two arrows, each pointing out at the end it stops on. */
  const arrowsOn = (p, q) => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 1e-9) return;
    const u = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
    arrow(p, [-u[0], -u[1]], len);
    arrow(q, u, len);
  };

  sk.constraints.forEach((c, ci) => {
    if (c.value == null) return;

    // The operator can drag a placed dimension to a clearer spot; the offset is
    // stored on the constraint (in sketch units) and round-trips through the
    // project file for free (`model.serialize` spreads the constraint). It is
    // **locked to the dimension's own axis** (`dimensionLockDir`) — a horizontal
    // dimension only slides its standoff up and down, a radius only in and out
    // along its leader — so the line and the value move as one and the value
    // stays centred on the line. Witness lines still start on the geometry and
    // stretch out to meet it, SolidWorks-style.
    const [ox, oy] = projectOnto(
      Array.isArray(c.labelOffset) ? c.labelOffset : [0, 0],
      dimensionLockDir(sk, c.kind, c.refs),
    );
    const segStart = segs.length; // tag every seg this constraint pushes with `ci` below
    const arrowStart = arrows.length;

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
      const a2 = [a.x + px * off + ox, a.y + py * off + oy, Z];
      const b2 = [b.x + px * off + ox, b.y + py * off + oy, Z];
      segs.push({ key: `s${k++}`, pts: [[a.x, a.y, Z], a2] }); // witness lines
      segs.push({ key: `s${k++}`, pts: [[b.x, b.y, Z], b2] });
      segs.push({ key: `s${k++}`, pts: [a2, b2] }); // dimension line
      arrowsOn(a2, b2);
      labels.push({
        key: `b${k++}`, ci, text: fmtDim(c.value),
        pos: [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2, Z],
      });
    } else if (c.kind === 'distanceX' || c.kind === 'distanceY') {
      const g = axisDimensionGeometry(sk, c.kind, c.refs);
      if (!g) return;
      const onGeom = (p) => [p.x, p.y, Z];
      const moved = (p) => [p.x + ox, p.y + oy, Z];
      // Each witness runs from its point on the geometry (fixed) to the moved
      // dimension line.
      for (const w of g.witness) segs.push({ key: `s${k++}`, pts: [onGeom(w[0]), moved(w[1])] });
      segs.push({ key: `s${k++}`, pts: g.line.map(moved) }); // dimension line, on-axis
      arrowsOn(moved(g.line[0]), moved(g.line[1]));
      // The stored value is signed (planegcs `difference`); a dimension reads as
      // a magnitude.
      labels.push({ key: `b${k++}`, ci, pos: moved(g.label), text: fmtDim(Math.abs(c.value)) });
    } else if (c.kind === 'pointLineDistance') {
      // The actual perpendicular, point → its foot on the line, moved clear as a
      // whole, with a witness at each end back to what it measures: the point, and
      // the nearest part of the line, which is an end when the foot lands past it.
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
      const from = [p.x + ox, p.y + oy, Z];
      const foot = [fx + ox, fy + oy, Z];
      segs.push({ key: `s${k++}`, pts: [from, foot] });
      arrowsOn(from, foot);
      const anchor = t < 0 ? a : t > 1 ? b : { x: fx, y: fy };
      for (const [end, tip] of [[p, from], [anchor, foot]]) {
        if (Math.hypot(end.x - tip[0], end.y - tip[1]) > 1e-9) segs.push({ key: `s${k++}`, pts: [[end.x, end.y, Z], tip] });
      }
      labels.push({
        key: `b${k++}`, ci, text: fmtDim(c.value),
        pos: [(p.x + fx) / 2 + ox, (p.y + fy) / 2 + oy, Z],
      });
    } else if (c.kind === 'radius') {
      const circ = P(c.refs[0]);
      const ctr = circ && P(circ.center);
      if (!ctr) return;
      const u = Math.SQRT1_2;
      const rim = [ctr.x + u * circ.r, ctr.y + u * circ.r, Z];
      const at = [ctr.x + u * circ.r * 0.5 + ox, ctr.y + u * circ.r * 0.5 + oy, Z];
      segs.push({ key: `s${k++}`, pts: [[ctr.x, ctr.y, Z], rim] });
      if (ox || oy) segs.push({ key: `s${k++}`, pts: [rim, at] });
      arrow(rim, [u, u]);
      labels.push({
        key: `b${k++}`, ci, text: `R${fmtDim(c.value)}`, pos: at,
      });
    } else if (c.kind === 'ellipseMinor') {
      // A spoke from the centre out along the minor axis.
      const el = P(c.refs[0]);
      const ctr = el && P(el.center);
      const m = el && P(el.major);
      if (!ctr || !m) return;
      const ra = Math.hypot(m.x - ctr.x, m.y - ctr.y) || 1;
      const vx = -(m.y - ctr.y) / ra; const vy = (m.x - ctr.x) / ra;
      const rim = [ctr.x + vx * el.rb, ctr.y + vy * el.rb, Z];
      segs.push({ key: `s${k++}`, pts: [[ctr.x, ctr.y, Z], rim] });
      if (ox || oy) segs.push({ key: `s${k++}`, pts: [rim, [rim[0] + ox, rim[1] + oy, Z]] });
      arrow(rim, [vx, vy]);
      labels.push({
        key: `b${k++}`, ci, text: `R${fmtDim(c.value)}`,
        pos: [ctr.x + vx * el.rb * 0.5 + ox, ctr.y + vy * el.rb * 0.5 + oy, Z],
      });
    } else if (c.kind === 'diameter') {
      const circ = P(c.refs[0]);
      const ctr = circ && P(circ.center);
      if (!ctr) return;
      // 45° diameter line, tidy and unambiguous. SQRT1_2 rather than a truncated
      // 0.7071, which drew the line a fifth of a micron short of the diameter.
      // The line stays a true chord **through the centre** — dragging must not
      // pull it off the circle. What moves is a leader from the rim out to the
      // value (SolidWorks' diameter-with-leader), locked to the 45° direction.
      const u = Math.SQRT1_2;
      const rim = [ctr.x + u * circ.r, ctr.y + u * circ.r, Z];
      const farRim = [ctr.x - u * circ.r, ctr.y - u * circ.r, Z];
      segs.push({ key: `s${k++}`, pts: [farRim, rim] });
      arrowsOn(farRim, rim);
      // At rest the value sits on the chord, clear of the arrow at the rim.
      const at = [ctr.x + u * circ.r * 0.5 + ox, ctr.y + u * circ.r * 0.5 + oy, Z];
      if (ox || oy) segs.push({ key: `s${k++}`, pts: [rim, at] });
      labels.push({ key: `b${k++}`, ci, text: `Ø${fmtDim(c.value)}`, pos: at });
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
      // The spoke runs centre to rim, where its arrow is; a leader goes on to the
      // value once that has been moved along it.
      segs.push({ key: `s${k++}`, pts: [[ctr.x, ctr.y, Z], [rx, ry, Z]] });
      if (ox || oy) segs.push({ key: `s${k++}`, pts: [[rx, ry, Z], [rx + ox, ry + oy, Z]] });
      arrow([rx, ry, Z], [Math.cos(mid), Math.sin(mid)]);
      labels.push({
        key: `b${k++}`, ci, text: `R${fmtDim(c.value)}`,
        pos: [(ctr.x + rx) / 2 + ox, (ctr.y + ry) / 2 + oy, Z],
      });
    } else if (c.kind === 'angle') {
      // An arc about the vertex from one line to the other. Dragging changes its
      // radius; past where a line is drawn, a witness carries the line out to it.
      const g = angleGeometry(sk, c.refs[0], c.refs[1]);
      if (!g) return;
      const { v, rays, sweep: d } = g;
      const a1 = rays[0].angle;
      const mid = a1 + d / 2;
      const rest = Math.max(3, Math.min(Math.min(rays[0].far, rays[1].far) * 0.4, 14));
      const r = Math.max(2, rest + ox * Math.cos(mid) + oy * Math.sin(mid));
      const at = (a, rad) => [v.x + rad * Math.cos(a), v.y + rad * Math.sin(a), Z];
      const N = 24;
      const pts = [];
      for (let i = 0; i <= N; i++) pts.push(at(a1 + (d * i) / N, r));
      segs.push({ key: `s${k++}`, pts });
      for (const ray of rays) {
        if (r < ray.near) segs.push({ key: `s${k++}`, pts: [at(ray.angle, ray.near), at(ray.angle, r)] });
        else if (r > ray.far) segs.push({ key: `s${k++}`, pts: [at(ray.angle, ray.far), at(ray.angle, r)] });
      }
      const turn = Math.sign(d) || 1;
      const a2 = a1 + d;
      const span = r * Math.abs(d);
      arrow(at(a1, r), [turn * Math.sin(a1), -turn * Math.cos(a1)], span);
      arrow(at(a2, r), [-turn * Math.sin(a2), turn * Math.cos(a2)], span);
      // The interior corner angle actually swept, so a 60° corner reads 60° and
      // not the 120° directed angle planegcs stores.
      labels.push({
        key: `b${k++}`, ci, text: `${fmtDim((Math.abs(d) * 180) / Math.PI)}°`, pos: at(mid, r),
      });
    } else if (c.kind === 'lockX' || c.kind === 'lockY') {
      const p = P(c.refs[0]);
      if (!p) return;
      const dyOff = c.kind === 'lockY' ? 2 : -2;
      labels.push({
        key: `b${k++}`, ci, text: `${c.kind === 'lockX' ? 'X' : 'Y'}${fmtDim(c.value)}`,
        pos: [p.x + 1.6 + ox, p.y + dyOff + oy, Z],
      });
    }
    for (let s = segStart; s < segs.length; s += 1) segs[s].ci = ci;
    for (let a = arrowStart; a < arrows.length; a += 1) arrows[a].ci = ci;
  });

  return { segs, labels, arrows };
}
