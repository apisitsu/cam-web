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
  const b = brushOf(tool);
  const evaluator = new Evaluator();
  // Only positions are wanted back; skipping the rest keeps the result small and
  // avoids carrying attributes the CAM engine has no use for.
  evaluator.attributes = ['position', 'normal'];
  const result = evaluator.evaluate(a, b, operation);

  const soup = soupOf(result, format);
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
