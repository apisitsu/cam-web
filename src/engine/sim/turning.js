/**
 * Phase 1 — turning material-removal simulation (radial profile field).
 *
 * A lathe part is a solid of revolution, so the milling height field doesn't
 * fit: the stock is a spinning cylinder and the tool removes material in the ZX
 * plane. The natural analogue of the dexel here is a **radial** field — one
 * remaining-radius per Z slice. The insert sweeps the ZX profile, lowering the
 * radius wherever it passes, and the finished `radius[z]` curve is revolved back
 * into a shaded solid.
 *
 * Turn-mode segments are already [radius, 0, z] (the interpreter halves the
 * diameter X into a radius and works in G18/ZX), so a feed move is just a line
 * in the (r, z) plane. The tool's **nose radius** rounds the swept profile, the
 * one insert parameter that actually changes the cut, so it is a first-class
 * input here. Pure JS, no three / no DOM.
 */

/**
 * The two standard OD toolholders drawn for the marker, taken from the catalogue
 * drawings (image_tool/): **MVJNR** at a 93° lead (its insert angle is
 * adjustable) and **MVVNN** at a 72.5° lead (a fixed VNMG 35° insert). `lead`
 * fixes the holder's approach angle; `angle` is the insert's included nose angle
 * (adjustable only when `adjustable`); the sim itself always cuts sharp.
 */
export const STANDARD_TURN_TOOLS = [
  // OD turning holders — a straight shank with an insert seated at the lead angle.
  { id: 'mvjnr', label: 'MVJNR · 93° OD (insert adj.)', kind: 'od', lead: 93, sides: 4, angle: 35, adjustable: true, tipOut: 1.8, flip: true },
  { id: 'mvvnn', label: 'MVVNN · 72.5° OD (VNMG 35°)', kind: 'od', lead: 72.5, sides: 4, angle: 35, adjustable: false, tipOut: 0 },
  { id: 'dclnr', label: 'DCLNR · 95° OD (DNMG 55°)', kind: 'od', lead: 95, sides: 4, angle: 55, adjustable: false, flip: true },
  { id: 'sclcr', label: 'SCLCR · 95° OD (CNMG 80°)', kind: 'od', lead: 95, sides: 4, angle: 80, adjustable: false, flip: true },
  // A boring bar reaching into the bore, insert cutting the ID (marker only —
  // the sim still carves an outer profile).
  { id: 'boring', label: 'Boring bar · ID (insert adj.)', kind: 'boring', lead: 93, sides: 4, angle: 35, adjustable: true },
  // A thin parting/grooving blade; `grooveW` is the cut width in mm.
  { id: 'parting', label: 'Parting / grooving blade', kind: 'parting', lead: 90, sides: 4, angle: 3, adjustable: false, grooveW: 3 },
];

/**
 * The Z of the facing cut — the finished +Z face of the part.
 *
 * A facing pass runs mostly radially (near-constant Z) and cuts in toward the
 * centre; everything on its +Z side is scrap the operator faces (or parts) off.
 * Without this the raw bar's clearance end (a couple mm past Z0) survives as a
 * stub sticking out beyond the face. Returns null when the program never faces.
 */
export function detectFaceZ(segments) {
  let faceZ = -Infinity;
  for (const s of segments || []) {
    if (s.type === 'rapid') continue;
    const dz = Math.abs(s.b[2] - s.a[2]);
    const dr = Math.abs(s.b[0] - s.a[0]);
    const minR = Math.min(s.a[0], s.b[0]);
    if (dr > 1 && dz < dr * 0.25 && minR < 3) {
      faceZ = Math.max(faceZ, s.a[2], s.b[2]);
    }
  }
  return Number.isFinite(faceZ) ? faceZ : null;
}

/**
 * Cylindrical stock over a Z range, one remaining radius per slice.
 * @param {{min:number[],max:number[]}} bounds  turn-mode (radius,_,z) bounds
 * @param {number} [faceZ]  cap the +Z end here (the faced-off face)
 */
