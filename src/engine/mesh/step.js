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
  // A triangle with no area (its corners in a line, as a boolean leaves along
  // a seam) has no plane of its own: it goes with whichever face is beside it.
  const flat0 = new Uint8Array(T);
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3; const b = I[t * 3 + 1] * 3; const c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a]; const uy = P[b + 1] - P[a + 1]; const uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a]; const vy = P[c + 1] - P[a + 1]; const vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy; let ny = uz * vx - ux * vz; let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    const e2 = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz);
    if (l <= 1e-9 * e2) flat0[t] = 1;
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
    if (faceOf[s] >= 0 || flat0[s]) continue;
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
          if (flat0[o]) { faceOf[o] = f; tris.push(o); continue; }
          const dot = normal[o * 3] * n[0] + normal[o * 3 + 1] * n[1] + normal[o * 3 + 2] * n[2];
          if (dot < 1 - angTol || Math.abs(dist[o] - d) > distTol) continue;
          faceOf[o] = f;
          stack.push(o);
        }
      }
    }
    faces.push({ tris, normal: n, d });
  }
  // Any with no face beside them (only others like them) make one of their own.
  for (let s = 0; s < T; s++) {
    if (faceOf[s] >= 0) continue;
    faceOf[s] = faces.length;
    faces.push({ tris: [s], normal: [normal[s * 3], normal[s * 3 + 1], normal[s * 3 + 2]], d: dist[s] });
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

const EK = 4294967296;
/** One number for the edge between vertices a and b, either way round. */
const edgeKey = (a, b) => (a < b ? a * EK + b : b * EK + a);

const v3 = (P, v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.sqrt(vdot(a, a));
const vunit = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Circle through three 2D points: { x, y, r }, or null when they are in line. */
function circle3(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const s = (p) => p[0] * p[0] + p[1] * p[1];
  const x = (s(a) * (b[1] - c[1]) + s(b) * (c[1] - a[1]) + s(c) * (a[1] - b[1])) / d;
  const y = (s(a) * (c[0] - b[0]) + s(b) * (a[0] - c[0]) + s(c) * (b[0] - a[0])) / d;
  return { x, y, r: Math.hypot(a[0] - x, a[1] - y) };
}

/** Least-squares circle through 2D points (Kåsa): { x, y, r }, or null. */
function fitCircle(pts) {
  const n = pts.length;
  if (n < 3) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let suu = 0; let svv = 0; let suv = 0; let suuu = 0; let svvv = 0; let suvv = 0; let svuu = 0;
  for (const [x, y] of pts) {
    const u = x - mx; const v = y - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-18) return null;
  const r1 = (suuu + suvv) / 2; const r2 = (svvv + svuu) / 2;
  const uc = (r1 * svv - r2 * suv) / det;
  const vc = (r2 * suu - r1 * suv) / det;
  return { x: uc + mx, y: vc + my, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) };
}

/**
 * The round walls of the mesh: runs of narrow flat faces (strips) that lie on
 * one surface of revolution between two circles — a drilled hole or a boss
 * (cylinder), a countersink, a chamfered or drafted hole (cone), and each band
 * of a rounded rim or a ball corner (written as the cone through its two
 * circles). A strip is a four-cornered face whose two edges across the run are
 * parallel chords of the two circles; neighbours share the edges along it.
 * Each run is cut at the same two half turns about its axis, so two runs that
 * share a circle cut it at the same points and share its arcs.
 *
 * `loops[f]` are face f's boundary loops (already thinned). Returns the pieces
 * (`{ faces, axis, a: {centre, r}, b: {centre, r} }`), the faces they take
 * over, and for every mesh edge along a rim the arc it is part of
 * (`{ verts, centre, axis, r }`).
 */
export function findCylinders(mesh, faces, loops) {
  const P = mesh.positions;
  const V = (v) => v3(P, v);
  const owner = new Map();
  loops.forEach((ls, fi) => ls.forEach((l) => l.forEach((v, i) => {
    const k = edgeKey(v, l[(i + 1) % l.length]);
    const o = owner.get(k);
    if (o) o.push(fi); else owner.set(k, [fi]);
  })));
  const quad = (fi) => (loops[fi].length === 1 && loops[fi][0].length === 4 ? loops[fi][0] : null);
  const parallel = (a, b) => vlen(vcross(a, b)) < 1e-4 * vlen(a) * vlen(b);
  const COS_MAX = Math.cos(Math.PI / 4);
  // The two edges either side of edge i of quad q (its rims, if i runs along).
  const rimsOk = (q, i) => parallel(vsub(V(q[i]), V(q[(i + 3) % 4])), vsub(V(q[(i + 2) % 4]), V(q[(i + 1) % 4])));

  const links = new Map(); // face → [{ to, a, b, i }]
  faces.forEach((f, fi) => {
    const q = quad(fi);
    if (!q) return;
    for (let i = 0; i < 4; i++) {
      const a = q[i]; const b = q[(i + 1) % 4];
      if (!rimsOk(q, i)) continue;
      const nj = (owner.get(edgeKey(a, b)) || []).find((x) => x !== fi);
      if (nj == null || nj < fi) continue;
      const r = quad(nj);
      if (!r) continue;
      const j = r.findIndex((v, k) => edgeKey(v, r[(k + 1) % 4]) === edgeKey(a, b));
      if (j < 0 || !rimsOk(r, j)) continue;
      const c = vdot(f.normal, faces[nj].normal);
      if (c < COS_MAX || c > 1 - 1e-9) continue;
      for (const [x, y, k] of [[fi, nj, i], [nj, fi, j]]) {
        const l = links.get(x);
        const link = {
          to: y, a, b, i: k,
        };
        if (l) l.push(link); else links.set(x, [link]);
      }
    }
  });

  const pieces = [];
  const taken = new Set();
  const arcOf = new Map();
  const arcByVerts = new Map();
  const seen = new Set();
  let run = 0;
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    run += 1;
    const comp = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const f = stack.pop();
      comp.push(f);
      for (const l of links.get(f)) if (!seen.has(l.to)) { seen.add(l.to); stack.push(l.to); }
    }
    // A single run: two links at most, and on opposite sides of the strip.
    if (comp.some((f) => links.get(f).length > 2
      || (links.get(f).length === 2 && (links.get(f)[0].i + 2) % 4 !== links.get(f)[1].i))) continue;
    const ring = comp.every((f) => links.get(f).length === 2);
    const first = ring ? start : comp.find((f) => links.get(f).length === 1);
    if (first == null) continue;
    const order = [first];
    const gens = [];
    let prev = null;
    let cur = first;
    while (order.length < comp.length) {
      const go = links.get(cur).find((l) => l.to !== prev && !order.includes(l.to));
      if (!go) break;
      gens.push([go.a, go.b]);
      prev = cur;
      cur = go.to;
      order.push(cur);
    }
    if (order.length !== comp.length) continue;
    // The edges along the run: the shared ones, closed by a ring's last or a
    // run's two outer ones (across each end strip from its link).
    const across = (f, link) => { const q = quad(f); return [q[(link.i + 2) % 4], q[(link.i + 3) % 4]]; };
    let G;
    if (ring) {
      const last = links.get(order[order.length - 1]).find((l) => l.to === first);
      if (!last) continue;
      G = [[last.a, last.b], ...gens, [last.a, last.b]];
    } else {
      const l0 = links.get(order[0])[0];
      const lN = links.get(order[order.length - 1]).find((l) => l.to === order[order.length - 2]);
      G = [across(order[0], l0), ...gens, across(order[order.length - 1], lN)];
    }
    // Line up the ends: side 0 of every edge on one rim, side 1 on the other.
    // Strip k joins G[k] to G[k+1]; the rim edge from G[k][0] goes to one of G[k+1].
    const sides = [G[0].slice()];
    for (let k = 0; k + 1 < G.length; k++) {
      const q = quad(order[Math.min(k, order.length - 1)]);
      const [x] = sides[k];
      const nextG = G[k + 1];
      const joined = (u, w) => q.some((v, i) => edgeKey(v, q[(i + 1) % 4]) === edgeKey(u, w));
      sides.push(joined(x, nextG[0]) ? nextG.slice() : [nextG[1], nextG[0]]);
    }
    // The axis: square to the plane of rim 0, from three of its points well apart.
    const rim0 = sides.map((s) => V(s[0]));
    const rim1 = sides.map((s) => V(s[1]));
    const mIdx = Math.floor(rim0.length / 2);
    const i0 = Math.max(0, mIdx - 1); const i2 = Math.min(rim0.length - 1, mIdx + 1);
    let d = vunit(vcross(vsub(rim0[mIdx], rim0[i0]), vsub(rim0[i2], rim0[mIdx])));
    if (!(vlen(vcross(vsub(rim0[mIdx], rim0[i0]), vsub(rim0[i2], rim0[mIdx]))) > 0)) continue;
    // One way round for every run, so runs on one axis agree about angles.
    const big = [0, 1, 2].reduce((m, k) => (Math.abs(d[k]) > Math.abs(d[m]) + 1e-9 ? k : m), 0);
    if (d[big] < 0) d = d.map((v) => -v);
    const e1 = vunit(Math.abs(d[0]) < 0.9 ? vcross(d, [1, 0, 0]) : vcross(d, [0, 1, 0]));
    const e2 = vcross(d, e1);
    const in2 = (p) => [vdot(p, e1), vdot(p, e2)];
    const h = (p) => vdot(p, d);
    // Rough circles from the middle three to find the run that is on them…
    const rough0 = circle3(in2(rim0[i0]), in2(rim0[mIdx]), in2(rim0[i2]));
    const rough1 = circle3(in2(rim1[i0]), in2(rim1[mIdx]), in2(rim1[i2]));
    if (!rough0 || !rough1 || !(rough0.r > 1e-3) || !(rough1.r > 1e-3) || rough0.r > 1e5 || rough1.r > 1e5) continue;
    const h0 = h(rim0[mIdx]); const h1 = h(rim1[mIdx]);
    if (Math.abs(h1 - h0) < 1e-6) continue; // a flat ring: that is a plane
    const nearC = (c, t) => (p) => Math.abs(Math.hypot(in2(p)[0] - c.x, in2(p)[1] - c.y) - c.r) <= t;
    const on0 = nearC(rough0, 1e-3 + 0.02 * rough0.r); const on1 = nearC(rough1, 1e-3 + 0.02 * rough1.r);
    const okRough = sides.map((s, i) => on0(rim0[i]) && on1(rim1[i])
      && Math.abs(h(rim0[i]) - h0) <= 1e-3 && Math.abs(h(rim1[i]) - h1) <= 1e-3);
    let lo = mIdx; let hi = mIdx;
    while (lo > 0 && okRough[lo - 1]) lo--;
    while (hi < okRough.length - 1 && okRough[hi + 1]) hi++;
    if (!okRough[mIdx] || hi - lo < 2) continue;
    if (ring && (lo !== 0 || hi !== okRough.length - 1)) continue;
    // …then the circles through all of it, which must share one axis.
    const c0 = fitCircle(rim0.slice(lo, hi + 1).map(in2));
    const c1 = fitCircle(rim1.slice(lo, hi + 1).map(in2));
    if (!c0 || !c1) continue;
    const tol = 1e-3 + 1e-5 * Math.max(c0.r, c1.r);
    if (Math.hypot(c0.x - c1.x, c0.y - c1.y) > tol) continue;
    const t0 = nearC(c0, tol); const t1 = nearC(c1, tol);
    let good = true;
    for (let i = lo; i <= hi && good; i++) good = t0(rim0[i]) && t1(rim1[i]);
    if (!good) continue;
    const cx = (c0.x + c1.x) / 2; const cy = (c0.y + c1.y) / 2;
    const at = (hh) => [0, 1, 2].map((k) => cx * e1[k] + cy * e2[k] + hh * d[k]);
    // Cut at half turns from e1, as every run on this axis does.
    const half = (i) => {
      const p = in2(rim0[i]);
      // Turned off the axes by an odd amount: a facet corner sits on 0° or 90°
      // often, and there rounding would cut one ring a corner off from the next.
      const a = Math.atan2(p[1] - cy, p[0] - cx) - 0.1234567;
      return Math.floor(((a + 4 * Math.PI) % (2 * Math.PI)) / Math.PI);
    };
    // Where a half turn falls between edges i − 1 and i, the cut goes on the
    // one past it counter-clockwise — the same edge whichever way a run is walked.
    const angleOf = (i) => { const p = in2(rim0[i]); return Math.atan2(p[1] - cy, p[0] - cx); };
    const cutAt = (i) => {
      let s = angleOf(i) - angleOf(i - 1);
      while (s > Math.PI) s -= 2 * Math.PI;
      while (s < -Math.PI) s += 2 * Math.PI;
      return s > 0 ? i : i - 1;
    };
    if (ring) {
      // Start the ring at a half turn, so its pieces end where a ring
      // beside it on the same circle ends its own.
      const n = order.length;
      let s0 = 0;
      for (let i = 1; i < n; i++) if (half(i) !== half(i - 1)) { s0 = cutAt(i); break; }
      if (s0) {
        const rot = (arr) => arr.slice(s0, n).concat(arr.slice(0, s0));
        order.splice(0, n, ...rot(order));
        const sd = sides.slice(s0, n).concat(sides.slice(0, s0 + 1));
        sides.splice(0, sides.length, ...sd);
        rim0.splice(0, rim0.length, ...sides.map((x) => V(x[0])));
        rim1.splice(0, rim1.length, ...sides.map((x) => V(x[1])));
      }
    }
    const cuts = [lo];
    for (let i = lo + 1; i <= hi; i++) {
      if (half(i) === half(i - 1)) continue;
      const c = cutAt(i);
      if (c > cuts[cuts.length - 1] && c < hi) cuts.push(c);
    }
    cuts.push(hi);
    const rimArc = (verts, centre, r) => {
      const key = (verts[0] < verts[verts.length - 1] ? verts : verts.slice().reverse()).join(',');
      let arc = arcByVerts.get(key);
      if (!arc) {
        arc = {
          verts, centre, axis: d, r, runs: new Set(),
        };
        arcByVerts.set(key, arc);
      }
      arc.runs.add(run);
      for (let i = 0; i + 1 < verts.length; i++) {
        const k = edgeKey(verts[i], verts[i + 1]);
        const had = arcOf.get(k);
        if (had && had !== arc) had.clash = true;
        arcOf.set(k, arc);
      }
      return arc;
    };
    for (let k = 0; k + 1 < cuts.length; k++) {
      const [i0c, i1c] = [cuts[k], cuts[k + 1]];
      if (i1c - i0c < 1) continue;
      const strips = order.slice(i0c, i1c);
      const cA = at(h0); const cB = at(h1);
      rimArc(sides.slice(i0c, i1c + 1).map((s) => s[0]), cA, c0.r);
      rimArc(sides.slice(i0c, i1c + 1).map((s) => s[1]), cB, c1.r);
      strips.forEach((f) => taken.add(f));
      pieces.push({
        faces: strips, axis: d, a: { centre: cA, r: c0.r }, b: { centre: cB, r: c1.r }, run,
      });
    }
  }

  // Every arc must be met whole by each face along it: a piece does that by
  // construction, a flat face only if it runs the whole arc (a hole's top
  // face does; the flat strips of a run left out do not). A run whose arcs
  // fail is left out too, which can fail its neighbours' arcs in turn.
  const dropped = new Set();
  for (let changed = true; changed;) {
    changed = false;
    const arcs = new Set(arcOf.values());
    for (const arc of arcs) {
      if ([...arc.runs].every((r) => dropped.has(r))) continue;
      const need = arc.verts.length - 1;
      const tally = new Map();
      for (let i = 0; i < need; i++) {
        for (const f of owner.get(edgeKey(arc.verts[i], arc.verts[i + 1])) || []) {
          if (taken.has(f)) continue;
          tally.set(f, (tally.get(f) || 0) + 1);
        }
      }
      if (!arc.clash && [...tally.values()].every((c) => c === need)) continue;
      for (const r of arc.runs) {
        if (dropped.has(r)) continue;
        dropped.add(r);
        changed = true;
        for (const pc of pieces) if (pc.run === r) pc.faces.forEach((f) => taken.delete(f));
      }
    }
  }
  const kept = pieces.filter((pc) => !dropped.has(pc.run));
  for (const [k, arc] of [...arcOf]) if ([...arc.runs].every((r) => dropped.has(r))) arcOf.delete(k);
  for (const arc of new Set(arcOf.values())) {
    if ([...arc.runs].some((r) => dropped.has(r))) {
      // Shared with a run left out: that run's strips are flat now, so the
      // arc cannot stand — which the loop above has already caught.
      return { pieces: [], taken: new Set(), arcOf: new Map() };
    }
  }
  return { pieces: kept, taken, arcOf };
}

