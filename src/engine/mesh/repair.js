/**
 * Close the cracks a mesh boolean leaves in its result.
 *
 * `three-bvh-csg` splits each triangle where the other solid crosses it, but it
 * does not split the neighbour on the far side of that triangle's edge. The new
 * corner then sits in the middle of the neighbour's edge — a **T-junction** — and
 * the two triangles no longer share that edge. On screen the gap is a line of
 * background showing through the part; to anything that walks the surface (a
 * slice, a section) it is an open edge where there should be none. The same
 * boolean also leaves triangles with no area at all.
 *
 * This puts the surface back together:
 *
 * 1. corners closer than `tol` are one corner;
 * 2. a triangle with no area is dropped;
 * 3. a triangle with another corner lying on an **open** edge of it — one no
 *    neighbour shares — is split at that corner, until no open edge has one.
 *
 * Only open edges are looked at, because only there can a T-junction be: an edge
 * a neighbour runs back along is already closed. Looking at every edge found
 * "corners on edges" that were only close to the long thin triangles a boolean
 * fans round a hole, split them by the thousand and bent the surface doing it.
 *
 * Splitting at a point on an edge cuts the triangle in two along a line from the
 * opposite corner, so both halves keep the original's facing and neither is
 * degenerate. Nothing is moved: every corner stays where the boolean put it.
 *
 * Plain arrays in and out, like the rest of `engine/`.
 *
 * @param {{positions:Float32Array, triangleCount:number}} soup
 * @param {{tol?:number, edgeTol?:number}} [opts]  mm. `tol` is how close two
 *   corners must be to be one; `edgeTol`, how close a corner must be to an open
 *   edge to sit on it. They are separate because they want different sizes: a
 *   corner computed along a long edge in single precision can miss the line by
 *   more than two genuinely distinct corners at a hole's mouth are apart.
 * @returns {{positions:Float32Array, triangleCount:number}}
 */
export function repairSoup(soup, { tol = 1e-4, edgeTol = tol } = {}) {
  const { verts, tris } = weld(soup.positions, tol);

  // Cells about a fiftieth of the part: an edge then crosses a handful of them,
  // where cells the size of the tolerance would number in the hundreds of thousands.
  const grid = vertexGrid(verts, Math.max(diagonalOf(verts) / 50, edgeTol * 10));
  // Directed edges of every live triangle, so an edge with a partner running the
  // other way is known closed. Kept current as triangles are dropped and split.
  const edges = new Map();
  const count = (t, by) => {
    for (let k = 0; k < 3; k++) {
      const key = `${t[k]},${t[(k + 1) % 3]}`;
      edges.set(key, (edges.get(key) || 0) + by);
    }
  };
  tris.forEach((t) => count(t, 1));
  const open = (a, b) => !(edges.get(`${b},${a}`) > 0);

  const out = [];
  // A worklist rather than recursion: a long edge on a finely cut neighbour can
  // need hundreds of splits, and each split triangle goes on the end of the list.
  // Read front to back, so a mesh that needs nothing comes out in its own order.
  const work = tris;
  const limit = tris.length * 64 + 1000;
  let i = 0;
  for (; i < work.length && i < limit; i++) {
    const t = work[i];
    // A split of a sliver can leave a half with no area; it covers nothing.
    if (area2(verts, t) <= tol * tol) { count(t, -1); continue; }
    const split = cornerOnEdge(verts, grid, t, edgeTol, open);
    if (!split) { out.push(t); continue; }
    const { edge, v } = split;
    const a = t[edge];
    const b = t[(edge + 1) % 3];
    const c = t[(edge + 2) % 3];
    const halves = [[a, v, c], [v, b, c]];
    count(t, -1);
    halves.forEach((h) => count(h, 1));
    work.push(...halves);
  }
  // Out of patience on something pathological: keep what is left as it was.
  out.push(...work.slice(i));

  const positions = new Float32Array(out.length * 9);
  out.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      positions.set(verts[t[k]], i * 9 + k * 3);
    }
  });
  return { ...soup, positions, triangleCount: out.length };
}

