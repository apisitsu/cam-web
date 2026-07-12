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
  // Extend the −Z end by the chuck clearance so the raw bar reaches into the
  // chuck (held past the deepest cut); this section is never machined, so it
  // stays at the full bar radius.
  const zMin = bounds.min[2] - Math.max(margin, chuckClear);
  // End the billet at the faced face when the program faces off the end, so no
  // scrap stub survives past Z0; otherwise leave a small clearance.
  const zMax = faceZ != null ? faceZ : bounds.max[2] + margin;
  const nz = Math.max(1, Math.ceil((zMax - zMin) / cs));
  // Raw bar radius: the widest the tool reaches (the OD it starts from), unless
  // the caller pins it. Clamp to a sane minimum so a degenerate program still
  // shows a billet.
  const r0 = rStock ?? Math.max(bounds.max[0], 0.5);
  const radius = new Float32Array(nz).fill(r0);
  return { zMin, cs, nz, radius, rStock: r0 };
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

  // Sharp corner: the exact lower envelope — every slice the move spans takes the
  // segment's radius at that slice centre, so the profile follows the programmed
  // path precisely. A near-vertical (facing) move collapses to its deepest radius.
  const dz = zb - za;
  const zLo = Math.min(za, zb);
  const zHi = Math.max(za, zb);
  const k0 = Math.max(0, zCell(stock, zLo));
  const k1 = Math.min(stock.nz - 1, zCell(stock, zHi));
  const facing = Math.abs(dz) < stock.cs * 0.5;
  let removed = 0;
  for (let k = k0; k <= k1; k++) {
    const zc = stock.zMin + (k + 0.5) * stock.cs;
    const t = facing ? 0 : Math.max(0, Math.min(1, (zc - za) / dz));
    const r = Math.max(0, facing ? Math.min(ra, rb) : ra + (rb - ra) * t);
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
 * (spindle) axis. Returns transferable typed arrays; normals are recomputed in
 * the renderer, so we ship only positions + indices.
 * @param {number} sides  angular divisions of the revolve
 */
export function turningMesh(stock, sides = 48) {
  const { zMin, cs, nz, radius, rStock } = stock;
  const positions = [];
  const indices = [];
  const colors = [];
  // Machined (cut) surfaces read as bright steel; raw bar (never turned, still at
  // the stock radius) reads as amber, so cut and uncut material are told apart.
  const CUT = [0.80, 0.83, 0.88];
  const RAW = [0.80, 0.55, 0.26];
  const colOf = (k) => (radius[k] < rStock - 0.02 ? CUT : RAW);

  // Ring vertices: one ring per slice centre.
  const zOf = (k) => zMin + (k + 0.5) * cs;
  for (let k = 0; k < nz; k++) {
    const z = zOf(k);
    const r = Math.max(radius[k], 0);
    const col = colOf(k);
    for (let a = 0; a < sides; a++) {
      const th = (a / sides) * Math.PI * 2;
      positions.push(r * Math.cos(th), r * Math.sin(th), z);
      colors.push(col[0], col[1], col[2]);
    }
  }
  // Side wall quads between consecutive rings.
  for (let k = 0; k < nz - 1; k++) {
    const base = k * sides;
    const next = (k + 1) * sides;
    for (let a = 0; a < sides; a++) {
      const a2 = (a + 1) % sides;
      indices.push(base + a, next + a, next + a2, base + a, next + a2, base + a2);
    }
  }
  // End caps: a centre vertex fanned to the first and last ring. The −Z cap is
  // the raw bar end (into the chuck); the +Z cap is the faced (cut) face.
  const c0 = positions.length / 3;
  positions.push(0, 0, zOf(0));
  colors.push(RAW[0], RAW[1], RAW[2]);
  for (let a = 0; a < sides; a++) {
    const a2 = (a + 1) % sides;
    indices.push(c0, a2, a); // −Z cap (wound to face outward)
  }
  const c1 = positions.length / 3;
  positions.push(0, 0, zOf(nz - 1));
  colors.push(CUT[0], CUT[1], CUT[2]);
  const last = (nz - 1) * sides;
  for (let a = 0; a < sides; a++) {
    const a2 = (a + 1) % sides;
    indices.push(c1, last + a, last + a2); // +Z cap
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    colors: new Float32Array(colors),
    rings: nz,
  };
}
