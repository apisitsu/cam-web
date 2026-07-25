/**
 * Mesh analysis — the facts the CAM planner reasons from.
 *
 * An STL carries no units, no tolerances, and no features; all that survives is
 * a bag of triangles. Everything the planner needs has to be measured back out
 * of that geometry, and this module is where that measuring lives. It answers
 * four questions:
 *
 *   1. How big is it, and which way up?              `boundsOf`
 *   2. Is the mesh sound enough to slice?            `shellReport`
 *   3. Is it a solid of revolution — lathe or mill?  `rotationalSymmetry`
 *   4. How much material comes off?                  `meshVolume`
 *
 * Question 3 is the one that routes the whole job, so it is deliberately a
 * measurement with a score rather than a boolean guess.
 *
 * Pure functions over typed arrays: no three.js, no store, no DOM.
 */

const AXES = /** @type {const} */ (['x', 'y', 'z']);
const AXIS_INDEX = { x: 0, y: 1, z: 2 };

/** Axis-aligned bounds of a triangle soup or a welded mesh. */
export function boundsOf(mesh) {
  const p = mesh.positions;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0], diagonal: 0 };
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return {
    min, max, size,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    diagonal: Math.hypot(size[0], size[1], size[2]),
  };
}

/** Iterate triangles as flat corner offsets, for soup or indexed input. */
function eachTriangle(mesh, fn) {
  const p = mesh.positions;
  if (mesh.indices) {
    for (let t = 0; t < mesh.indices.length; t += 3) {
      fn(mesh.indices[t] * 3, mesh.indices[t + 1] * 3, mesh.indices[t + 2] * 3, p);
    }
  } else {
    for (let t = 0; t < mesh.triangleCount * 3; t += 3) {
      fn(t * 3, (t + 1) * 3, (t + 2) * 3, p);
    }
  }
}

/**
 * Signed volume by the divergence theorem — the sum of tetrahedra from the
 * origin to each triangle.
 *
 * The **sign** is as useful as the magnitude: a correctly wound, closed mesh
 * gives a positive volume, so a negative result means the STL's normals are
 * inside-out. That happens often enough in the wild that it is worth reporting
 * rather than silently taking an absolute value.
 */
export function meshVolume(mesh) {
  let v6 = 0;
  eachTriangle(mesh, (a, b, c, p) => {
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    v6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  });
  return v6 / 6;
}

/** Total surface area — used to sanity-check volume and to size a facing pass. */
export function surfaceArea(mesh) {
  let area = 0;
  eachTriangle(mesh, (a, b, c, p) => {
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  });
  return area;
}

/**
 * Topology health of a **welded** mesh.
 *
 * A slice plane can only produce closed polygons if every edge is shared by
 * exactly two triangles. Counting each undirected edge tells us that directly:
 *
 * - `boundaryEdges` — used once: the shell has holes, slices will come out open
 * - `nonManifoldEdges` — used 3+ times: self-intersecting or duplicated shells
 * - `flippedEdges` — shared by two triangles that traverse it the *same* way,
 *   meaning their winding disagrees and the normals are inconsistent
 *
 * These are warnings, not errors — a mesh with a handful of bad edges usually
 * still slices fine, and refusing to load it would be worse than saying so.
 */
export function shellReport(mesh) {
  if (!mesh.indices) throw new Error('shellReport needs a welded (indexed) mesh');
  const seen = new Map(); // "lo,hi" -> { count, forward }
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e], b = idx[t + (e + 1) % 3];
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const key = `${lo},${hi}`;
      const rec = seen.get(key);
      if (rec) { rec.count++; if (a === lo) rec.forward++; }
      else seen.set(key, { count: 1, forward: a === lo ? 1 : 0 });
    }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0, flippedEdges = 0;
  for (const rec of seen.values()) {
    if (rec.count === 1) boundaryEdges++;
    else if (rec.count > 2) nonManifoldEdges++;
    // Two triangles sharing an edge should walk it in opposite directions.
    else if (rec.forward !== 1) flippedEdges++;
  }
  return {
    edgeCount: seen.size,
    boundaryEdges,
    nonManifoldEdges,
    flippedEdges,
    watertight: boundaryEdges === 0 && nonManifoldEdges === 0,
    consistentWinding: flippedEdges === 0,
  };
}

/** Mean triangle edge length — the natural scale for "is this just faceting?". */
export function meanEdgeLength(mesh) {
  let sum = 0, n = 0;
  eachTriangle(mesh, (a, b, c, p) => {
    for (const [i, j] of [[a, b], [b, c], [c, a]]) {
      sum += Math.hypot(p[i] - p[j], p[i + 1] - p[j + 1], p[i + 2] - p[j + 2]);
      n++;
    }
  });
  return n ? sum / n : 0;
}