/**
 * How many edges of the surface have no partner running the other way — the open
 * edges and the wrongly wound ones. Zero for a closed, consistently wound solid.
 * Corners are matched exactly, so run it on what `repairSoup` returned.
 */
export function openEdgeCount(soup) {
  const p = soup.positions;
  const key = (i) => `${p[i]},${p[i + 1]},${p[i + 2]}`;
  const edges = new Map();
  for (let t = 0; t < soup.triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      const e = `${key(t * 9 + k * 3)}|${key(t * 9 + ((k + 1) % 3) * 3)}`;
      edges.set(e, (edges.get(e) || 0) + 1);
    }
  }
  let n = 0;
  for (const [e, c] of edges) {
    const bar = e.indexOf('|');
    if ((edges.get(`${e.slice(bar + 1)}|${e.slice(0, bar)}`) || 0) !== c) n++;
  }
  return n;
}

/** One index per distinct corner, merging any closer than `tol`. */
function weld(p, tol) {
  const verts = [];
  const cells = new Map();
  const cellOf = (x) => Math.round(x / tol);
  const find = (x, y, z) => {
    const cx = cellOf(x); const cy = cellOf(y); const cz = cellOf(z);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const i of list) {
            const v = verts[i];
            if (Math.abs(v[0] - x) <= tol && Math.abs(v[1] - y) <= tol && Math.abs(v[2] - z) <= tol) return i;
          }
        }
      }
    }
    const i = verts.length;
    verts.push([x, y, z]);
    const k = `${cx},${cy},${cz}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(i);
    return i;
  };
  const tris = [];
  for (let i = 0; i < p.length; i += 9) {
    const t = [find(p[i], p[i + 1], p[i + 2]), find(p[i + 3], p[i + 4], p[i + 5]), find(p[i + 6], p[i + 7], p[i + 8])];
    if (t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]) tris.push(t);
  }
  return { verts, tris };
}

function diagonalOf(verts) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], v[k]);
      hi[k] = Math.max(hi[k], v[k]);
    }
  }
  return verts.length ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 0;
}

/** Twice the triangle's area. */
function area2(verts, [i, j, k]) {
  const a = verts[i]; const b = verts[j]; const c = verts[k];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
}

/** A coarse grid over the corners, to find the ones near an edge without trying all of them. */
function vertexGrid(verts, size) {
  const cells = new Map();
  verts.forEach((v, i) => {
    const k = `${Math.floor(v[0] / size)},${Math.floor(v[1] / size)},${Math.floor(v[2] / size)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(i);
  });
  return { cells, size };
}

/** The first corner found lying inside one of the triangle's open edges, or null. */
function cornerOnEdge(verts, { cells, size }, t, tol, open) {
  for (let e = 0; e < 3; e++) {
    const ia = t[e];
    const ib = t[(e + 1) % 3];
    if (!open(ia, ib)) continue;
    const a = verts[ia];
    const b = verts[ib];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    if (len2 <= tol * tol) continue;
    const lo = [0, 1, 2].map((k) => Math.floor((Math.min(a[k], b[k]) - tol) / size));
    const hi = [0, 1, 2].map((k) => Math.floor((Math.max(a[k], b[k]) + tol) / size));
    for (let x = lo[0]; x <= hi[0]; x++) {
      for (let y = lo[1]; y <= hi[1]; y++) {
        for (let z = lo[2]; z <= hi[2]; z++) {
          const list = cells.get(`${x},${y},${z}`);
          if (!list) continue;
          for (const iv of list) {
            if (iv === ia || iv === ib || iv === t[(e + 2) % 3]) continue;
            const v = verts[iv];
            const w = [v[0] - a[0], v[1] - a[1], v[2] - a[2]];
            const s = (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / len2;
            if (s <= 0 || s >= 1) continue;
            const off = [w[0] - d[0] * s, w[1] - d[1] * s, w[2] - d[2] * s];
            if (off[0] * off[0] + off[1] * off[1] + off[2] * off[2] > tol * tol) continue;
            // Not a corner of the edge itself, however close to one.
            const along = Math.sqrt(len2);
            if (s * along <= tol || (1 - s) * along <= tol) continue;
            return { edge: e, v: iv };
          }
        }
      }
    }
  }
  return null;
}
