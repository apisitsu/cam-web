/**
 * Phase 1+ — voxel material-removal simulation (undercut-capable).
 *
 * The height-field dexel (`dexel.js`) stores one top-Z per XY column, so it is
 * fast and correct for 3-axis work but blind to two things a real part needs:
 * material *under* an overhang (an undercut), and faces machined at different
 * rotary indices — a Z-up column can only be carved from directly above.
 *
 * A voxel grid drops both limits. Stock is a 3D boolean lattice (`solid`), and a
 * cut removes the swept volume of the *oriented* tool: each segment carries the
 * tool axis in the part frame (from its A/B index), so a cutter reaching in from
 * +Y clears exactly the voxels it passes through — undercuts included — and every
 * orientation carves into the same block. The trade is memory and time (a third
 * dimension), so this runs as a deliberate one-shot in the worker, not per
 * playback tick.
 *
 * Pure JS, no three / no DOM — it runs and tests under Node like the rest.
 */

const DEG = Math.PI / 180;

/**
 * Tool axis in the part frame for a rotary index — the direction the cutter
 * points, i.e. machine +Z rotated by A (about X) then B (about Y). Mirrors the
 * interpreter's toPartFrame() so the swept volume lines up with the geometry.
 */
export function toolAxisFor(aDeg = 0, bDeg = 0) {
  let x = 0;
  let y = 0;
  let z = 1;
  if (aDeg) {
    const t = -aDeg * DEG;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const ny = y * c - z * s;
    const nz = y * s + z * c;
    y = ny; z = nz;
  }
  if (bDeg) {
    const t = -bDeg * DEG;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const nx = x * c + z * s;
    const nz = -x * s + z * c;
    x = nx; z = nz;
  }
  return [x, y, z];
}

/**
 * Solid rectangular billet of voxels covering `bounds` + margin.
 * @param {{min:number[],max:number[]}} bounds  part-frame cutting bounds
 */
export function createVoxelStock(bounds, { margin = 3, cellSize = 1 } = {}) {
  const cs = cellSize;
  const ox = bounds.min[0] - margin;
  const oy = bounds.min[1] - margin;
  const oz = bounds.min[2] - margin;
  const nx = Math.max(1, Math.ceil((bounds.max[0] + margin - ox) / cs));
  const ny = Math.max(1, Math.ceil((bounds.max[1] + margin - oy) / cs));
  const nz = Math.max(1, Math.ceil((bounds.max[2] + margin - oz) / cs));
  const solid = new Uint8Array(nx * ny * nz).fill(1);
  return { ox, oy, oz, cs, nx, ny, nz, solid, count: nx * ny * nz };
}

/** Clear the oriented tool's swept solid at one tip position `p`. */
function stampVoxel(v, px, py, pz, ax, ay, az, r, ballR, length) {
  const { ox, oy, oz, cs, nx, ny, nz, solid } = v;
  // AABB bounding the cylinder from p to p + axis·length, fattened by r.
  const ex = px + ax * length;
  const ey = py + ay * length;
  const ez = pz + az * length;
  const loX = Math.min(px, ex) - r;
  const hiX = Math.max(px, ex) + r;
  const loY = Math.min(py, ey) - r;
  const hiY = Math.max(py, ey) + r;
  const loZ = Math.min(pz, ez) - r;
  const hiZ = Math.max(pz, ez) + r;

  const i0 = Math.max(0, Math.floor((loX - ox) / cs));
  const i1 = Math.min(nx - 1, Math.floor((hiX - ox) / cs));
  const j0 = Math.max(0, Math.floor((loY - oy) / cs));
  const j1 = Math.min(ny - 1, Math.floor((hiY - oy) / cs));
  const k0 = Math.max(0, Math.floor((loZ - oz) / cs));
  const k1 = Math.min(nz - 1, Math.floor((hiZ - oz) / cs));

  const r2 = r * r;
  let removed = 0;
  for (let k = k0; k <= k1; k++) {
    const cz = oz + (k + 0.5) * cs - pz;
    const kBase = k * nx * ny;
    for (let j = j0; j <= j1; j++) {
      const cy = oy + (j + 0.5) * cs - py;
      const rowBase = kBase + j * nx;
      for (let i = i0; i <= i1; i++) {
        const cx = ox + (i + 0.5) * cs - px;
        const idx = rowBase + i;
        if (!solid[idx]) continue;
        // Split the offset from the tip into along-axis and perpendicular parts.
        const axial = cx * ax + cy * ay + cz * az;
        const perp2 = cx * cx + cy * cy + cz * cz - axial * axial;
        let inside = false;
        if (axial >= ballR && axial <= length) {
          inside = perp2 <= r2; // straight flute
        } else if (ballR > 0 && axial >= 0 && axial < ballR) {
          // Hemispherical nose: inside the sphere centred ballR up the axis.
          const da = axial - ballR;
          inside = perp2 + da * da <= r2;
        } else if (ballR === 0 && axial >= 0 && axial <= length) {
          inside = perp2 <= r2; // flat bottom
        }
        if (inside) {
          solid[idx] = 0;
          removed++;
        }
      }
    }
  }
  return removed;
}