export function createTurningStock(
  bounds, { cellSize = 0.5, margin = 1, rStock, faceZ, chuckClear = 0 } = {},
) {
  const cs = cellSize;
  // End the billet at the faced face when the program faces off the end, so no
  // scrap stub survives past Z0; otherwise leave a small clearance.
  const zMax = faceZ != null ? faceZ : bounds.max[2] + margin;
  // Extend the −Z end by the chuck clearance so the raw bar reaches into the
  // chuck (held past the deepest cut); this section is never machined, so it
  // stays at the full bar radius.
  const zMinWanted = bounds.min[2] - Math.max(margin, chuckClear);
  const nz = Math.max(1, Math.ceil((zMax - zMinWanted) / cs));
  // Align the grid so its **+Z edge lands exactly on zMax**, taking up the
  // rounding at the −Z end (which is buried in the chuck). Otherwise the last
  // cell straddles the faced face: the billet pokes past it, and the facing
  // move — a purely axial cut this radial field cannot represent — lands inside
  // that cell and collapses it to r=0, so the face reads as a cone, not flat.
  const zMin = zMax - nz * cs;
  // Raw bar radius: the widest the tool reaches (the OD it starts from), unless
  // the caller pins it. Clamp to a sane minimum so a degenerate program still
  // shows a billet.
  const r0 = rStock ?? Math.max(bounds.max[0], 0.5);
  const radius = new Float32Array(nz).fill(r0);
  return { zMin, zMax, cs, nz, radius, rStock: r0 };
}

/** Reset a turning stock to the solid bar (for scrubbing back). */
export function resetTurningStock(stock) {
  stock.radius.fill(stock.rStock);
}

function zCell(stock, z) {
  return Math.floor((z - stock.zMin) / stock.cs);
}

/** Stamp the round nose at profile point (r, z): lower each slice it reaches. */
function stampTurning(stock, r, z, noseR) {
  const rr = Math.max(0, r);
  let removed = 0;
  // A cut at (or past) the faced face is the facing pass itself. The billet is
  // already truncated there, so stamping it would only eat into the last slice
  // and round the face off. Belt-and-braces with the grid alignment above, which
  // puts zMax on a cell edge — this also absorbs floating-point drift.
  if (stock.zMax != null && z >= stock.zMax - 1e-9) return removed;
  if (noseR <= 0) {
    const k = zCell(stock, z);
    if (k >= 0 && k < stock.nz && rr < stock.radius[k]) {
      removed += stock.radius[k] - rr;
      stock.radius[k] = rr;
    }
    return removed;
  }
  const k0 = Math.max(0, zCell(stock, z - noseR));
  const k1 = Math.min(stock.nz - 1, zCell(stock, z + noseR));
  for (let k = k0; k <= k1; k++) {
    const dz = stock.zMin + (k + 0.5) * stock.cs - z;
    if (Math.abs(dz) > noseR) continue;
    // Nose surface: a circle of radius noseR whose lowest point is the tip.
    const surf = Math.max(0, rr + noseR - Math.sqrt(noseR * noseR - dz * dz));
    if (surf < stock.radius[k]) {
      removed += stock.radius[k] - surf;
      stock.radius[k] = surf;
    }
  }
  return removed;
}

/** Sweep one feed move a→b (points are [radius,_,z]) with the insert. */
export function carveTurningMove(stock, a, b, noseR) {
  const ra = a[0];
  const rb = b[0];
  const za = a[2];
  const zb = b[2];

  if (noseR > 0) {
    // Round nose: sweep-sample and spread the nose over neighbouring slices.
    const dr = rb - ra;
    const dz = zb - za;
    const len = Math.hypot(dr, dz);
    const step = Math.max(stock.cs * 0.5, 1e-6);
    const n = Math.max(1, Math.ceil(len / step));
    let removed = 0;
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      removed += stampTurning(stock, ra + dr * t, za + dz * t, noseR);
    }
    return removed;
  }

  // Sharp corner: the exact lower envelope. A slice is cut only where the move
  // actually **crosses its centre**, and it takes the segment's radius there, so
  // the profile follows the programmed path.
  //
  // A move that stops short of a centre carves nothing. That matters on curves:
  // near the pole of an R or a spherical end the chords are very short in Z, and
  // treating them as facing cuts — collapsing the whole cell to their smallest
  // radius — punched a notch into the surface where the part is actually solid.
  // A true facing move needs no special case either: the end face comes from the
  // billet being truncated at it, and a shoulder is the step between neighbouring
  // slices that the axial passes already set.
  const dz = zb - za;
  const zLo = Math.min(za, zb);
  const zHi = Math.max(za, zb);
  // Slice centres sit at zMin + (k + 0.5)·cs, so the first centre at or above zLo
  // is k = ceil((zLo − zMin)/cs − 0.5).
  const k0 = Math.max(0, Math.ceil((zLo - stock.zMin) / stock.cs - 0.5));
  const k1 = Math.min(stock.nz - 1, Math.floor((zHi - stock.zMin) / stock.cs - 0.5));
  let removed = 0;
  for (let k = k0; k <= k1; k++) {
    const zc = stock.zMin + (k + 0.5) * stock.cs;
    const t = Math.abs(dz) < 1e-12 ? 0 : Math.max(0, Math.min(1, (zc - za) / dz));
    const r = Math.max(0, ra + (rb - ra) * t);
    if (r < stock.radius[k]) {
      removed += stock.radius[k] - r;
      stock.radius[k] = r;
    }
  }
  return removed;
}

