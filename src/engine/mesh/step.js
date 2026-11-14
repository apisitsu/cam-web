/**
 * STEP (ISO 10303-21, AP214) writer for a closed triangle mesh.
 *
 * The part is a mesh, so the solid written is a faceted B-rep: every set of
 * edge-joined, coplanar triangles becomes one planar face bounded by straight
 * edges, and the faces are stitched into one closed shell through shared edges
 * and vertices. A box comes out as six faces, twelve edges and eight vertices;
 * a round wall as the strip of flat faces it is drawn with. Any CAD reads it as
 * a solid (not as loose surfaces), but curved faces stay faceted — there is no
 * true cylinder or torus here to write.
 *
 * Pure: takes a welded mesh (`weld` in stl.js) and returns the file as text.
 */

/**
 * A STEP real: always with a decimal point, exponent as `E`. `digits` is the
 * decimal places kept — the mesh is float32, so a coordinate carries no more
 * than a micron's worth anyway.
 */
export function stepReal(v, digits = 9) {
  const f = 10 ** digits;
  const n = Math.round(v * f) / f;
  let s = String(n === 0 ? 0 : n);
  if (s.includes('e')) {
    const [m, e] = s.split('e');
    return `${m.includes('.') ? m : `${m}.`}E${e.startsWith('-') ? e : e.replace('+', '')}`;
  }
  if (!s.includes('.')) s += '.';
  return s;
}

const str = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Faces of the mesh: triangles grouped where an edge joins two whose planes
 * agree. `{ tris: number[], normal: [x,y,z], d }` each.
 */
export function planarFaces(mesh, angTol = 1e-6, distTol = 1e-5) {
  const { positions: P, indices: I, triangleCount: T } = mesh;
  const normal = new Float64Array(T * 3);
  const dist = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3; const b = I[t * 3 + 1] * 3; const c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a]; const uy = P[b + 1] - P[a + 1]; const uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a]; const vy = P[c + 1] - P[a + 1]; const vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy; let ny = uz * vx - ux * vz; let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    normal[t * 3] = nx; normal[t * 3 + 1] = ny; normal[t * 3 + 2] = nz;
    dist[t] = nx * P[a] + ny * P[a + 1] + nz * P[a + 2];
  }
  // Edge → the triangles on it.
  const edgeTris = new Map();
  const key = (u, v) => (u < v ? u * 4294967296 + v : v * 4294967296 + u);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const kk = key(I[t * 3 + k], I[t * 3 + ((k + 1) % 3)]);
      const list = edgeTris.get(kk);
      if (list) list.push(t); else edgeTris.set(kk, [t]);
    }
  }
  const faceOf = new Int32Array(T).fill(-1);
  const faces = [];
  for (let s = 0; s < T; s++) {
    if (faceOf[s] >= 0) continue;
    const f = faces.length;
    const n = [normal[s * 3], normal[s * 3 + 1], normal[s * 3 + 2]];
    const d = dist[s];
    const tris = [];
    const stack = [s];
    faceOf[s] = f;
    while (stack.length) {
      const t = stack.pop();
      tris.push(t);
      for (let k = 0; k < 3; k++) {
        const list = edgeTris.get(key(I[t * 3 + k], I[t * 3 + ((k + 1) % 3)]));
        if (!list || list.length !== 2) continue;
        for (const o of list) {
          if (faceOf[o] >= 0) continue;
          const dot = normal[o * 3] * n[0] + normal[o * 3 + 1] * n[1] + normal[o * 3 + 2] * n[2];
          if (dot < 1 - angTol || Math.abs(dist[o] - d) > distTol) continue;
          faceOf[o] = f;
          stack.push(o);
        }
      }
    }
    faces.push({ tris, normal: n, d });
  }
  let closed = true;
  for (const list of edgeTris.values()) if (list.length !== 2) { closed = false; break; }
  return { faces, faceOf, closed };
}

/**
 * Boundary loops of one face: its triangles' edges that no other triangle of
 * the face shares, chained head to tail in the triangles' own direction (so the
 * outer loop runs counter-clockwise seen from the face's normal, holes the
 * other way). Each loop is a list of vertex indices.
 */
