/**
 * Phase 2 — planegcs bridge (WASM constraint solver).
 *
 * Translates the point-based sketch model (`model.js`) into planegcs primitives,
 * runs FreeCAD's PlaneGCS solver (compiled to WASM by `@salusoft89/planegcs`),
 * and writes the solved coordinates back onto the sketch. The model maps to
 * planegcs almost 1:1 because both are point-based.
 *
 * Runs in Node (dev/tests) and, later, in the sketch-worker. `createSolver`
 * loads the WASM once and is reused across solves via `clear_data()`.
 */
import { make_gcs_wrapper, Algorithm, SolveStatus } from '@salusoft89/planegcs';

const sid = (id) => String(id);

/**
 * Convert a sketch document to an ordered planegcs primitive list: all points
 * first (geometry references them), then lines/circles, then constraints.
 */
export function toPlanegcs(sk) {
  const prims = [];
  for (const e of sk.entities.values()) {
    if (e.type === 'point') {
      prims.push({ id: sid(e.id), type: 'point', x: e.x, y: e.y, fixed: !!e.fixed });
    }
  }
  for (const e of sk.entities.values()) {
    if (e.type === 'line') {
      prims.push({ id: sid(e.id), type: 'line', p1_id: sid(e.p1), p2_id: sid(e.p2) });
    } else if (e.type === 'circle') {
      prims.push({ id: sid(e.id), type: 'circle', c_id: sid(e.center), radius: e.r });
    } else if (e.type === 'arc') {
      // planegcs needs the sweep angles too; derive them from the current point
      // positions (counter-clockwise start→end). `arc_rules` then pins the two
      // endpoint points to the rim at those angles so the arc stays consistent.
      const c = sk.entities.get(e.center);
      const s = sk.entities.get(e.start);
      const en = sk.entities.get(e.end);
      prims.push({
        id: sid(e.id), type: 'arc', c_id: sid(e.center), radius: e.r,
        start_id: sid(e.start), end_id: sid(e.end),
        start_angle: Math.atan2(s.y - c.y, s.x - c.x),
        end_angle: Math.atan2(en.y - c.y, en.x - c.x),
      });
      prims.push({ id: `arc_rules_${e.id}`, type: 'arc_rules', a_id: sid(e.id) });
    }
  }
  let n = 0;
  const cid = () => `k${n++}`;
  for (const c of sk.constraints) {
    const [a, b] = c.refs.map(sid);
    switch (c.kind) {
      case 'coincident':
        prims.push({ id: cid(), type: 'p2p_coincident', p1_id: a, p2_id: b });
        break;
      case 'lockX':
        prims.push({ id: cid(), type: 'coordinate_x', p_id: a, x: c.value });
        break;
      case 'lockY':
        prims.push({ id: cid(), type: 'coordinate_y', p_id: a, y: c.value });
        break;
      case 'horizontal':
        prims.push({ id: cid(), type: 'horizontal_pp', p1_id: a, p2_id: b });
        break;
      case 'vertical':
        prims.push({ id: cid(), type: 'vertical_pp', p1_id: a, p2_id: b });
        break;
      case 'parallel':
        prims.push({ id: cid(), type: 'parallel', l1_id: a, l2_id: b });
        break;
      case 'perpendicular':
        prims.push({ id: cid(), type: 'perpendicular_ll', l1_id: a, l2_id: b });
        break;
      case 'pointOnLine':
        prims.push({ id: cid(), type: 'point_on_line_pl', p_id: a, l_id: b });
        break;
      case 'pointOnCircle':
        prims.push({ id: cid(), type: 'point_on_circle', p_id: a, c_id: b });
        break;
      case 'pointOnArc':
        prims.push({ id: cid(), type: 'point_on_arc', p_id: a, a_id: b });
        break;
      case 'distance':
        prims.push({ id: cid(), type: 'p2p_distance', p1_id: a, p2_id: b, distance: c.value });
        break;
      case 'pointLineDistance':
        prims.push({ id: cid(), type: 'p2l_distance', p_id: a, l_id: b, distance: c.value });
        break;
      case 'radius':
        prims.push({ id: cid(), type: 'circle_radius', c_id: a, radius: c.value });
        break;
      case 'equalLength':
        prims.push({ id: cid(), type: 'equal_length', l1_id: a, l2_id: b });
        break;
      case 'angle':
        // c.value is the angle between the two lines, in radians.
        prims.push({ id: cid(), type: 'l2l_angle_ll', l1_id: a, l2_id: b, angle: c.value });
        break;
      case 'tangent':
        prims.push({ id: cid(), type: 'tangent_lc', l_id: a, c_id: b });
        break;
      case 'tangentArc':
        prims.push({ id: cid(), type: 'tangent_la', l_id: a, a_id: b });
        break;
      default:
        throw new Error(`no planegcs mapping for constraint ${c.kind}`);
    }
  }
  return prims;
}

/**
 * Load the solver once. Returns { solve, destroy }.
 *
 * `wasmPath` is the URL/path to `planegcs.wasm`: the worker passes vite's `?url`
 * asset URL, Node callers resolve it via createRequire. Kept a required arg so
 * this module has no `node:*` import and bundles cleanly for the browser.
 *
 * `solve(sk)` mutates `sk` in place with the solved coordinates/radii and
 * returns { status, success, conflicting, redundant }. `conflicting` /
 * `redundant` are arrays of the offending constraint ids (planegcs' own
 * over-constraint detection — more accurate than the model's nominal DOF).
 */
export async function createSolver({ wasmPath } = {}) {
  if (!wasmPath) throw new Error('createSolver requires a wasmPath to planegcs.wasm');
  const gcs = await make_gcs_wrapper(wasmPath);
  return {
    solve(sk, { algorithm = Algorithm.DogLeg } = {}) {
      gcs.clear_data();
      for (const p of toPlanegcs(sk)) gcs.push_primitive(p);
      const status = gcs.solve(algorithm);
      gcs.apply_solution();
      for (const e of sk.entities.values()) {
        if (e.type === 'point') {
          const pt = gcs.sketch_index.get_sketch_point(sid(e.id));
          e.x = pt.x;
          e.y = pt.y;
        } else if (e.type === 'circle') {
          e.r = gcs.sketch_index.get_sketch_circle(sid(e.id)).radius;
        } else if (e.type === 'arc') {
          e.r = gcs.sketch_index.get_sketch_arc(sid(e.id)).radius;
        }
      }
      return {
        status,
        success: status === SolveStatus.Success,
        conflicting: gcs.get_gcs_conflicting_constraints(),
        redundant: gcs.get_gcs_redundant_constraints(),
      };
    },
    destroy() {
      gcs.destroy_gcs_module?.();
    },
  };
}