/**
 * Per-tool nose-radius resolver: the user's override for a tool number wins,
 * else the global default. Lets a two-tool lathe program (a roughing insert then
 * a finishing insert) carve each pass with its own nose radius.
 * @param {Object<number,{noseR?:number}>} [overrides]
 * @returns {(seg:object)=>number}
 */
export function turningNoseResolver(defaultNose, overrides = {}) {
  const byNum = new Map(
    Object.entries(overrides || {})
      .filter(([, o]) => o && o.noseR != null)
      .map(([n, o]) => [Number(n), Math.max(0, o.noseR)]),
  );
  const base = Math.max(0, defaultNose ?? 0);
  return (seg) => (byNum.has(seg.tool) ? byNum.get(seg.tool) : base);
}

/**
 * Carve every feed move into the radial field.
 * @param {{noseR:number} | ((seg:object)=>number)} tool  one nose radius for all
 *   moves, or a resolver returning the nose radius for a given segment.
 */
export function carveTurning(stock, segments, tool) {
  const noseOf = typeof tool === 'function' ? tool : () => Math.max(0, tool.noseR ?? 0);
  let dropped = 0; // sum of radius reductions (for a rough removed-volume proxy)
  for (const s of segments) {
    if (s.type === 'rapid') continue;
    dropped += carveTurningMove(stock, s.a, s.b, noseOf(s));
  }
  // Proper removed volume: π·(r0² − r²) summed over slices.
  let removed = 0;
  for (let k = 0; k < stock.nz; k++) {
    removed += Math.PI * (stock.rStock * stock.rStock - stock.radius[k] * stock.radius[k]) * stock.cs;
  }
  return { removedVolume: removed, dropped };
}

/**
 * Revolve the radius profile into a shaded solid of revolution around the Z
 * (spindle) axis. Returns transferable typed arrays **including exact normals**
 * — a revolve's normals are known analytically, and letting the renderer average
 * face normals instead made the barrel read as a ring of flat facets.
 * @param {number} sides  angular divisions of the revolve
 * @param {number} [creaseDeg]  profile turns sharper than this keep a hard edge
 * @param {number} [simplifyTol]  mm the meshed profile may deviate from the field
 */
/**
 * Douglas–Peucker on the (z, r) profile: drop stations the surface does not need,
 * keeping every point within `tol` of the simplified polyline. The ends are
 * always kept. Pure; exported for testing.
 */
