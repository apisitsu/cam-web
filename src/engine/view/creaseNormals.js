/**
 * Vertex normals for a triangle soup that are smooth across a curved surface and
 * sharp at a real edge.
 *
 * One normal per facet draws a bore of a hundred facets as a hundred flat strips:
 * honest, but it reads as a stepped wall rather than a round one. Averaging every
 * normal at a corner goes the other way and rounds a block's edges into mush. The
 * middle is a crease angle: at each corner, a facet takes the average of only
 * those facets meeting there that turn less than `crease` from it. A cylinder's
 * facets (a few degrees apart) blend; a block's faces (90°) do not.
 *
 * 30° is the same line `detectSharpEdges` draws between a designed edge and
 * faceting, so what shades as an edge is what can be picked as one.
 *
 * Pure: plain arrays, nothing changes position or order — the triangle a raycast
 * reports is still the soup's own.
 *
 * @param {{positions:Float32Array, triangleCount:number}} soup
 * @param {number} [crease] degrees
 * @returns {Float32Array} one normal per corner, nine floats per triangle
 */
export function creaseNormals(soup, crease = 30) {
  const p = soup.positions;
  const n = soup.triangleCount;
  const cos = Math.cos((crease * Math.PI) / 180);
  // Each facet's normal, scaled by its area so a sliver counts for what it covers.
  const face = new Float64Array(n * 3);
  const unit = new Float64Array(n * 3);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ux = p[o + 3] - p[o]; const uy = p[o + 4] - p[o + 1]; const uz = p[o + 5] - p[o + 2];
    const vx = p[o + 6] - p[o]; const vy = p[o + 7] - p[o + 1]; const vz = p[o + 8] - p[o + 2];
    const x = uy * vz - uz * vy;
    const y = uz * vx - ux * vz;
    const z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z);
    face[t * 3] = x / 2; face[t * 3 + 1] = y / 2; face[t * 3 + 2] = z / 2;
    if (l > 0) { unit[t * 3] = x / l; unit[t * 3 + 1] = y / l; unit[t * 3 + 2] = z / l; }
  }
  // Facets by corner position.
  const at = new Map();
  for (let c = 0; c < n * 3; c++) {
    const k = `${p[c * 3]},${p[c * 3 + 1]},${p[c * 3 + 2]}`;
    let list = at.get(k);
    if (!list) { list = []; at.set(k, list); }
    list.push(c);
  }
  const out = new Float32Array(n * 9);
  for (const corners of at.values()) {
    for (const c of corners) {
      const t = (c / 3) | 0;
      let x = 0; let y = 0; let z = 0;
      for (const d of corners) {
        const s = (d / 3) | 0;
        const dot = unit[t * 3] * unit[s * 3] + unit[t * 3 + 1] * unit[s * 3 + 1] + unit[t * 3 + 2] * unit[s * 3 + 2];
        if (s !== t && dot < cos) continue;
        x += face[s * 3]; y += face[s * 3 + 1]; z += face[s * 3 + 2];
      }
      const l = Math.hypot(x, y, z) || 1;
      out[c * 3] = x / l; out[c * 3 + 1] = y / l; out[c * 3 + 2] = z / l;
    }
  }
  return out;
}
