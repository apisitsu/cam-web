/**
 * Convert a dexel height field into a renderable triangle mesh.
 *
 * Vertices sit at cell centres on an nx×ny grid; each interior quad is split
 * into two triangles. Output is plain typed arrays (no three dependency) so it
 * builds in a worker and transfers zero-copy to the viewport, where it becomes
 * a THREE.BufferGeometry.
 */
/**
 * Convert the height field into a **closed solid** box: the carved top surface,
 * four side walls, and a flat bottom. This reads as a real billet instead of a
 * floating terrain sheet.
 *
 * The surface is built **stepped**, not smoothed, and that is the whole point.
 * The obvious construction — one vertex per cell at its centre, quads joining
 * neighbours — draws a wall between a full cell and a cut one as a single
 * *sloped* quad spanning the gap between their centres. Every vertical face a
 * cutter leaves then comes out leaning by one cell width, which is exactly the
 * "the removed material is not square to the tool" it was reported as. It is
 * not a carving error at all: the height field is right and the triangulation
 * was lying about it.
 *
 * So each cell contributes a flat quad over its **own footprint** at its own
 * height, and where two neighbours differ a vertical riser closes the step
 * between them. A wall is then genuinely vertical, and a floor genuinely flat,
 * to the resolution the grid actually holds — a staircase at cell size, which
 * is an honest picture of what a height field knows.
 *
 * Every quad carries its own four vertices (nothing is shared), so
 * `computeVertexNormals` gives flat facets rather than rounding the steps back
 * off. Winding is not made consistent — StockMesh uses DoubleSide.
 */
export function heightmapToSolidMesh(stock) {
  const { nx, ny, cellSize: cs, xMin, yMin, heights, base } = stock;
  const N = nx * ny;

  let minH = Infinity;
  for (let k = 0; k < N; k++) if (heights[k] < minH) minH = heights[k];
  const floor = Math.min(base ?? minH, minH) - 0.001;

  // Count the risers first so the buffers can be allocated exactly — this runs
  // per playback tick during cut-with-playback, so a growing array would be
  // re-allocating megabytes several times a second.
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

  let v = 0; // vertex count
  let p = 0; // position write cursor
  let t = 0; // index write cursor
  /** Push one planar quad as four fresh vertices and two triangles. */
  const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) => {
    positions[p] = ax; positions[p + 1] = ay; positions[p + 2] = az;
    positions[p + 3] = bx; positions[p + 4] = by; positions[p + 5] = bz;
    positions[p + 6] = cx; positions[p + 7] = cy; positions[p + 8] = cz;
    positions[p + 9] = dx; positions[p + 10] = dy; positions[p + 11] = dz;
    p += 12;
    indices[t] = v; indices[t + 1] = v + 1; indices[t + 2] = v + 2;
    indices[t + 3] = v; indices[t + 4] = v + 2; indices[t + 5] = v + 3;
    t += 6;
    v += 4;
  };

  const xAt = (i) => xMin + i * cs;
  const yAt = (j) => yMin + j * cs;

  for (let j = 0; j < ny; j++) {
    const y0 = yAt(j);
    const y1 = y0 + cs;
    for (let i = 0; i < nx; i++) {
      const g = j * nx + i;
      const h = heights[g];
      const x0 = xAt(i);
      const x1 = x0 + cs;
      // Flat top over this cell's own footprint — never sloped toward a neighbour.
      quad(x0, y0, h, x1, y0, h, x1, y1, h, x0, y1, h);

      // Vertical riser closing the step to the +X neighbour.
      if (i < nx - 1) {
        const h2 = heights[g + 1];
        if (h2 !== h) {
          const lo = Math.min(h, h2);
          const hi = Math.max(h, h2);
          quad(x1, y0, lo, x1, y1, lo, x1, y1, hi, x1, y0, hi);
        }
      }
      // ...and to the +Y neighbour.
      if (j < ny - 1) {
        const h2 = heights[g + nx];
        if (h2 !== h) {
          const lo = Math.min(h, h2);
          const hi = Math.max(h, h2);
          quad(x0, y1, lo, x1, y1, lo, x1, y1, hi, x0, y1, hi);
        }
      }
    }
  }

  // The four outside faces of the billet, one quad per boundary cell so each
  // drops from its own height straight to the floor.
  for (let i = 0; i < nx; i++) {
    const x0 = xAt(i);
    const x1 = x0 + cs;
    const hFront = heights[i];
    const yF = yAt(0);
    quad(x0, yF, floor, x1, yF, floor, x1, yF, hFront, x0, yF, hFront);
    const hBack = heights[(ny - 1) * nx + i];
    const yB = yAt(ny);
    quad(x0, yB, floor, x1, yB, floor, x1, yB, hBack, x0, yB, hBack);
  }
  for (let j = 0; j < ny; j++) {
    const y0 = yAt(j);
    const y1 = y0 + cs;
    const hLeft = heights[j * nx];
    const xL = xAt(0);
    quad(xL, y0, floor, xL, y1, floor, xL, y1, hLeft, xL, y0, hLeft);
    const hRight = heights[j * nx + nx - 1];
    const xR = xAt(nx);
    quad(xR, y0, floor, xR, y1, floor, xR, y1, hRight, xR, y0, hRight);
  }

  // Flat bottom across the whole footprint.
  const bx0 = xAt(0);
  const bx1 = xAt(nx);
  const by0 = yAt(0);
  const by1 = yAt(ny);
  quad(bx0, by0, floor, bx1, by0, floor, bx1, by1, floor, bx0, by1, floor);

  return {
    positions: positions.subarray(0, p),
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
