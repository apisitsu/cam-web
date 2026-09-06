/**
 * Boolean combination of sketch regions — union, subtract, intersect.
 *
 * This is the 2D boolean, done on the **profile** before it is extruded, and it
 * is deliberately where the boolean lives rather than on the finished solid.
 * Two reasons:
 *
 * - It is exact. Clipper works in scaled integers and returns real polygon
 *   boundaries; a mesh boolean returns triangles that approximate one, and every
 *   subsequent operation inherits the approximation. For a part that is going to
 *   be *machined* off these profiles, an exact boundary is the whole point.
 * - It is what this CAM engine can use. The pipeline downstream plans 2.5D
 *   milling and turning; a pocket, a boss, a slot and a merged outline are all
 *   profile operations. Subtracting one arbitrary solid from another at an angle
 *   is a thing this planner would have no way to cut.
 *
 * Regions in, regions out, in the shape `buildSolid` consumes. Orientation and
 * nesting are re-decided by `normalizeLoops` afterwards, never carried over:
 * Clipper's output winding is its own, and a subtraction can turn what was an
 * outer boundary into a hole.
 */
import { booleanLoops } from '../cam/offset.js';
import { normalizeLoops } from '../mesh/slice.js';
import { groupRegions } from '../sketch/loops.js';

/** The operations, in the words a CAD puts on the buttons. */
export const BOOLEAN_OPS = {
  union: 'Union — merge the profiles into one outline',
  difference: 'Subtract — the first profile less the others',
  intersect: 'Intersect — only where the profiles overlap',
  xor: 'Exclude — everything except where they overlap',
};

/** A region flattened to the loop list Clipper wants: outer plus its holes. */
const loopsOf = (region) => [region.outer, ...(region.holes || [])];

/**
 * Combine every region of a sketch with one operation.
 *
 * `difference` subtracts every later region from the **first**, which is the
 * largest — `sketchRegions` returns them biggest-first — and is what "subtract"
 * means when the user drew a plate and then a shape on top of it. The others are
 * symmetric and take all the regions at once.
 *
 * A single region is returned untouched: there is nothing to combine it with,
 * and pushing it through Clipper anyway would re-tessellate its arcs for no gain.
 *
 * @param {object[]} regions  `sketchRegions` output
 * @param {string} op  a key of BOOLEAN_OPS
 * @param {{minArea?:number}} [opts]
 */
export function combineRegions(regions, op, opts = {}) {
  if (!BOOLEAN_OPS[op]) throw new Error(`unknown boolean op: ${op}`);
  if (!regions?.length) return [];
  if (regions.length === 1) return regions;

  const [first, ...rest] = regions;
  const subject = op === 'difference' ? loopsOf(first) : regions.flatMap(loopsOf);
  const clip = op === 'difference' ? rest.flatMap(loopsOf) : [];

  // Union and the rest take everything as subject against an empty clip, which
  // Clipper resolves by non-zero fill across the lot — exactly the merge wanted.
  // Intersect and xor need two sides to mean anything, so they get the first
  // region against all the others.
  const result = op === 'union'
    ? booleanLoops(subject, [], 'union')
    : op === 'difference'
      ? booleanLoops(subject, clip, 'difference')
      : booleanLoops(loopsOf(first), rest.flatMap(loopsOf), op);

  return groupRegions(normalizeLoops(result, { minArea: opts.minArea ?? 1e-6 }));
}
