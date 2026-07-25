/**
 * Feature recognition — finding the faces and edges an operator can point at.
 *
 * An STL has no features. It is a bag of triangles with every trace of design
 * intent thrown away: a pocket floor is not a pocket floor, it is four hundred
 * coplanar triangles that happen to be flush. So "click the face you want
 * machined" only works if something first puts those triangles back together,
 * and that is all this module does.
 *
 * Two kinds of thing are worth pointing at, and they are recovered differently:
 *
 * - **Planar faces** — triangles that share an edge *and* lie in the same
 *   plane, merged. Both conditions matter. Coplanar alone would weld the top of
 *   a part to an unrelated boss at the same height into one nonsense "face";
 *   connected alone would merge a fillet into the wall it blends. Together they
 *   recover exactly what a CAD face was.
 * - **Sharp edges** — where two triangles meet at a real angle rather than a
 *   tessellation seam, chained into polylines. This is the "line" an operator
 *   traces, chamfers or engraves along.
 *
 * The tolerances are the whole game. Too tight and a curved wall shatters into
 * hundreds of one-triangle faces; too loose and a shallow taper reads as flat
 * and gets machined square. Both defaults below are stated in the units the
 * mistake would be made in — degrees for direction, millimetres for position —
 * rather than as opaque epsilons.
 *
 * Pure functions over typed arrays. No three.js, no store, no DOM.
 */

/** Triangle count of a welded (indexed) or soup (flat) mesh. */
function triangleCount(mesh) {
  return mesh.indices ? mesh.indices.length / 3 : mesh.positions.length / 9;
}

/** The three vertex indices of triangle `t`, into `positions/3`. */
function triVerts(mesh, t) {
  if (mesh.indices) {
    return [mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]];
  }
  return [t * 3, t * 3 + 1, t * 3 + 2];
}

const px = (mesh, v) => mesh.positions[v * 3];
const py = (mesh, v) => mesh.positions[v * 3 + 1];
const pz = (mesh, v) => mesh.positions[v * 3 + 2];

/**
 * Unit normal and plane offset of one triangle.
 *
 * Returns null for a degenerate triangle — STLs are full of them, and a zero
 * normal would otherwise poison every comparison it takes part in.
 */
function triPlane(mesh, t) {
  const [a, b, c] = triVerts(mesh, t);
  const ax = px(mesh, a), ay = py(mesh, a), az = pz(mesh, a);
  const ux = px(mesh, b) - ax, uy = py(mesh, b) - ay, uz = pz(mesh, b) - az;
  const vx = px(mesh, c) - ax, vy = py(mesh, c) - ay, vz = pz(mesh, c) - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return null;
  const n = [nx / len, ny / len, nz / len];
  return { n, d: n[0] * ax + n[1] * ay + n[2] * az, area: len / 2 };
}

/**
 * Stride for packing an undirected edge's two vertex ids into one number.
 *
 * Keys are numbers rather than `"a_b"` strings because an edge map is built over
 * *three times* the triangle count — 45 000 keys on a 15 000-triangle part — and
 * the string building alone was a large share of feature detection. Vertex ids
 * stay well inside the 2^53 exact-integer range at this stride.
 */
const EDGE_STRIDE = 33554432; // 2^25 — supports meshes up to 33.5 M vertices

const packEdge = (a, b) => (a < b ? a * EDGE_STRIDE + b : b * EDGE_STRIDE + a);
const unpackEdge = (k) => [Math.floor(k / EDGE_STRIDE), k % EDGE_STRIDE];

/**
 * Every edge of the mesh, with the triangles that use it.
 *
 * Insertion order is triangle order, and both detectors below depend on it: it
 * decides the order sharp edges are chained in, and so where a traced edge
 * starts. Keys changed from strings to packed numbers, which preserves that
 * order exactly.
 */
function edgeMap(mesh) {
  const edges = new Map();
  const n = triangleCount(mesh);
  for (let t = 0; t < n; t++) {
    const [a, b, c] = triVerts(mesh, t);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = packEdge(u, v);
      const hit = edges.get(k);
      if (hit) hit.push(t);
      else edges.set(k, [t]);
    }
  }
  return edges;
}

/**
 * The per-triangle planes and the edge map, computed once and shared.
 *
 * `detectPlanarFaces` and `detectSharpEdges` each need both, and running them
 * back to back through `detectFeatures` used to build both twice over. Keyed
 * weakly on the mesh, which is sound for the same reason the slice index's cache
 * is: meshes here are never written through once built.
 */