function faceLoops(mesh, tris) {
  const I = mesh.indices;
  const directed = new Map(); // a→b as one number → [a, b], the inner edges cancelled
  const K = 4294967296;
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const a = I[t * 3 + k]; const b = I[t * 3 + ((k + 1) % 3)];
      const back = b * K + a;
      if (directed.has(back)) directed.delete(back);
      else directed.set(a * K + b, [a, b]);
    }
  }
  const out = new Map(); // vertex → outgoing boundary edges
  for (const [a, b] of directed.values()) {
    if (!out.has(a)) out.set(a, []);
    out.get(a).push(b);
  }
  const loops = [];
  for (const [start, nexts] of out) {
    while (nexts.length) {
      const loop = [start];
      let v = nexts.pop();
      let guard = directed.size + 1;
      while (v !== start && guard-- > 0) {
        loop.push(v);
        const list = out.get(v);
        if (!list || !list.length) break;
        v = list.pop();
      }
      if (v === start && loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

/** Twice the signed area of a loop seen along `n`. */
function loopArea(P, loop, n) {
  let x = 0; let y = 0; let z = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] * 3; const b = loop[(i + 1) % loop.length] * 3;
    x += P[a + 1] * P[b + 2] - P[a + 2] * P[b + 1];
    y += P[a + 2] * P[b] - P[a] * P[b + 2];
    z += P[a] * P[b + 1] - P[a + 1] * P[b];
  }
  return x * n[0] + y * n[1] + z * n[2];
}

/**
 * Drop the vertices of a loop that only continue a straight edge, when no other
 * face needs them there — `keep` holds the vertices where three or more faces
 * meet, which the neighbouring faces' loops share and so must stay.
 */
function simplifyLoop(P, loop, keep) {
  const out = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const v = loop[i];
    if (keep.has(v)) { out.push(v); continue; }
    const a = loop[(i - 1 + n) % n] * 3; const b = v * 3; const c = loop[(i + 1) % n] * 3;
    const ux = P[b] - P[a]; const uy = P[b + 1] - P[a + 1]; const uz = P[b + 2] - P[a + 2];
    const wx = P[c] - P[b]; const wy = P[c + 1] - P[b + 1]; const wz = P[c + 2] - P[b + 2];
    const cx = uy * wz - uz * wy; const cy = uz * wx - ux * wz; const cz = ux * wy - uy * wx;
    const lu = Math.hypot(ux, uy, uz); const lw = Math.hypot(wx, wy, wz);
    if (Math.hypot(cx, cy, cz) <= 1e-9 * lu * lw && ux * wx + uy * wy + uz * wz > 0) continue;
    out.push(v);
  }
  return out.length >= 3 ? out : loop;
}

/**
 * The mesh as a STEP file. `mesh` is welded; closed (every edge on two
 * triangles) it is written as a solid, otherwise as its surfaces. `name` names
 * the product.
 *
 * @param {{positions: ArrayLike<number>, indices: ArrayLike<number>, triangleCount: number}} mesh
 * @param {{name?: string, date?: Date}} [opts]
 * @returns {string}
 */
