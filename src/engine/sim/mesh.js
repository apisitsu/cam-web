/**
 * Convert a dexel height field into a renderable triangle mesh.
 *
 * `heightmapToSolidMesh` is the one the app draws: a closed billet whose top
 * follows the cells' own footprints, so a wall stands square and a chamfer lies
 * flat. `heightmapToMesh` is the plain terrain sheet it grew out of — one vertex
 * per cell centre — kept for anything that just wants the surface.
 *
 * Output is plain typed arrays (no three dependency) so it builds in a worker
 * and transfers zero-copy to the viewport, where it becomes a
 * THREE.BufferGeometry.
 */
import { CUT, RAW } from './stockColors.js';

/**
 * How big a step between neighbouring cells still counts as one **continuous
 * surface**, measured in cell widths.
 *
 * The grid cannot tell a 45° chamfer from a staircase of the same average
 * slope — at cell resolution they are the same numbers — so this is the line
 * drawn between the two readings, and it is drawn where the *cutter* is:
 *
 * - a chamfer mill's 45° flank rises exactly **one** cell per cell, and a 60°
 *   one rises √3 ≈ 1.73. Both are surfaces, and both must draw as slopes.
 * - a wall left by an endmill's flank rises by the depth of cut — millimetres,
 *   which at the ½ mm grid this app simulates on is many cells. It is a step,
 *   and must stay square (see `meshSquare.test.js`, which is the reason this
 *   file stopped smoothing anything at all).
 *
 * Two cell widths sits between them with room either side: it takes in every
 * cone up to 60°, and a Z-level step (`ap` is a fraction of the tool diameter —
 * whole millimetres) is nowhere near it.
 */
export const SLOPE_CELLS = 2;

/**
 * Convert the height field into a **closed solid** box: the carved top surface,
 * four side walls, and a flat bottom. This reads as a real billet instead of a
 * floating terrain sheet.
 *
 * Where the field **steps**, the surface is built stepped, and that is the whole
 * point. The obvious construction — one vertex per cell at its centre, quads
 * joining neighbours — draws a wall between a full cell and a cut one as a
 * single *sloped* quad spanning the gap between their centres. Every vertical
 * face a cutter leaves then comes out leaning by one cell width, which is
 * exactly the "the removed material is not square to the tool" it was reported
 * as. It is not a carving error at all: the height field is right and the
 * triangulation was lying about it.
 *
 * Where the field **slopes**, though, stepping is the same lie the other way
 * round. A chamfer mill stamps a cone: the heights it leaves are a ramp, and
 * drawing every cell as a flat tread with a riser beside it turns a machined
 * 45° face into a staircase — which is what a chamfer looked like on screen.
 *
 * So the two cases are told apart, once, at each grid **node**: the up-to-four
 * cells meeting there either agree to within `SLOPE_CELLS` cell widths — one
 * surface, and the node takes their mean height, which every one of them then
 * shares — or they do not, and each cell keeps its own height there while a
 * riser closes the gap. The test is on the four cells together, not on a pair,
 * so both sides of an edge always reach the same verdict and the shell stays
 * watertight: a riser spans whatever its two cells left, and collapses to
 * nothing where they already meet.
 *
 * Averaging is exact on a plane, so a cone or a ramp comes back as the flat
 * face it actually is — not an approximation of one — while a floor stays flat
 * and a wall stays vertical to the resolution the grid holds.
 *
 * Every quad carries its own four vertices (nothing is shared), so
 * `computeVertexNormals` gives flat facets rather than rounding the steps back
 * off. That is still right: a chamfer's cells are coplanar, so its facets *are*
 * one face. Winding is not made consistent — StockMesh uses DoubleSide.
 *
 * @param {object} stock
 * @param {{slopeLimit?:number, merge?:boolean}} [opts]
 *   `slopeLimit` in mm overrides the `SLOPE_CELLS × cellSize` default — the
 *   callers that know the cutter can say. `merge:false` draws every cell as its
 *   own quad: the run-merging below leaves T-junctions where a long flat run
 *   meets a row that is subdivided differently, which is invisible on screen
 *   (the two are exactly coplanar) but makes the mesh un-checkable for holes and
 *   would matter to anything that wants edge-matched geometry out of it.
 */
