/**
 * A sketch as strokes for a cutter to follow — engraving.
 *
 * Every line, arc and circle that is not construction becomes part of a
 * polyline; lines and arcs that meet end to end are chained so the cutter does
 * not lift between them. Unlike `sketchRegions` nothing has to close: a letter
 * "T" is two strokes, not a failed profile.
 *
 * Pure: the sketch document only.
 */
import { tessellateArc } from './loops.js';

const key = (x, y) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;

/** Each drawable entity as a polyline of [x, y]. */
function pieces(sk) {
  const P = (id) => sk.entities.get(id);
  const out = [];
  for (const e of sk.entities.values()) {
    if (e.construction) continue;
    if (e.type === 'line') {
      const a = P(e.p1);
      const b = P(e.p2);
      out.push([[a.x, a.y], [b.x, b.y]]);
    } else if (e.type === 'circle') {
      const c = P(e.center);
      const flat = tessellateArc(c.x, c.y, e.r, 0, 2 * Math.PI);
      const pts = [];
      for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
      out.push(pts);
    } else if (e.type === 'arc') {
      const c = P(e.center);
      const s = P(e.start);
      const t = P(e.end);
      const flat = tessellateArc(c.x, c.y, e.r, Math.atan2(s.y - c.y, s.x - c.x), Math.atan2(t.y - c.y, t.x - c.x));
      const pts = [];
      for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
      out.push(pts);
    }
  }
  return out;
}

/**
 * @returns {{points:number[][], closed:boolean}[]}
 */
export function sketchStrokes(sk) {
  if (!sk?.entities) return [];
  const list = pieces(sk);
  const used = new Array(list.length).fill(false);
  const byEnd = new Map();
  list.forEach((p, i) => {
    for (const end of [p[0], p[p.length - 1]]) {
      const k = key(end[0], end[1]);
      if (!byEnd.has(k)) byEnd.set(k, []);
      byEnd.get(k).push(i);
    }
  });
  const take = (at) => {
    const cands = (byEnd.get(key(at[0], at[1])) || []).filter((i) => !used[i]);
    if (!cands.length) return null;
    const i = cands[0];
    used[i] = true;
    const p = list[i];
    return key(p[0][0], p[0][1]) === key(at[0], at[1]) ? p : [...p].reverse();
  };
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let pts = [...list[i]];
    for (let next = take(pts[pts.length - 1]); next; next = take(pts[pts.length - 1])) pts = [...pts, ...next.slice(1)];
    for (let prev = take(pts[0]); prev; prev = take(pts[0])) pts = [...[...prev].reverse(), ...pts.slice(1)];
    const closed = pts.length > 2 && key(...pts[0]) === key(...pts[pts.length - 1]);
    out.push({ points: pts, closed });
  }
  return out;
}
