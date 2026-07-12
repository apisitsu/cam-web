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
 * floating terrain sheet. Vertices: top grid (nx·ny) + a mirrored bottom grid at
 * the floor plane. Winding is not made consistent — StockMesh uses DoubleSide.
 */
export function heightmapToSolidMesh(stock) {
  const { nx, ny, cellSize, xMin, yMin, heights, base } = stock;
  const N = nx * ny;

  let minH = Infinity;
  for (let k = 0; k < N; k++) if (heights[k] < minH) minH = heights[k];
  const floor = Math.min(base ?? minH, minH) - 0.001;

  const positions = new Float32Array(N * 2 * 3);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const g = j * nx + i;
      const x = xMin + (i + 0.5) * cellSize;
      const y = yMin + (j + 0.5) * cellSize;
      const t = g * 3;
      positions[t] = x; positions[t + 1] = y; positions[t + 2] = heights[g];
      const b = (N + g) * 3;
      positions[b] = x; positions[b + 1] = y; positions[b + 2] = floor;
    }
  }

  const topTris = (nx - 1) * (ny - 1) * 2;
  const wallTris = (2 * (nx - 1) + 2 * (ny - 1)) * 2;
  const bottomTris = 2;
  const indices = new Uint32Array((topTris + wallTris + bottomTris) * 3);
  let p = 0;
  const tri = (a, b, c) => { indices[p++] = a; indices[p++] = b; indices[p++] = c; };
  // Wall quad between adjacent top grid verts g1,g2 and their floor mirrors.
  const wall = (g1, g2) => { tri(g1, N + g1, g2); tri(g2, N + g1, N + g2); };

  // Top surface.
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      tri(a, c, b); tri(b, c, d);
    }
  }
  // Side walls along the four grid borders.
  for (let i = 0; i < nx - 1; i++) wall(i, i + 1); // front (j=0)
  for (let i = 0; i < nx - 1; i++) wall((ny - 1) * nx + i, (ny - 1) * nx + i + 1); // back
  for (let j = 0; j < ny - 1; j++) wall(j * nx, (j + 1) * nx); // left (i=0)
  for (let j = 0; j < ny - 1; j++) wall(j * nx + nx - 1, (j + 1) * nx + nx - 1); // right
  // Bottom (two triangles across the four floor corners).
  const c00 = N, c10 = N + nx - 1, c01 = N + (ny - 1) * nx, c11 = N + (ny - 1) * nx + nx - 1;
  tri(c00, c10, c11); tri(c00, c11, c01);

  return { positions, indices, nx, ny };
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