export function simplifyProfile(pts, tol) {
  if (!(tol > 0) || pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    const a = pts[lo];
    const b = pts[hi];
    const dz = b.z - a.z;
    const dr = b.r - a.r;
    const len = Math.hypot(dz, dr);
    let worst = -1;
    let worstAt = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = pts[i];
      // Perpendicular distance to the chord (degenerate chord → point distance).
      const d = len < 1e-12
        ? Math.hypot(p.z - a.z, p.r - a.r)
        : Math.abs(dr * (p.z - a.z) - dz * (p.r - a.r)) / len;
      if (d > worst) { worst = d; worstAt = i; }
    }
    if (worst > tol) {
      keep[worstAt] = 1;
      stack.push([lo, worstAt], [worstAt, hi]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

export function turningMesh(stock, sides = 96, { creaseDeg = 25, simplifyTol = 0.01 } = {}) {
  const { zMin, cs, nz, radius, rStock } = stock;
  const positions = [];
  const normals = [];
  const indices = [];
  const colors = [];
  // Machined (cut) surfaces read as bright steel; raw bar (never turned, still at
  // the stock radius) reads as amber, so cut and uncut material are told apart.
  const CUT = [0.80, 0.83, 0.88];
  const RAW = [0.80, 0.55, 0.26];
  const colOf = (k) => (radius[k] < rStock - 0.02 ? CUT : RAW);
  const rOf = (k) => Math.max(radius[k], 0);

  // Profile stations: the slice centres, **plus the billet's two true ends**.
  // Capping at the outermost slice centres instead would leave the part half a
  // cell short of the faced face, so a faced end would sit shy of where the tool
  // actually left it. The end stations repeat their neighbour's radius, making
  // the first and last bands cylindrical.
  const zMaxEdge = stock.zMax ?? zMin + nz * cs;
  const full = [];
  full.push({ z: zMin, r: rOf(0), col: colOf(0) });
  for (let k = 0; k < nz; k++) full.push({ z: zMin + (k + 0.5) * cs, r: rOf(k), col: colOf(k) });
  full.push({ z: zMaxEdge, r: rOf(nz - 1), col: colOf(nz - 1) });

  // Curved features (an R, a spherical end) need a *fine* radial field to be
  // accurate — near a vertical tangent the radius swings right across one slice —
  // but a fine field would also mean a ring per slice and a huge mesh. So the
  // profile is simplified to `simplifyTol` first: the field stays dense, while
  // long straight runs collapse to a couple of rings and rings are spent where
  // the profile actually curves.
  const st = simplifyProfile(full, simplifyTol);
  const ns = st.length;

  // Normals are computed here rather than left to the renderer's face averaging,
  // because we know the exact surface: a solid of revolution. Each band between
  // two rings is a frustum whose normal in the (radial, z) plane is perpendicular
  // to the profile, and revolving that gives an exact normal at every vertex —
  // so the barrel shades as a true cylinder instead of a ring of facets.
  const band = [];
  for (let k = 0; k < ns - 1; k++) {
    const dr = st[k + 1].r - st[k].r;
    const dz = st[k + 1].z - st[k].z;
    const len = Math.hypot(dz, dr) || 1;
    band.push({ nr: dz / len, nz: -dr / len });
  }

  // One ring of vertices at station `k`, carrying the profile normal `n`.
  let vcount = 0;
  const pushRing = (k, n, col) => {
    const base = vcount;
    const { z, r } = st[k];
    const c = col ?? st[k].col;
    for (let a = 0; a < sides; a++) {
      const th = (a / sides) * Math.PI * 2;
      const ca = Math.cos(th);
      const sa = Math.sin(th);
      positions.push(r * ca, r * sa, z);
      normals.push(n.nr * ca, n.nr * sa, n.nz);
      colors.push(c[0], c[1], c[2]);
    }
    vcount += sides;
    return base;
  };

  // Where two bands meet gently the ring is shared and its normal averaged, so
  // the surface reads as one continuous curve. Where they meet at a real corner
  // — a shoulder, the faced end — the ring is emitted twice, once per band, so
  // the edge stays crisp instead of being smeared round.
  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180);
  const bandStart = new Array(Math.max(0, ns - 1));
  const bandEnd = new Array(Math.max(0, ns - 1));
  for (let k = 0; k < ns; k++) {
    const left = k > 0 ? band[k - 1] : null;
    const right = k < ns - 1 ? band[k] : null;
    if (left && right) {
      if (left.nr * right.nr + left.nz * right.nz >= cosCrease) {
        const nr = left.nr + right.nr;
        const nzz = left.nz + right.nz;
        const l = Math.hypot(nr, nzz) || 1;
        const base = pushRing(k, { nr: nr / l, nz: nzz / l });
        bandEnd[k - 1] = base;
        bandStart[k] = base;
      } else {
        bandEnd[k - 1] = pushRing(k, left);
        bandStart[k] = pushRing(k, right);
      }
    } else if (right) {
      bandStart[k] = pushRing(k, right);
    } else if (left) {
      bandEnd[k - 1] = pushRing(k, left);
    } else {
      pushRing(k, { nr: 1, nz: 0 }); // single-slice stock: a bare disc
    }
  }

  // Side wall quads, each band between its own start/end ring copies. Wound so
  // the faces agree with the outward normals above — the old winding was inward
  // and only went unnoticed because the material draws both sides.
  for (let k = 0; k < ns - 1; k++) {
    const b = bandStart[k];
    const n = bandEnd[k];
    for (let a = 0; a < sides; a++) {
      const a2 = (a + 1) % sides;
      indices.push(b + a, n + a2, n + a, b + a, b + a2, n + a2);
    }
  }

  // End caps: a centre vertex fanned to a dedicated rim ring facing along the
  // axis, so the cap stays flat and its edge sharp. The −Z cap is the raw bar
  // end (into the chuck); the +Z cap is the faced (cut) face.
  const cap = (k, dir, col) => {
    const rim = pushRing(k, { nr: 0, nz: dir }, col);
    const centre = vcount;
    positions.push(0, 0, st[k].z);
    normals.push(0, 0, dir);
    colors.push(col[0], col[1], col[2]);
    vcount += 1;
    for (let a = 0; a < sides; a++) {
      const a2 = (a + 1) % sides;
      if (dir < 0) indices.push(centre, rim + a2, rim + a);
      else indices.push(centre, rim + a, rim + a2);
    }
  };
  cap(0, -1, RAW);          // the raw bar end, inside the chuck
  cap(ns - 1, 1, CUT);      // the faced face, exactly at the billet's +Z edge

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    colors: new Float32Array(colors),
    rings: nz,
  };
}
