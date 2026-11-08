/**
 * Measure — what a click on the part is, and what two of them measure.
 *
 * The questions an operator asks before posting a program are few and concrete:
 * how big is this bore, how thick is this wall, how far apart are these two holes,
 * how deep is this step. Each is one or two clicks, so a click is read for the
 * most specific thing under it:
 *
 * - on a **round wall** (a bore or a boss), the circle the wall is part of —
 *   a cylinder is what has a diameter;
 * - on a **flat face**, that face — faces are what have a distance between them;
 * - otherwise just the **point**.
 *
 * Pure, plain arrays, in whatever frame the mesh is in: the machining pages
 * measure the part as set up (coordinates from the work origin), the Sketch page
 * the part as built. Distances are the same in both.
 */
import { detectFeatures, faceOfTriangle } from './features.js';
import { circlesAt, nearestCircle } from './circlePick.js';

/** How close to a circle's edge a point must be, as a share of its radius, to be on its wall. */
const ON_WALL = 0.02;
/** Cosine above which two face normals count as parallel. */
const PARALLEL = 0.9999;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/**
 * Read one click.
 *
 * @param {object} welded  the welded mesh the click landed on
 * @param {number} faceIndex  the triangle hit (soup and welded share their order)
 * @param {number[]} point  where, in the mesh's frame
 * @param {number[]} normal  the hit triangle's normal
 * @returns {{kind:'circle'|'face'|'point', point:number[], circle?:object, face?:object}}
 */
export function measurePick(welded, faceIndex, point, normal) {
  const circle = nearestCircle(circlesAt(welded, point, normal), point);
  if (circle && onWall(circle, point)) return { kind: 'circle', point, circle };
  const face = faceOfTriangle(detectFeatures(welded), faceIndex);
  if (face?.normal) return { kind: 'face', point, face };
  return { kind: 'point', point };
}

/** Whether `point` lies on the round wall of `circle`, not merely near it. */
function onWall(circle, point) {
  const off = sub(point, circle.center);
  off[circle.axis] = 0;
  return Math.abs(len(off) - circle.radius) <= circle.radius * ON_WALL;
}

/** Where a pick is, for a distance to it: a circle's centre, else the point clicked. */
const anchor = (p) => (p.kind === 'circle' ? p.circle.center : p.point);

const AXES = ['X', 'Y', 'Z'];
const mm = (v) => `${(Math.round(v * 1000) / 1000).toFixed(3)} mm`;
const xyz = (p) => p.map((v, i) => `${AXES[i]} ${(Math.round(v * 1000) / 1000).toFixed(3)}`).join('  ');

/**
 * What one or two picks measure, as labelled lines for the panel.
 *
 * @param {ReturnType<typeof measurePick>[]} picks
 * @returns {{label:string, value:string}[]}
 */
export function measureResult(picks) {
  if (!picks.length) return [];
  if (picks.length === 1) {
    const [p] = picks;
    if (p.kind === 'circle') {
      return [
        { label: 'Diameter', value: `Ø${mm(p.circle.radius * 2)}` },
        { label: 'Radius', value: mm(p.circle.radius) },
        { label: 'Centre', value: xyz(p.circle.center) },
        { label: 'Axis', value: AXES[p.circle.axis] },
      ];
    }
    if (p.kind === 'face') {
      return [
        { label: 'Face', value: `${p.face.facing ?? ''} · ${(Math.round(p.face.area * 100) / 100).toFixed(2)} mm²` },
        { label: 'Point', value: xyz(p.point) },
      ];
    }
    return [{ label: 'Point', value: xyz(p.point) }];
  }

  const [a, b] = picks;
  const lines = [];
  if (a.kind === 'face' && b.kind === 'face') {
    const c = dot(a.face.normal, b.face.normal);
    if (Math.abs(c) > PARALLEL) {
      // Parallel faces: the distance that matters is across them, wherever on
      // each face the clicks happened to land.
      lines.push({ label: 'Distance (normal)', value: mm(Math.abs(dot(sub(b.face.centroid, a.face.centroid), a.face.normal))) });
    } else {
      const deg = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
      lines.push({ label: 'Angle', value: `${(Math.round(deg * 1000) / 1000).toFixed(3)}°` });
    }
  }
  const d = sub(anchor(b), anchor(a));
  const what = a.kind === 'circle' && b.kind === 'circle' ? 'Centre distance' : 'Distance';
  lines.push({ label: what, value: mm(len(d)) });
  lines.push({ label: 'dX dY dZ', value: d.map((v) => (Math.round(v * 1000) / 1000).toFixed(3)).join('  ') });
  return lines;
}