/**
 * Carve one straight move a→b with a tool pointing along `axis` (part frame).
 * @param {object} tool  { radius, type:'flat'|'ball', length? }
 */
export function carveVoxelMove(v, a, b, axis, tool) {
  const r = tool.radius;
  const ballR = tool.type === 'ball' ? r : 0;
  // Flute reach: the detected length, else clear through the whole block.
  const gridDiag = (v.nx + v.ny + v.nz) * v.cs;
  const length = tool.length > 0 ? tool.length : gridDiag;
  const [ax, ay, az] = axis;

  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  const step = Math.max(v.cs * 0.5, 1e-6);
  const n = Math.max(1, Math.ceil(len / step));
  let removed = 0;
  for (let s = 0; s <= n; s++) {
    const t = s / n;
    removed += stampVoxel(v, a[0] + dx * t, a[1] + dy * t, a[2] + dz * t, ax, ay, az, r, ballR, length);
  }
  return removed;
}

/**
 * Carve every feed segment into one voxel block, each with its own oriented
 * cutter. `resolveTool(seg)` returns the cutter geometry (per-tool when a table
 * was detected). Segments are in the part frame and tagged with a4/b4.
 */
export function carveVoxels(v, segments, resolveTool) {
  const axisCache = new Map();
  let removed = 0;
  for (const s of segments) {
    if (s.type === 'rapid') continue;
    const key = `${s.a4 || 0}/${s.b4 || 0}`;
    let axis = axisCache.get(key);
    if (!axis) { axis = toolAxisFor(s.a4 || 0, s.b4 || 0); axisCache.set(key, axis); }
    removed += carveVoxelMove(v, s.a, s.b, axis, resolveTool(s));
  }
  return { removedVolume: removed * v.cs * v.cs * v.cs };
}

// Face directions: [di,dj,dk, nx,ny,nz] — the neighbour to test and the normal.
const FACES = [
  [1, 0, 0, 1, 0, 0], [-1, 0, 0, -1, 0, 0],
  [0, 1, 0, 0, 1, 0], [0, -1, 0, 0, -1, 0],
  [0, 0, 1, 0, 0, 1], [0, 0, -1, 0, 0, -1],
];

/**
 * Extract the visible surface as a triangle mesh: every face of a solid voxel
 * that borders empty space (or the grid edge) becomes a quad (two triangles)
 * with an outward normal. Returns transferable typed arrays.
 */
export function voxelSurfaceMesh(v) {
  const { ox, oy, oz, cs, nx, ny, nz, solid } = v;
  const at = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz)
    ? 0 : solid[k * nx * ny + j * nx + i];

  const positions = [];
  const normals = [];
  const indices = [];
  let vert = 0;

  // Unit-quad corner offsets for each of the 6 face directions.
  const quad = (i, j, k, f) => {
    const x0 = ox + i * cs;
    const y0 = oy + j * cs;
    const z0 = oz + k * cs;
    const x1 = x0 + cs;
    const y1 = y0 + cs;
    const z1 = z0 + cs;
    const [, , , fnx, fny, fnz] = FACES[f];
    let corners;
    if (f === 0) corners = [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]; // +X
    else if (f === 1) corners = [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]; // -X
    else if (f === 2) corners = [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]; // +Y
    else if (f === 3) corners = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]; // -Y
    else if (f === 4) corners = [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]; // +Z
    else corners = [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]; // -Z
    for (const c of corners) { positions.push(c[0], c[1], c[2]); normals.push(fnx, fny, fnz); }
    indices.push(vert, vert + 1, vert + 2, vert, vert + 2, vert + 3);
    vert += 4;
  };

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!solid[k * nx * ny + j * nx + i]) continue;
        for (let f = 0; f < 6; f++) {
          const [di, dj, dk] = FACES[f];
          if (!at(i + di, j + dj, k + dk)) quad(i, j, k, f);
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    quads: vert / 4,
  };
}