const _topologyCache = new WeakMap();
function topology(mesh) {
  let hit = _topologyCache.get(mesh);
  if (hit) return hit;
  const count = triangleCount(mesh);
  const planes = new Array(count);
  for (let t = 0; t < count; t++) planes[t] = triPlane(mesh, t);
  hit = { planes, edges: edgeMap(mesh), count };
  _topologyCache.set(mesh, hit);
  return hit;
}

/** Union-find, the standard flavour. */
function makeUnionFind(n) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) { const next = parent[i]; parent[i] = r; i = next; }
    return r;
  };
  return {
    find,
    union(a, b) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    },
  };
}

/**
 * Merge coplanar, connected triangles into faces.
 *
 * @param {{positions:Float32Array, indices?:Uint32Array}} mesh
 * @param {{angleTol?:number, distTol?:number, minArea?:number}} opts
 *   `angleTol` in degrees — how far two triangle normals may differ and still
 *   count as the same face. 1° is tight enough to keep a 2° draft angle
 *   distinct from a flat floor, which is a distinction that matters.
 *   `distTol` in mm — how far apart their planes may sit.
 * @returns {{faces:object[], triangleFace:Int32Array}}
 */
export function detectPlanarFaces(mesh, opts = {}) {
  const { angleTol = 1, distTol = 0.01, minArea = 0.5 } = opts;
  const cosTol = Math.cos((angleTol * Math.PI) / 180);
  const { planes, edges, count } = topology(mesh);

  const uf = makeUnionFind(count);
  for (const tris of edges.values()) {
    // A manifold edge has two triangles. More than two is non-manifold junk;
    // comparing every pair there would merge across a self-intersection.
    if (tris.length !== 2) continue;
    const [p, q] = [planes[tris[0]], planes[tris[1]]];
    if (!p || !q) continue;
    const dot = p.n[0] * q.n[0] + p.n[1] * q.n[1] + p.n[2] * q.n[2];
    if (dot < cosTol) continue;
    if (Math.abs(p.d - q.d) > distTol) continue;
    uf.union(tris[0], tris[1]);
  }

  const groups = new Map();
  const triangleFace = new Int32Array(count).fill(-1);
  for (let t = 0; t < count; t++) {
    if (!planes[t]) continue;
    const root = uf.find(t);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  }

  const faces = [];
  for (const tris of groups.values()) {
    const face = summariseFace(mesh, tris, planes);
    // Checked before anything reads `face.loops`, so a sliver never pays to
    // have its outline chained. On a finely tessellated organic model most
    // groups are slivers, which made this the bulk of the work thrown away.
    if (face.area < minArea) continue;
    face.id = `F${faces.length}`;
    face.index = faces.length;
    for (const t of tris) triangleFace[t] = face.index;
    faces.push(face);
  }

  // Biggest first: the face someone means is nearly always a big one, and a
  // list that opens on 400 slivers is a list nobody reads.
  faces.sort((a, b) => b.area - a.area);
  faces.forEach((f, i) => {
    face_reindex(f, i);
    for (const t of f.triangles) triangleFace[t] = i;
  });
  return { faces, triangleFace };
}

function face_reindex(face, i) {
  face.index = i;
  face.id = `F${i}`;
}

/** Area, centroid, bounds and outline of one merged face. */
function summariseFace(mesh, tris, planes) {
  let area = 0;
  let cx = 0, cy = 0, cz = 0;
  let nx = 0, ny = 0, nz = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const t of tris) {
    const p = planes[t];
    if (!p) continue;
    area += p.area;
    // Area-weighted, so a face made of one huge and ten tiny triangles has its
    // centroid where the material is rather than where the tessellation is.
    nx += p.n[0] * p.area; ny += p.n[1] * p.area; nz += p.n[2] * p.area;
    for (const v of triVerts(mesh, t)) {
      const x = px(mesh, v), y = py(mesh, v), z = pz(mesh, v);
      cx += x / 3 * p.area; cy += y / 3 * p.area; cz += z / 3 * p.area;
      if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
    }
  }

  const nlen = Math.hypot(nx, ny, nz) || 1;
  const normal = [nx / nlen, ny / nlen, nz / nlen];
  const centroid = area > 0 ? [cx / area, cy / area, cz / area] : [0, 0, 0];

  const face = {
    triangles: tris,
    area: Number(area.toFixed(4)),
    normal,
    centroid,
    bounds: { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] },
    plane: normal[0] * centroid[0] + normal[1] * centroid[1] + normal[2] * centroid[2],
    // Which way it faces, in words the operator uses. `up` is the only one a
    // 3-axis cutter can machine without the part being re-clamped or indexed.
    facing: facingOf(normal),
  };

  // The outline is chained on first read, not on detection.
  //
  // Only `toolpath/feature.js` ever wants it, and only for the one face the
  // operator selected — but detection produces thousands of faces on a curved
  // model, and building every one of their outlines up front was the single
  // largest cost in the pipeline. Defined as a value on first access so it is
  // still a plain property afterwards.
  let loops = null;
  Object.defineProperty(face, 'loops', {
    enumerable: true,
    configurable: true,
    get() {
      if (!loops) loops = faceLoops(mesh, tris);
      return loops;
    },
  });
  return face;
}