export function heightmapToSolidMesh(stock, opts = {}) {
  const { nx, ny, cellSize: cs, xMin, yMin, heights, base, top } = stock;
  const N = nx * ny;
  const slopeLimit = opts.slopeLimit > 0 ? opts.slopeLimit : SLOPE_CELLS * cs;
  const merge = opts.merge !== false;

  let minH = Infinity;
  for (let k = 0; k < N; k++) if (heights[k] < minH) minH = heights[k];
  const floor = Math.min(base ?? minH, minH) - 0.001;

  // Node heights: one per grid corner, (nx+1)×(ny+1). `nodeH` is the shared
  // height where the cells around a node agree closely enough to be one
  // surface; `nodeOn` says whether they did. A node that is off is a real
  // discontinuity, and the cells there fall back to their own heights.
  const nw = nx + 1;
  const nodeH = new Float32Array(nw * (ny + 1));
  const nodeOn = new Uint8Array(nw * (ny + 1));
  // The gather is unrolled and the row offsets hoisted: this is (nx+1)×(ny+1)
  // iterations on every mesh build, and a mesh is built per playback tick.
  for (let j = 0; j <= ny; j++) {
    const below = j > 0 ? (j - 1) * nx : -1;   // row of cells under this node line
    const above = j < ny ? j * nx : -1;        // ...and over it
    const nodeRow = j * nw;
    for (let i = 0; i <= nx; i++) {
      const left = i > 0 ? i - 1 : -1;
      const right = i < nx ? i : -1;
      let lo = Infinity;
      let hi = -Infinity;
      let sum = 0;
      let n = 0;
      if (below >= 0) {
        if (left >= 0) {
          const h = heights[below + left];
          sum += h; n++; if (h < lo) lo = h; if (h > hi) hi = h;
        }
        if (right >= 0) {
          const h = heights[below + right];
          sum += h; n++; if (h < lo) lo = h; if (h > hi) hi = h;
        }
      }
      if (above >= 0) {
        if (left >= 0) {
          const h = heights[above + left];
          sum += h; n++; if (h < lo) lo = h; if (h > hi) hi = h;
        }
        if (right >= 0) {
          const h = heights[above + right];
          sum += h; n++; if (h < lo) lo = h; if (h > hi) hi = h;
        }
      }
      if (n > 0 && hi - lo <= slopeLimit) {
        nodeH[nodeRow + i] = sum / n;
        nodeOn[nodeRow + i] = 1;
      }
    }
  }

  /** Height cell (ci,cj) carries at node (ni,nj) — the shared one, or its own. */
  const cornerAt = (ci, cj, ni, nj) => (
    nodeOn[nj * nw + ni] ? nodeH[nj * nw + ni] : heights[cj * nx + ci]
  );

  // Count the risers first so the buffers can be sized once — this runs per
  // playback tick during cut-with-playback, so a growing array would be
  // re-allocating megabytes several times a second. Cells that differ but end
  // up sharing both nodes need no riser after all, so this is an upper bound
  // and the buffers are returned as subarrays of what was actually written.
  let risers = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const g = j * nx + i;
      if (i < nx - 1 && heights[g] !== heights[g + 1]) risers++;
      if (j < ny - 1 && heights[g] !== heights[g + nx]) risers++;
    }
  }
  // tops + risers + the four border walls (one quad per boundary cell) + floor
  const quads = N + risers + 2 * nx + 2 * ny + 1;
  const positions = new Float32Array(quads * 4 * 3);
  const indices = new Uint32Array(quads * 2 * 3);
  // Cut faces are told from raw stock by colour — every quad here is one or the
  // other, and each carries four fresh vertices, so the boundary is crisp.
  const colors = new Float32Array(quads * 4 * 3);

  let v = 0; // vertex count
  let p = 0; // position write cursor
  let t = 0; // index write cursor
  let cw = 0; // colour write cursor
  let col = RAW;
  /** Push one planar quad as four fresh vertices and two triangles. */
  const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) => {
    positions[p] = ax; positions[p + 1] = ay; positions[p + 2] = az;
    positions[p + 3] = bx; positions[p + 4] = by; positions[p + 5] = bz;
    positions[p + 6] = cx; positions[p + 7] = cy; positions[p + 8] = cz;
    positions[p + 9] = dx; positions[p + 10] = dy; positions[p + 11] = dz;
    p += 12;
    for (let n = 0; n < 4; n++) {
      colors[cw] = col[0]; colors[cw + 1] = col[1]; colors[cw + 2] = col[2];
      cw += 3;
    }
    indices[t] = v; indices[t + 1] = v + 1; indices[t + 2] = v + 2;
    indices[t + 3] = v; indices[t + 4] = v + 2; indices[t + 5] = v + 3;
    t += 6;
    v += 4;
  };

  /**
   * A riser: the face closing the step between two cells along their shared
   * edge, from the heights one left (`a`→`b`) to the heights the other left
   * (`d`→`c`). Where one end is a node the two already share, the face is a
   * **triangle** and is emitted as one.
   *
   * That is not cosmetic. A zero-area quad would leave its diagonal matched by
   * one real triangle and one degenerate one, so no mesh containing them could
   * be checked for holes. Emitting the triangle keeps every edge shared by
   * exactly two faces, which is what makes "the shell is sealed" a testable
   * statement — see `meshSlope.test.js`.
   */
  const riser = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) => {
    const ad = az === dz && ax === dx && ay === dy;
    const bc = bz === cz && bx === cx && by === cy;
    if (ad && bc) return;  // the two cells meet along the whole edge
    if (!ad && !bc) {
      quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
      return;
    }
    positions[p] = ax; positions[p + 1] = ay; positions[p + 2] = az;
    positions[p + 3] = bx; positions[p + 4] = by; positions[p + 5] = bz;
    // The collapsed end contributes nothing; the far corner is the third point.
    if (ad) { positions[p + 6] = cx; positions[p + 7] = cy; positions[p + 8] = cz; } else {
      positions[p + 6] = dx; positions[p + 7] = dy; positions[p + 8] = dz;
    }
    p += 9;
    for (let n = 0; n < 3; n++) {
      colors[cw] = col[0]; colors[cw + 1] = col[1]; colors[cw + 2] = col[2];
      cw += 3;
    }
    indices[t] = v; indices[t + 1] = v + 1; indices[t + 2] = v + 2;
    t += 3;
    v += 3;
  };

  // ---- Where the walls really are ---------------------------------------
  //
  // A node sits on a lattice corner, and a wall almost never does. The height
  // field knows which CELL a bore's rim falls in and nothing finer, so a riser
  // drawn on the cell boundary makes every circle a staircase one cell deep —
  // whatever its diameter, which is why a Ø80 bore looked as rough as a Ø10 one.
  //
  // `stock.edge` carries the signed horizontal distance from each cell's centre
  // to the nearest cut boundary (see `dexel.js`). Where the four cells around a
  // node straddle it, the node is slid along the field's gradient onto the zero
  // crossing — the surface-nets move. Tops and risers are both built from these
  // nodes, so both follow, and two cells sharing a node still share a position:
  // no gaps.
  //
  // Only where there is a real crossing, and never further than half a cell —
  // a node that overshoots its own cell turns the quad inside out.
  const nodeDX = new Float32Array(nw * (ny + 1));
  const nodeDY = new Float32Array(nw * (ny + 1));
  const edge = stock.edge;
  if (edge) {
    const KNOWN = 1e8; // anything larger is `EDGE_FAR`: no cut came near
    for (let j = 1; j < ny; j++) {
      const below = (j - 1) * nx;
      const above = j * nx;
      const nodeRow = j * nw;
      for (let i = 1; i < nx; i++) {
        const bl = edge[below + i - 1];
        const br = edge[below + i];
        const al = edge[above + i - 1];
        const ar = edge[above + i];
        if (bl > KNOWN || br > KNOWN || al > KNOWN || ar > KNOWN) continue;
        const lo = Math.min(bl, br, al, ar);
        const hi = Math.max(bl, br, al, ar);
        if (lo >= 0 || hi <= 0) continue;   // no boundary passes this node
        // Value and gradient of the field at the node, from its four samples.
        const f = (bl + br + al + ar) * 0.25;
        const gx = ((br + ar) - (bl + al)) * 0.5;
        const gy = ((al + ar) - (bl + br)) * 0.5;
        const g2 = gx * gx + gy * gy;
        if (g2 < 1e-12) continue;
        // Step to the zero of the linear approximation. `gx`,`gy` are per cell,
        // so the step comes out in cells and is scaled back to mm.
        const s = (-f * cs) / g2;
        const half = cs * 0.5;
        let dx = s * gx;
        let dy = s * gy;
        if (dx > half) dx = half; else if (dx < -half) dx = -half;
        if (dy > half) dy = half; else if (dy < -half) dy = -half;
        nodeDX[nodeRow + i] = dx;
        nodeDY[nodeRow + i] = dy;
      }
    }
  }

  const xAt = (i) => xMin + i * cs;
  const yAt = (j) => yMin + j * cs;
  /** Node position, slid onto the wall where one passes through it. */
  const nX = (i, j) => xMin + i * cs + nodeDX[j * nw + i];
  const nY = (i, j) => yMin + j * cs + nodeDY[j * nw + i];

  // ---- Tops -------------------------------------------------------------
  //
  // **Flat cells are merged along the row.** A billet is mostly untouched top
  // and flat floor, and drawing each of those cells as its own quad makes the
  // mesh scale with the grid rather than with the part: it is what stopped the
  // grid from being fine enough to draw a Ø2 centre drill as a circle instead
  // of a dodecagon. A run of cells at one height, none of whose corners tilt, is
  // one rectangle however many cells long — and where the surface does anything
  // at all (a slope, a wall, the rim of a bore) the run ends and every cell is
  // drawn in full. Detail is spent where there is detail.
  //
  // Node lookups are written out rather than routed through `cornerAt`: this is
  // the innermost loop of a mesh rebuilt on every playback tick, and each cell
  // wants four of them.
  for (let j = 0; j < ny; j++) {
    const y0 = yAt(j);
    // eslint-disable-next-line no-unused-vars
    const y1 = y0 + cs;
    const row = j * nx;
    const nRow0 = j * nw;        // node row along y0
    const nRow1 = nRow0 + nw;    // ...and along y1
    let i = 0;
    while (i < nx) {
      const g = row + i;
      const h = heights[g];
      const k00 = nRow0 + i;
      const k10 = k00 + 1;
      const k01 = nRow1 + i;
      const k11 = k01 + 1;
      // The cell's top over its **own footprint**, at the four heights its
      // corners carry: all four are `h` in the middle of a floor, and they tilt
      // into the neighbours only where the field is one continuous surface.
      const h00 = nodeOn[k00] ? nodeH[k00] : h;
      const h10 = nodeOn[k10] ? nodeH[k10] : h;
      const h11 = nodeOn[k11] ? nodeH[k11] : h;
      const h01 = nodeOn[k01] ? nodeH[k01] : h;
      // Lowered below the blank's top means the tool has been through it.
      col = h < top - 1e-6 ? CUT : RAW;

      const flat = merge && h00 === h && h10 === h && h11 === h && h01 === h;
      if (!flat) {
        // The cell's own footprint, on the nodes as they actually sit — which
        // is on the wall wherever one runs through this cell.
        quad(
          nX(i, j), nY(i, j), h00,
          nX(i + 1, j), nY(i + 1, j), h10,
          nX(i + 1, j + 1), nY(i + 1, j + 1), h11,
          nX(i, j + 1), nY(i, j + 1), h01,
        );
        i += 1;
        continue;
      }
      // How far the flat run reaches: same height, and still flat there.
      let end = i + 1;
      while (end < nx && heights[row + end] === h) {
        const a = nRow0 + end;
        const b = nRow1 + end;
        // Only the far corners need testing — the near pair is the previous
        // cell's far pair, already known flat.
        if ((nodeOn[a + 1] && nodeH[a + 1] !== h) || (nodeOn[b + 1] && nodeH[b + 1] !== h)) break;
        end += 1;
      }
      // A merged run is flat by construction, but its two END nodes can still
      // be on a wall — the run stops exactly where the height changes. Reading
      // them through `nX`/`nY` is what lets a floor reach the true rim of the
      // bore it ends at instead of stopping on the lattice.
      quad(
        nX(i, j), nY(i, j), h,
        nX(end, j), nY(end, j), h,
        nX(end, j + 1), nY(end, j + 1), h,
        nX(i, j + 1), nY(i, j + 1), h,
      );
      i = end;
    }
  }

  // ---- Risers -----------------------------------------------------------
  //
  // Per cell, and unmerged: a riser only exists where two cells left different
  // heights, which is the boundary of a feature and never the flat field around
  // it. Kept in its own pass so the merging above stays a statement about tops.
  for (let j = 0; j < ny; j++) {
    const y0 = yAt(j);
    // eslint-disable-next-line no-unused-vars
    const y1 = y0 + cs;
    const row = j * nx;
    const nRow0 = j * nw;
    const nRow1 = nRow0 + nw;
    for (let i = 0; i < nx; i++) {
      const g = row + i;
      const h = heights[g];
      const rightStep = i < nx - 1 && heights[g + 1] !== h;
      const upStep = j < ny - 1 && heights[g + nx] !== h;
      if (!rightStep && !upStep) continue;
      const k00 = nRow0 + i;
      const k10 = k00 + 1;
      const k01 = nRow1 + i;
      const k11 = k01 + 1;
      const h10 = nodeOn[k10] ? nodeH[k10] : h;
      const h11 = nodeOn[k11] ? nodeH[k11] : h;
      const h01 = nodeOn[k01] ? nodeH[k01] : h;
      // The shared-edge nodes, where they actually sit. The riser is the wall
      // itself, so this is the one place the move matters most: put it on the
      // lattice and every bore is a staircase.
      const ex10 = nX(i + 1, j);
      const ey10 = nY(i + 1, j);
      const ex11 = nX(i + 1, j + 1);
      const ey11 = nY(i + 1, j + 1);
      const ex01 = nX(i, j + 1);
      const ey01 = nY(i, j + 1);
      // A step exists only where something was removed: a cut wall.
      col = CUT;
      // Closing the step to the +X neighbour — from the heights this cell left
      // on the shared edge to the ones that cell left. Both nodes shared means
      // the two already meet along the whole edge and there is nothing to
      // close, which is the ordinary case on a slope.
      if (rightStep && !(nodeOn[k10] && nodeOn[k11])) {
        const hR = heights[g + 1];
        riser(ex10, ey10, h10, ex11, ey11, h11,
          ex11, ey11, nodeOn[k11] ? nodeH[k11] : hR,
          ex10, ey10, nodeOn[k10] ? nodeH[k10] : hR);
      }
      // ...and to the +Y neighbour.
      if (upStep && !(nodeOn[k01] && nodeOn[k11])) {
        const hU = heights[g + nx];
        riser(ex01, ey01, h01, ex11, ey11, h11,
          ex11, ey11, nodeOn[k11] ? nodeH[k11] : hU,
          ex01, ey01, nodeOn[k01] ? nodeH[k01] : hU);
      }
    }
  }

  // The four outside faces of the billet and its floor: the blank's own
  // surfaces, as sawn. A cut that breaks out through a side shortens the face
  // rather than machining it, so raw is the honest colour for all of them.
  col = RAW;
  // The four outside faces of the billet, one quad per boundary cell so each
  // drops from its own height straight to the floor.
  // Their top edges take the same corner heights as the cell they cap, so a cut
  // that slopes into the blank's edge stays sealed to it.
  for (let i = 0; i < nx; i++) {
    const x0 = xAt(i);
    const x1 = x0 + cs;
    const yF = yAt(0);
    quad(x0, yF, floor, x1, yF, floor,
      x1, yF, cornerAt(i, 0, i + 1, 0), x0, yF, cornerAt(i, 0, i, 0));
    const yB = yAt(ny);
    quad(x0, yB, floor, x1, yB, floor,
      x1, yB, cornerAt(i, ny - 1, i + 1, ny), x0, yB, cornerAt(i, ny - 1, i, ny));
  }
  for (let j = 0; j < ny; j++) {
    const y0 = yAt(j);
    const y1 = y0 + cs;
    const xL = xAt(0);
    quad(xL, y0, floor, xL, y1, floor,
      xL, y1, cornerAt(0, j, 0, j + 1), xL, y0, cornerAt(0, j, 0, j));
    const xR = xAt(nx);
    quad(xR, y0, floor, xR, y1, floor,
      xR, y1, cornerAt(nx - 1, j, nx, j + 1), xR, y0, cornerAt(nx - 1, j, nx, j));
  }

  // Flat bottom across the whole footprint.
  const bx0 = xAt(0);
  const bx1 = xAt(nx);
  const by0 = yAt(0);
  const by1 = yAt(ny);
  quad(bx0, by0, floor, bx1, by0, floor, bx1, by1, floor, bx0, by1, floor);

  return {
    positions: positions.subarray(0, p),
    colors: colors.subarray(0, cw),
    indices: indices.subarray(0, t),
    nx,
    ny,
  };
}

export function heightmapToMesh(stock) {
  const { nx, ny, cellSize, xMin, yMin, heights } = stock;
  const positions = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = (j * nx + i) * 3;
      positions[v] = xMin + (i + 0.5) * cellSize;
      positions[v + 1] = yMin + (j + 0.5) * cellSize;
      positions[v + 2] = heights[j * nx + i];
    }
  }

  const quads = (nx - 1) * (ny - 1);
  const indices = new Uint32Array(quads * 6);
  let t = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices[t++] = a; indices[t++] = c; indices[t++] = b;
      indices[t++] = b; indices[t++] = c; indices[t++] = d;
    }
  }
  return { positions, indices, nx, ny };
}
