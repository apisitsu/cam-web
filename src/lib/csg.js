/**
 * Boolean between two solids — the 3D half of the boolean story.
 *
 * The 2D one (`engine/solid/regionBoolean.js`) combines *profiles* before they
 * are extruded, and it is the better tool whenever the shapes share a plane:
 * it is exact, it needs no library, and its output is a real polygon boundary.
 * This is for what that cannot express — cutting a pocket drawn on the front
 * plane out of a part standing on the table, where the two solids meet at an
 * angle and there is no common profile to work on.
 *
 * ## Why this is not in `engine/`
 *
 * Everything under `engine/` is plain arrays and imports no three.js, which is
 * what lets it run unchanged in a worker, in Node and under the test runner.
 * A mesh boolean is the one operation with no reasonable hand-written form —
 * robust CSG is a research-grade problem — so it is delegated to
 * `three-bvh-csg`, exactly as polygon offsetting is delegated to Clipper. That
 * library speaks `BufferGeometry`, so this module lives in `lib/` with the rest
 * of the browser-side code, and confines itself to being a clean boundary
 * around it: **triangle soup in, triangle soup out**, the same shape the CAM
 * pipeline reads everywhere else.
 *
 * ## What it costs
 *
 * A mesh boolean returns triangles that *approximate* the true boundary, and
 * every later operation inherits that. Prefer the profile boolean when the
 * geometry allows it — that is why the panel offers the 2D one first.
 */
import * as THREE from 'three';
import {
  Evaluator, Brush, ADDITION, SUBTRACTION, INTERSECTION,
} from 'three-bvh-csg';
import { repairSoup, openEdgeCount } from '../engine/mesh/repair.js';

/** Corner tolerances (mm) a repair is tried at, coarse to fine, until one closes the surface. */
const REPAIR_TOLS = [1e-4, 1e-5, 1e-6];

/** The operations, in the words a CAD puts on the buttons. */
export const MESH_OPS = {
  add: 'Add — join the new solid to the part',
  cut: 'Cut — remove the new solid from the part',
  common: 'Common — keep only where they overlap',
};

const OPERATIONS = { add: ADDITION, cut: SUBTRACTION, common: INTERSECTION };

/**
 * A soup as a `Brush`.
 *
 * Normals are computed rather than left off: the evaluator interpolates every
 * attribute both operands share, and it requires them to match, so two brushes
 * built the same way is the simplest thing that always works.
 */
function brushOf(soup) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(soup.positions.slice(), 3));
  geometry.computeVertexNormals();
  const brush = new Brush(geometry);
  brush.updateMatrixWorld();
  return brush;
}

/** A `Brush` (or any mesh) back to the soup shape the CAM pipeline reads. */
function soupOf(mesh, format) {
  const geometry = mesh.geometry;
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  // The evaluator may hand back an indexed geometry; the pipeline works on flat
  // triangles, so expand it rather than teach everything downstream about both.
  const count = index ? index.count : pos.count;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = index ? index.getX(i) : i;
    positions[i * 3] = pos.getX(v);
    positions[i * 3 + 1] = pos.getY(v);
    positions[i * 3 + 2] = pos.getZ(v);
  }
  return { positions, triangleCount: count / 3, format };
}

/** How far (mm) the new solid's farthest corner moves out before a boolean. */
export const GROW = 0.001;

/**
 * The solid scaled about the middle of its box so its farthest corner moves out
 * by `by`. Everything else moves less, in proportion — a micron at most, far under
 * anything a machine holds, and enough to take a surface off one it lay on.
 */
function grown(soup, by) {
  const p = soup.positions;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[i + k]);
      hi[k] = Math.max(hi[k], p[i + k]);
    }
  }
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  const half = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
  if (!(half > 0)) return soup;
  const s = 1 + by / half;
  const positions = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) positions[i + k] = c[k] + (p[i + k] - c[k]) * s;
  }
  return { ...soup, positions };
}

/**
 * Boolean two solids.
 *
 * @param {{positions:Float32Array, triangleCount:number}} part  the solid on the machine
 * @param {{positions:Float32Array, triangleCount:number}} tool  the solid just built
 * @param {'add'|'cut'|'common'} op
 * @param {string} [format]  what to call the result's format
 * @returns {{positions:Float32Array, triangleCount:number, format:string}}
 */
export function meshBoolean(part, tool, op, format = op) {
  const operation = OPERATIONS[op];
  if (operation === undefined) throw new Error(`unknown mesh boolean: ${op}`);
  if (!part?.triangleCount) throw new Error('There is no part loaded to combine with.');
  if (!tool?.triangleCount) throw new Error('The new solid is empty.');

  const a = brushOf(part);
  // Add and cut grow the new solid a hair first. A profile drawn to the edge of
  // the part — a groove out to the bar's own radius, a cut from a sketch on the
  // top face — gives a solid whose surface lies exactly on the part's, and the
  // evaluator cannot tell which side of a shared surface is which: it keeps both,
  // as slivers facing opposite ways, which draw as streaks across the part.
  // Common keeps only the overlap, so growing its solid would grow the answer.
  const b = brushOf(op === 'common' ? tool : grown(tool, GROW));
  const evaluator = new Evaluator();
  // Only positions are wanted back; skipping the rest keeps the result small and
  // avoids carrying attributes the CAM engine has no use for.
  evaluator.attributes = ['position', 'normal'];
  const result = evaluator.evaluate(a, b, operation);

  // Closed up before anything reads it: the evaluator leaves T-junctions, which
  // show as cracks on screen and as open edges to a slice (see `repairSoup`).
  // Which corners count as one is a judgement: a turned groove closes best at
  // the usual tolerance, while round the mouth of a drilled hole corners that are
  // truly distinct sit closer than that, and merging them folds the face. So the
  // tolerances are tried from coarse to fine, stopping at the first that closes
  // the surface; failing that, the one leaving fewest open edges is kept. Repair
  // moves nothing, so every candidate is the same solid.
  const raw = soupOf(result, format);
  let soup = null;
  let open = Infinity;
  for (const tol of REPAIR_TOLS) {
    const tried = repairSoup(raw, { tol });
    const left = openEdgeCount(tried);
    if (left < open) { soup = tried; open = left; }
    if (open === 0) break;
  }
  if (!soup.triangleCount) {
    throw new Error(`Nothing is left after ${op} — the two solids do not overlap the way that needs.`);
  }
  // The brushes hold BVHs and buffers; drop them rather than wait for GC on a
  // page that may do this repeatedly.
  a.geometry.dispose();
  b.geometry.dispose();
  result.geometry.dispose();
  return soup;
}