/** Cardinal direction of a normal, or 'angled' when it is off-axis. */
function facingOf(n) {
  const [x, y, z] = n;
  const tol = 0.985; // within ~10 degrees of an axis
  if (z > tol) return 'up';
  if (z < -tol) return 'down';
  if (Math.abs(z) < 0.174) {   // within 10 degrees of vertical
    if (x > tol) return 'right';
    if (x < -tol) return 'left';
    if (y > tol) return 'back';
    if (y < -tol) return 'front';
    return 'side';
  }
  return 'angled';
}

/**
 * The boundary loops of a set of triangles, as closed 3D polylines.
 *
 * An edge used once inside the set is on its boundary; used twice, it is
 * interior. Chaining those boundary edges gives the outline — and gives it
 * *per loop*, so a face with a hole through it comes back as an outer loop plus
 * an inner one rather than as a single tangled path.
 */
export function faceLoops(mesh, tris) {
  const used = new Map();
  for (const t of tris) {
    const [a, b, c] = triVerts(mesh, t);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = packEdge(u, v);
      const hit = used.get(k);
      if (hit) hit.count++;
      else used.set(k, { a: u, b: v, count: 1 });
    }
  }

  // Adjacency over boundary edges only.
  const adjacency = new Map();
  const push = (v, e) => {
    if (!adjacency.has(v)) adjacency.set(v, []);
    adjacency.get(v).push(e);
  };
  const pending = new Set();
  for (const [k, e] of used) {
    if (e.count !== 1) continue;
    pending.add(k);
    push(e.a, k);
    push(e.b, k);
  }

  const edges = used;
  const loops = [];
  while (pending.size > 0) {
    const startKey = pending.values().next().value;
    const startEdge = edges.get(startKey);
    pending.delete(startKey);

    const loop = [startEdge.a, startEdge.b];
    let current = startEdge.b;
    for (;;) {
      const next = (adjacency.get(current) || []).find((k) => pending.has(k));
      if (next == null) break;
      pending.delete(next);
      const e = edges.get(next);
      current = e.a === current ? e.b : e.a;
      if (current === loop[0]) break;   // closed
      loop.push(current);
    }
    if (loop.length >= 3) loops.push(loop.map((v) => [px(mesh, v), py(mesh, v), pz(mesh, v)]));
  }

  // Longest loop first: on a face with holes, the outer boundary is the one
  // with the most points, and callers overwhelmingly want it first.
  loops.sort((a, b) => b.length - a.length);
  return loops;
}

/**
 * Sharp edges, chained into polylines an operator can trace.
 *
 * A tessellated cylinder is covered in edges, and none of them is a feature —
 * they are all a few degrees apart, artefacts of faceting. A real edge is a
 * genuine change of direction, so the dihedral angle threshold is what
 * separates design from tessellation. 30° keeps a 32-sided hole (11° per facet)
 * smooth while catching every corner that was drawn as a corner.
 *
 * @param {{angleTol?:number, minLength?:number}} opts angle in degrees
 * @returns {object[]} polylines, longest first
 */