/**
 * The mesh as a STEP file. `mesh` is welded; closed (every edge on two
 * triangles) it is written as a solid, otherwise as its surfaces. `name` names
 * the product. Round walls go as true cylinders and cones (`findCylinders`) unless
 * `cylinders` is false; should their edges not pair up, the file is written
 * all flat instead.
 *
 * @param {{positions: ArrayLike<number>, indices: ArrayLike<number>, triangleCount: number}} mesh
 * @param {{name?: string, date?: Date, cylinders?: boolean}} [opts]
 * @returns {string}
 */
export function meshToStep(mesh, { name = 'part', date = new Date(), cylinders = true } = {}) {
  const P = mesh.positions;
  const { faces, closed } = planarFaces(mesh);
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
  const thin = faceLoopsList.map((loops) => loops.map((l) => simplifyLoop(P, l, keep)));
  const cyl = cylinders ? findCylinders(mesh, faces, thin) : { pieces: [], taken: new Set(), arcOf: new Map() };

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
  const place = (o, n, r) => add(`AXIS2_PLACEMENT_3D('',#${typeof o === 'number' ? o : point(...o)},#${udir(...n)},#${udir(...r)})`);
  const uses = new Map(); // EDGE_CURVE id → senses it is used with, to check the shell
  const edgeId = new Map(); // edge key → EDGE_CURVE id, defined from the lower vertex
  const lineEdge = (a, b) => {
    const lo = Math.min(a, b); const hi = Math.max(a, b);
    const k = lo * EK + hi;
    if (!edgeId.has(k)) {
      const dx = P[hi * 3] - P[lo * 3]; const dy = P[hi * 3 + 1] - P[lo * 3 + 1]; const dz = P[hi * 3 + 2] - P[lo * 3 + 2];
      const len = Math.hypot(dx, dy, dz) || 1;
      const line = add(`LINE('',#${vpoint(lo)},#${add(`VECTOR('',#${udir(dx / len, dy / len, dz / len)},${stepReal(len, 6)})`)})`);
      edgeId.set(k, add(`EDGE_CURVE('',#${vertex(lo)},#${vertex(hi)},#${line},.T.)`));
    }
    return { id: edgeId.get(k), same: a < b };
  };
  const arcEdge = (arc) => {
    if (!arc.id) {
      const v0 = v3(P, arc.verts[0]);
      const v1 = v3(P, arc.verts[1]);
      const ref = vunit(vsub(v0, arc.centre));
      const circle = add(`CIRCLE('',#${place(arc.centre, arc.axis, ref)},${stepReal(arc.r, 6)})`);
      // Counter-clockwise about the axis from the first vertex to the second?
      const ccw = vdot(vcross(ref, vsub(v1, arc.centre)), arc.axis) > 0;
      arc.id = add(`EDGE_CURVE('',#${vertex(arc.verts[0])},#${vertex(arc.verts[arc.verts.length - 1])},#${circle},${ccw ? '.T.' : '.F.'})`);
    }
    return arc.id;
  };
  const oriented = (id, same) => {
    const u = uses.get(id);
    if (u) u.push(same); else uses.set(id, [same]);
    return `#${add(`ORIENTED_EDGE('',*,*,#${id},${same ? '.T.' : '.F.'})`)}`;
  };
  // A loop as oriented edges: a run of rim edges along one arc is that arc.
  const emitLoop = (loop) => {
    const n = loop.length;
    const arcAt = (i) => cyl.arcOf.get(edgeKey(loop[((i % n) + n) % n], loop[(((i + 1) % n) + n) % n]));
    let start = 0;
    for (let i = 0; i < n; i++) {
      const a = arcAt(i);
      if (!a || a !== arcAt(i - 1)) { start = i; break; }
    }
    const out = [];
    for (let s = 0; s < n;) {
      const i = start + s;
      const a = arcAt(i);
      if (a) {
        let j = s;
        while (j + 1 < n && arcAt(start + j + 1) === a) j++;
        out.push(oriented(arcEdge(a), loop[i % n] === a.verts[0]));
        s = j + 1;
      } else {
        const { id, same } = lineEdge(loop[i % n], loop[(i + 1) % n]);
        out.push(oriented(id, same));
        s += 1;
      }
    }
    return add(`EDGE_LOOP('',(${out.join(',')}))`);
  };

  const faceIds = [];
  faces.forEach((f, fi) => {
    if (cyl.taken.has(fi)) return;
    const loops = thin[fi];
    if (!loops.length) return;
    let outer = 0;
    let best = -Infinity;
    loops.forEach((l, i) => { const a = loopArea(P, l, f.normal); if (a > best) { best = a; outer = i; } });
    const bounds = loops.map((loop, i) => add(`${i === outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${emitLoop(loop)},.T.)`));
    const v0 = loops[outer][0];
    const ref = loops[outer][1];
    let rx = P[ref * 3] - P[v0 * 3]; let ry = P[ref * 3 + 1] - P[v0 * 3 + 1]; let rz = P[ref * 3 + 2] - P[v0 * 3 + 2];
    const [nx, ny, nz] = f.normal;
    const dn = rx * nx + ry * ny + rz * nz;
    rx -= dn * nx; ry -= dn * ny; rz -= dn * nz;
    const rl = Math.hypot(rx, ry, rz) || 1;
    const plane = add(`PLANE('',#${place(vpoint(v0), f.normal, [rx / rl, ry / rl, rz / rl])})`);
    faceIds.push(add(`ADVANCED_FACE('',(${bounds.map((b) => `#${b}`).join(',')}),#${plane},.T.)`));
  });
  for (const pc of cyl.pieces) {
    const tris = pc.faces.flatMap((fi) => faces[fi].tris);
    const loops = faceLoops(mesh, tris).map((l) => simplifyLoop(P, l, keep));
    if (loops.length !== 1) return meshToStep(mesh, { name, date, cylinders: false });
    // Facing: out of the solid, which is away from the axis on a boss and
    // towards it in a hole.
    const f0 = faces[pc.faces[0]];
    const q = v3(P, mesh.indices[f0.tris[0] * 3]);
    const radial = vsub(vsub(q, pc.a.centre), pc.axis.map((v) => v * vdot(vsub(q, pc.a.centre), pc.axis)));
    const same = vdot(radial, f0.normal) > 0;
    const ref = vunit(radial);
    // A cylinder where the two circles are one size, else the cone through them,
    // placed at its narrow end and opening along its axis.
    let surf;
    if (Math.abs(pc.a.r - pc.b.r) <= 1e-3 + 1e-5 * pc.a.r) {
      surf = add(`CYLINDRICAL_SURFACE('',#${place(pc.a.centre, pc.axis, ref)},${stepReal((pc.a.r + pc.b.r) / 2, 6)})`);
    } else {
      const [sm, lg] = pc.a.r < pc.b.r ? [pc.a, pc.b] : [pc.b, pc.a];
      const along = vsub(lg.centre, sm.centre);
      const semi = Math.atan((lg.r - sm.r) / vlen(along));
      surf = add(`CONICAL_SURFACE('',#${place(sm.centre, vunit(along), ref)},${stepReal(sm.r, 6)},${stepReal(semi)})`);
    }
    const bound = add(`FACE_OUTER_BOUND('',#${emitLoop(loops[0])},.T.)`);
    faceIds.push(add(`ADVANCED_FACE('',(#${bound}),#${surf},${same ? '.T.' : '.F.'})`));
  }
  // Every edge on two faces, once each way: otherwise the round walls did not
  // stitch, and the file is written flat.
  if (closed && cyl.pieces.length && [...uses.values()].some((u) => u.length !== 2 || u[0] === u[1])) {
    return meshToStep(mesh, { name, date, cylinders: false });
  }

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