/**
 * The largest angular gap, in radians, in a set of angles wrapped onto a circle.
 * An empty or single-angle set covers nothing, so it reports a full turn.
 */
function largestAngularGap(angles) {
  if (angles.length < 2) return 2 * Math.PI;
  const sorted = [...angles].sort((a, b) => a - b);
  let gap = sorted[0] + 2 * Math.PI - sorted[sorted.length - 1]; // wrap-around
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d > gap) gap = d;
  }
  return gap;
}

/**
 * The angular gap above which a cross-section is a genuine polygon rather than
 * a tessellated circle.
 *
 * Set at an **eighth of a turn (45°)**, which is deliberately permissive: the
 * job of this test is to recognise cylinders, and a cylinder should be found
 * even when it was exported coarsely or when a chamfer thins the section down
 * to a handful of facets. Missing a turned part and sending it to the mill is
 * the expensive failure; a section built from eight or more facets is called
 * round.
 *
 * The limit cannot be pushed much further, because **a hex bar and a six-facet
 * cylinder are the same mesh** — STL keeps no record of which one the designer
 * drew, and tessellation density is the only signal left. 45° keeps hex (60°)
 * and square (90°) bar on the polygon side, so the rule stays permissive
 * without turning flat-sided stock into a lathe job.
 *
 * The 1.001 factor keeps a section tessellated at exactly eight facets — whose
 * gaps land precisely on the limit — from being rejected by round-off.
 */
const ROUND_GAP_LIMIT = ((2 * Math.PI) / 8) * 1.001;

/**
 * How far a cross-section's bounding box may depart from square.
 *
 * A revolve is as wide as it is deep, but a real export is not exact to the
 * last micron — faceting alone puts a 5% wobble on a coarse section — so the
 * check is a sanity filter for "this axis is obviously wrong", not a precision
 * measurement.
 */
const ASPECT_LIMIT = 0.05;

/**
 * How close the mesh is to being a solid of revolution about `axis`.
 *
 * A revolve has the same outline at every angle, so the test looks at the
 * **outer boundary of each cross-section**: bin the vertices by axial position,
 * take the largest radius in each bin, and check that vertices sitting at that
 * radius appear all the way around. A milled flat, a keyway, or a hex face
 * removes material from the outer boundary and leaves an angular gap where no
 * vertex reaches the full radius — which is exactly what gets measured.
 *
 * Two guards keep the measurement from lying:
 *
 * - **Thin slices are ignored.** The tip of a cone or the bottom of a chamfer
 *   has a near-zero radius where a handful of vertices span a big angle for
 *   trivial reasons, so bins below 5% of the part's max radius are skipped.
 * - **The cross-section must be square in bounds.** A revolve's bounding box is
 *   as wide as it is deep. Checking that first rejects an axis cheaply and
 *   catches a part modelled off the centreline, since the axis is assumed to
 *   pass through the bounding-box centre.
 *
 * @returns {{axis:'x'|'y'|'z', center:number[], score:number, symmetric:boolean,
 *   maxGap:number, aspectError:number, radius:number}}
 *   `score` is 0 for a perfect revolve and ≥1 once the part is clearly not one.
 */
