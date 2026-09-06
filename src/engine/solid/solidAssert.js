/**
 * Checks a generated solid has to pass, shared by the tests that generate one.
 *
 * `volume` and `isClosed` had been copied into three test files by the time
 * there were three ways to make a solid (extrude, revolve, mesh boolean) and a
 * fourth on the way in the feature tree. They are the two assertions that matter
 * for *any* of them, so they live once.
 *
 * This is test support, not engine code — nothing in the app imports it — but it
 * sits beside the module it checks so it moves when that does.
 */

/**
 * Signed volume by the divergence theorem — the single number that checks the
 * two things that can go wrong with a generated solid at once.
 *
 * It is only meaningful for a **closed** surface, and it comes out **positive**
 * only when every triangle faces outward. A gap or an inside-out face shows up
 * here, which is why it is worth asserting an exact figure rather than eyeballing
 * a render.
 */
export function volume({ positions, triangleCount }) {
  let v = 0;
  for (let t = 0; t < triangleCount; t++) {
    const o = t * 9;
    const ax = positions[o]; const ay = positions[o + 1]; const az = positions[o + 2];
    const bx = positions[o + 3]; const by = positions[o + 4]; const bz = positions[o + 5];
    const cx = positions[o + 6]; const cy = positions[o + 7]; const cz = positions[o + 8];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

/**
 * Whether every edge is shared by exactly two triangles — a watertight surface.
 *
 * Keyed on rounded coordinates so the two copies of a shared vertex match, and
 * `-0` is normalised to `0`: a seam landing on an axis otherwise reads as two
 * separate vertices and the surface looks torn where it is not.
 */
export function isClosed({ positions, triangleCount }) {
  const q = (v) => {
    const r = Math.round(v * 1e5) / 1e5;
    return (r === 0 ? 0 : r).toFixed(5);
  };
  const key = (o) => `${q(positions[o])},${q(positions[o + 1])},${q(positions[o + 2])}`;
  const edges = new Map();
  for (let t = 0; t < triangleCount; t++) {
    const o = t * 9;
    const k = [key(o), key(o + 3), key(o + 6)];
    for (let i = 0; i < 3; i++) {
      const a = k[i];
      const b = k[(i + 1) % 3];
      if (a === b) continue; // a degenerate sliver contributes no edge
      const id = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(id, (edges.get(id) || 0) + 1);
    }
  }
  return [...edges.values()].every((n) => n === 2);
}

/** Axis-aligned bounds of a soup, as `{ min, max }`. */
export function bounds({ positions }) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (positions[i + a] < min[a]) min[a] = positions[i + a];
      if (positions[i + a] > max[a]) max[a] = positions[i + a];
    }
  }
  return { min, max };
}