export function detectSharpEdges(mesh, opts = {}) {
  const { angleTol = 30, minLength = 1 } = opts;
  const cosTol = Math.cos((angleTol * Math.PI) / 180);
  const { planes, edges } = topology(mesh);

  const sharp = [];
  const adjacency = new Map();
  const push = (v, i) => {
    if (!adjacency.has(v)) adjacency.set(v, []);
    adjacency.get(v).push(i);
  };

  for (const [k, tris] of edges) {
    let isSharp = false;
    if (tris.length === 1) {
      isSharp = true;                    // an open boundary is always an edge
    } else if (tris.length === 2) {
      const [p, q] = [planes[tris[0]], planes[tris[1]]];
      if (!p || !q) continue;
      const dot = p.n[0] * q.n[0] + p.n[1] * q.n[1] + p.n[2] * q.n[2];
      isSharp = dot < cosTol;
    }
    if (!isSharp) continue;
    const [a, b] = unpackEdge(k);
    const i = sharp.length;
    sharp.push({ a, b });
    push(a, i);
    push(b, i);
  }

  // Chain edges through vertices where exactly two sharp edges meet. A vertex
  // with three is a corner where several edges converge, and running through it
  // would join two edges that a machinist sees as separate.
  const taken = new Set();
  const chains = [];
  for (let i = 0; i < sharp.length; i++) {
    if (taken.has(i)) continue;
    taken.add(i);
    const chain = [sharp[i].a, sharp[i].b];

    for (const direction of [1, 0]) {
      let end = direction ? chain[chain.length - 1] : chain[0];
      for (;;) {
        const at = adjacency.get(end) || [];
        if (at.length !== 2) break;
        const next = at.find((j) => !taken.has(j));
        if (next == null) break;
        taken.add(next);
        const e = sharp[next];
        end = e.a === end ? e.b : e.a;
        if (direction) chain.push(end); else chain.unshift(end);
        if (end === chain[0]) break;    // closed loop
      }
    }
    chains.push(chain);
  }

  const out = [];
  for (const chain of chains) {
    const points = chain.map((v) => [px(mesh, v), py(mesh, v), pz(mesh, v)]);
    const length = polylineLength(points);
    if (length < minLength) continue;
    out.push({
      points,
      length: Number(length.toFixed(3)),
      closed: chain.length > 2 && chain[0] === chain[chain.length - 1],
      bounds: boundsOfPoints(points),
    });
  }
  out.sort((a, b) => b.length - a.length);
  out.forEach((e, i) => { e.id = `E${i}`; e.index = i; });
  return out;
}

/** Length of an open polyline. */
export function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
      points[i][2] - points[i - 1][2],
    );
  }
  return len;
}

function boundsOfPoints(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/**
 * Everything pointable about a mesh, in one pass.
 *
 * Expensive — it walks every edge twice — so the result is cached against the
 * mesh itself, not merely against whatever context asked for it.
 *
 * That distinction is the whole point. `camPlanStore.prepare()` builds a *new*
 * plan context every time the operator changes machine, process or datum, and
 * the context's lazy `features` getter died with the old one — so every one of
 * those settings changes paid full re-detection on the next render, on a mesh
 * that had not changed at all. Keying the cache on the mesh means only a
 * genuinely new mesh (a re-import, a lay-down, a datum shift) pays again.
 *
 * Only the default options are cached: a caller passing custom tolerances is
 * asking a different question and gets it computed.
 */
const _featureCache = new WeakMap();
export function detectFeatures(mesh, opts = {}) {
  const cacheable = !opts.faces && !opts.edges;
  if (cacheable) {
    const hit = _featureCache.get(mesh);
    if (hit) return hit;
  }
  const { faces, triangleFace } = detectPlanarFaces(mesh, opts.faces);
  const edges = detectSharpEdges(mesh, opts.edges);
  const result = { faces, triangleFace, edges };
  if (cacheable) _featureCache.set(mesh, result);
  return result;
}

/** Which merged face a picked triangle belongs to, or null. */
export function faceOfTriangle(features, triangleIndex) {
  if (triangleIndex == null || triangleIndex < 0) return null;
  const i = features.triangleFace?.[triangleIndex];
  return i == null || i < 0 ? null : features.faces[i] ?? null;
}

/** A short human label for a face: what it is and how big. */
export function describeFace(face) {
  const [sx, sy] = face.bounds.size;
  return `${face.facing} face · ${Math.max(sx, sy).toFixed(1)} × ${Math.min(sx, sy).toFixed(1)} mm · ${face.area.toFixed(0)} mm²`;
}

/** A short human label for an edge chain. */
export function describeEdge(edge) {
  return `${edge.closed ? 'closed' : 'open'} edge · ${edge.length.toFixed(1)} mm · ${edge.points.length} points`;
}