export function rotationalSymmetry(mesh, axis, opts = {}) {
  const ai = AXIS_INDEX[axis];
  if (ai === undefined) throw new Error(`rotationalSymmetry: bad axis ${axis}`);
  const p = mesh.positions;
  const b = boundsOf(mesh);
  const [u, v] = [0, 1, 2].filter((k) => k !== ai);
  const cu = b.center[u], cv = b.center[v];

  // Cheap rejection: a solid of revolution is as wide as it is deep.
  const su = b.size[u], sv = b.size[v];
  const aspectError = Math.max(su, sv) > 0 ? Math.abs(su - sv) / Math.max(su, sv) : 1;

  const axialSize = b.size[ai];
  const nBins = Math.max(1, Math.min(64, Math.ceil(axialSize / (b.diagonal / 64 || 1))));
  const binOf = (a) => (axialSize > 0
    ? Math.min(nBins - 1, Math.floor(((a - b.min[ai]) / axialSize) * nBins))
    : 0);

  // Pass 1 — the outer radius of each cross-section.
  const rMax = new Float64Array(nBins);
  for (let i = 0; i < p.length; i += 3) {
    const r = Math.hypot(p[i + u] - cu, p[i + v] - cv);
    const k = binOf(p[i + ai]);
    if (r > rMax[k]) rMax[k] = r;
  }
  let radius = 0;
  for (let k = 0; k < nBins; k++) if (rMax[k] > radius) radius = rMax[k];

  // Pass 2 — the angles at which each cross-section actually reaches that radius.
  const angles = Array.from({ length: nBins }, () => []);
  for (let i = 0; i < p.length; i += 3) {
    const du = p[i + u] - cu, dv = p[i + v] - cv;
    const r = Math.hypot(du, dv);
    const k = binOf(p[i + ai]);
    if (rMax[k] <= 0 || r < rMax[k] * 0.98) continue;
    angles[k].push(Math.atan2(dv, du));
  }

  let maxGap = 0;
  for (let k = 0; k < nBins; k++) {
    if (rMax[k] < radius * 0.05) continue; // a tip or a centre hole, not a section
    const gap = largestAngularGap(angles[k]);
    if (gap > maxGap) maxGap = gap;
  }
  if (maxGap === 0) maxGap = 2 * Math.PI; // nothing measurable

  const score = Math.max(maxGap / ROUND_GAP_LIMIT, aspectError / ASPECT_LIMIT);
  return {
    axis,
    center: [b.center[0], b.center[1], b.center[2]],
    score,
    symmetric: score <= 1,
    maxGap,
    aspectError,
    radius,
  };
}

/**
 * Pick the turning axis, if the part has one.
 *
 * Tries all three principal axes and keeps the best-scoring. A part with no
 * rotational axis comes back with `symmetric: false`, which is the planner's
 * signal to treat the job as milling.
 */
export function detectRotationAxis(mesh, opts = {}) {
  const results = AXES.map((a) => rotationalSymmetry(mesh, a, opts));
  results.sort((a, b) => a.score - b.score);
  return results[0];
}

/**
 * Full analysis of a loaded STL, as the planner consumes it.
 *
 * `recommend` is the routing decision — 'turn' when the part is a solid of
 * revolution, otherwise 'mill'. `warnings` carries everything the operator
 * should see before trusting a generated toolpath; an empty array is the only
 * clean result.
 *
 * Cached against the (soup, welded) pair. The measurement is a pure function of
 * the two meshes, and both are immutable once built — every transform upstream
 * (`weld`, `reorient`, `applyDatum`) returns new arrays rather than writing
 * through an existing one. The store re-runs this on every machine, process and
 * datum change, always on the *same* raw and laid-down meshes (now that
 * `reorient` returns the identical object for an identical lay-down), so without
 * a cache each of those settings changes re-measured shell soundness, volume and
 * rotational symmetry — walking every triangle several times — for an answer
 * that had not changed. The soup is checked too, not just the welded key, so a
 * welded mesh paired with a different soup can never collide.
 *
 * @param {{positions: Float32Array, triangleCount: number}} soup  from `parseSTL`
 * @param {{positions: Float32Array, indices: Uint32Array}} welded from `weld`
 */
const _analysisCache = new WeakMap();
export function analyzeMesh(soup, welded) {
  const hit = _analysisCache.get(welded);
  if (hit && hit.soup === soup) return hit.result;

  const result = analyzeMeshUncached(soup, welded);
  _analysisCache.set(welded, { soup, result });
  return result;
}

function analyzeMeshUncached(soup, welded) {
  const bounds = boundsOf(soup);
  const shell = shellReport(welded);
  const signedVolume = meshVolume(welded);
  const axis = detectRotationAxis(welded);
  const warnings = [];

  if (!shell.watertight) {
    warnings.push(shell.boundaryEdges > 0
      ? `Mesh is not closed (${shell.boundaryEdges} open edges) — slices may be incomplete.`
      : `Mesh has ${shell.nonManifoldEdges} non-manifold edges — slicing may be unreliable.`);
  }
  if (!shell.consistentWinding) {
    warnings.push(`${shell.flippedEdges} edges have inconsistent winding — inside/outside may be ambiguous.`);
  }
  if (signedVolume < 0) {
    warnings.push('Mesh normals point inward (negative volume) — the solid is inside-out.');
  }
  if (bounds.diagonal === 0) warnings.push('Mesh is empty.');

  return {
    bounds,
    shell,
    volume: Math.abs(signedVolume),
    signedVolume,
    surfaceArea: surfaceArea(welded),
    triangleCount: soup.triangleCount,
    vertexCount: welded.vertexCount,
    axis,
    recommend: axis.symmetric ? 'turn' : 'mill',
    warnings,
  };
}
