/**
 * The cut face of a Section View: where a plane square to X, Y or Z passes
 * through the part, as triangles to draw over the opening the clip leaves.
 *
 * Built from the same section the CAM slices with (`sliceLoops`), whose loops
 * already know which are outlines and which are holes; each outline is filled
 * with the holes that sit directly inside it.
 *
 * Pure: plain arrays.
 */
import { sliceLoops } from './slice.js';
import { triangulate } from '../solid/triangulate.js';

function inside(loop, x, y) {
  let hit = false;
  for (let i = 0, j = loop.length - 2; i < loop.length; j = i, i += 2) {
    const [xi, yi, xj, yj] = [loop[i], loop[i + 1], loop[j], loop[j + 1]];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * @param {object} mesh  welded mesh
 * @param {0|1|2} axis  the axis the plane is square to
 * @param {number} coord  where along it
 * @returns {Float32Array} triangle soup positions (9 per triangle), on the plane
 */
export function sectionCap(mesh, axis, coord) {
  const { loops } = sliceLoops(mesh, axis, coord);
  const [iu, iv] = [0, 1, 2].filter((k) => k !== axis);
  const flat = loops.map((l) => ({ ...l, pts: Array.from(l.points) }));
  const out = [];
  for (const outer of flat.filter((l) => !l.isHole)) {
    const holes = flat.filter((h) => h.isHole && h.depth === outer.depth + 1
      && inside(outer.pts, h.pts[0], h.pts[1]));
    const { vertices, indices } = triangulate(outer.pts, holes.map((h) => h.pts));
    for (const i of indices) {
      const p = [0, 0, 0];
      p[axis] = coord;
      p[iu] = vertices[i * 2];
      p[iv] = vertices[i * 2 + 1];
      out.push(...p);
    }
  }
  return new Float32Array(out);
}