export function meshToStep(mesh, { name = 'part', date = new Date() } = {}) {
  const P = mesh.positions;
  const { faces, closed } = planarFaces(mesh);
  const lines = [];
  let next = 1;
  const add = (body) => { const id = next++; lines.push(`#${id}=${body};`); return id; };

  const appCtx = add("APPLICATION_CONTEXT('automotive design')");
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appCtx})`);
  const prodCtx = add(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);
  const product = add(`PRODUCT(${str(name)},${str(name)},'',(#${prodCtx}))`);
  add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${product}))`);
  const formation = add(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
  const defCtx = add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`);
  const def = add(`PRODUCT_DEFINITION('design','',#${formation},#${defCtx})`);
  const defShape = add(`PRODUCT_DEFINITION_SHAPE('','',#${def})`);
  const mm = add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const rad = add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const sr = add('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const unc = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#${mm},'distance_accuracy_value','confusion accuracy')`);
  const ctx = add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${mm},#${rad},#${sr}))REPRESENTATION_CONTEXT('Context3D','3D Context with 1E-06 uncertainty'))`);
  const point = (x, y, z) => add(`CARTESIAN_POINT('',(${stepReal(x, 6)},${stepReal(y, 6)},${stepReal(z, 6)}))`);
  const dir = (x, y, z) => add(`DIRECTION('',(${stepReal(x)},${stepReal(y)},${stepReal(z)}))`);
  const origin = add(`AXIS2_PLACEMENT_3D('',#${point(0, 0, 0)},#${dir(0, 0, 1)},#${dir(1, 0, 0)})`);

  // Loops first, so the vertices three faces share are known before any loop
  // is thinned.
  const faceLoopsList = faces.map((f) => faceLoops(mesh, f.tris));
  // How many faces each vertex is on (faces are walked in order, so a vertex
  // met again in the same face is not counted twice).
  const nv = P.length / 3;
  const lastFace = new Int32Array(nv).fill(-1);
  const faceCount = new Uint8Array(nv);
  faceLoopsList.forEach((loops, fi) => loops.forEach((loop) => loop.forEach((v) => {
    if (lastFace[v] !== fi) { lastFace[v] = fi; if (faceCount[v] < 255) faceCount[v] += 1; }
  })));
  const keep = { has: (v) => faceCount[v] >= 3 };

  // One point per mesh vertex, used by its vertex, by the lines that start
  // there and by the planes placed there.
  const pointId = new Map();
  const vpoint = (v) => {
    if (!pointId.has(v)) pointId.set(v, point(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]));
    return pointId.get(v);
  };
  const vertexId = new Map();
  const vertex = (v) => {
    if (!vertexId.has(v)) vertexId.set(v, add(`VERTEX_POINT('',#${vpoint(v)})`));
    return vertexId.get(v);
  };
  // Directions repeat (every wall of a prism shares its axis): one each.
  const dirId = new Map();
  const udir = (x, y, z) => {
    const k = `${stepReal(x)},${stepReal(y)},${stepReal(z)}`;
    if (!dirId.has(k)) dirId.set(k, add(`DIRECTION('',(${k}))`));
    return dirId.get(k);
  };
  const edgeId = new Map(); // "a,b" (a < b) → EDGE_CURVE id, defined a → b
  const edge = (a, b) => {
    const lo = Math.min(a, b); const hi = Math.max(a, b);
    const k = lo * 4294967296 + hi;
    if (!edgeId.has(k)) {
      const dx = P[hi * 3] - P[lo * 3]; const dy = P[hi * 3 + 1] - P[lo * 3 + 1]; const dz = P[hi * 3 + 2] - P[lo * 3 + 2];
      const len = Math.hypot(dx, dy, dz) || 1;
      const line = add(`LINE('',#${vpoint(lo)},#${add(`VECTOR('',#${udir(dx / len, dy / len, dz / len)},${stepReal(len, 6)})`)})`);
      edgeId.set(k, add(`EDGE_CURVE('',#${vertex(lo)},#${vertex(hi)},#${line},.T.)`));
    }
    return { id: edgeId.get(k), same: a < b };
  };

  const faceIds = [];
  faces.forEach((f, fi) => {
    const loops = faceLoopsList[fi].map((l) => simplifyLoop(P, l, keep));
    if (!loops.length) return;
    let outer = 0;
    let best = -Infinity;
    loops.forEach((l, i) => { const a = loopArea(P, l, f.normal); if (a > best) { best = a; outer = i; } });
    const bounds = loops.map((loop, i) => {
      const oriented = loop.map((v, k) => {
        const { id, same } = edge(v, loop[(k + 1) % loop.length]);
        return `#${add(`ORIENTED_EDGE('',*,*,#${id},${same ? '.T.' : '.F.'})`)}`;
      });
      const el = add(`EDGE_LOOP('',(${oriented.join(',')}))`);
      return add(`${i === outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${el},.T.)`);
    });
    const v0 = loops[outer][0];
    const ref = loops[outer][1];
    let rx = P[ref * 3] - P[v0 * 3]; let ry = P[ref * 3 + 1] - P[v0 * 3 + 1]; let rz = P[ref * 3 + 2] - P[v0 * 3 + 2];
    const [nx, ny, nz] = f.normal;
    const dn = rx * nx + ry * ny + rz * nz;
    rx -= dn * nx; ry -= dn * ny; rz -= dn * nz;
    const rl = Math.hypot(rx, ry, rz) || 1;
    const place = add(`AXIS2_PLACEMENT_3D('',#${vpoint(v0)},#${udir(nx, ny, nz)},#${udir(rx / rl, ry / rl, rz / rl)})`);
    const plane = add(`PLANE('',#${place})`);
    faceIds.push(add(`ADVANCED_FACE('',(${bounds.map((b) => `#${b}`).join(',')}),#${plane},.T.)`));
  });

  // A mesh with holes in it is no solid: it goes as the surfaces it is.
  const list = faceIds.map((f) => `#${f}`).join(',');
  let rep;
  if (closed) {
    const solid = add(`MANIFOLD_SOLID_BREP(${str(name)},#${add(`CLOSED_SHELL('',(${list}))`)})`);
    rep = add(`ADVANCED_BREP_SHAPE_REPRESENTATION(${str(name)},(#${origin},#${solid}),#${ctx})`);
  } else {
    const model = add(`SHELL_BASED_SURFACE_MODEL(${str(name)},(#${add(`OPEN_SHELL('',(${list}))`)}))`);
    rep = add(`MANIFOLD_SURFACE_SHAPE_REPRESENTATION(${str(name)},(#${origin},#${model}),#${ctx})`);
  }
  add(`SHAPE_DEFINITION_REPRESENTATION(#${defShape},#${rep})`);

  const stamp = date.toISOString().slice(0, 19);
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('Basic CAM Lite part'),'2;1');",
    `FILE_NAME(${str(`${name}.step`)},'${stamp}',(''),(''),'Basic CAM Lite','Basic CAM Lite','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

/** The mesh as a binary STL. */
export function meshToStlBinary(mesh, name = 'part') {
  const { positions: P, indices: I, triangleCount: T } = mesh;
  const buf = new ArrayBuffer(84 + T * 50);
  const view = new DataView(buf);
  const head = `Basic CAM Lite ${name}`.slice(0, 80);
  for (let i = 0; i < head.length; i++) view.setUint8(i, head.charCodeAt(i) & 0x7f);
  view.setUint32(80, T, true);
  let o = 84;
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3; const b = I[t * 3 + 1] * 3; const c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a]; const uy = P[b + 1] - P[a + 1]; const uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a]; const vy = P[c + 1] - P[a + 1]; const vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy; let ny = uz * vx - ux * vz; let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const v of [nx, ny, nz]) { view.setFloat32(o, v, true); o += 4; }
    for (const i of [a, b, c]) {
      for (let k = 0; k < 3; k++) { view.setFloat32(o, P[i + k], true); o += 4; }
    }
    o += 2;
  }
  return buf;
}
