/**
 * Mesh fixtures — small watertight solids built in code, for testing the CAM
 * engine without shipping binary STL files into the repo.
 *
 * Every builder returns a triangle **soup** in the same shape `parseSTL` yields,
 * so fixtures and real files flow through the identical code path.
 */

/** Assemble a soup from an array of [v0, v1, v2] triangles. */
function soup(tris) {
  const positions = new Float32Array(tris.length * 9);
  let o = 0;
  for (const t of tris) for (const v of t) for (const c of v) positions[o++] = c;
  return { positions, normals: new Float32Array(tris.length * 3), triangleCount: tris.length };
}

/** Axis-aligned box centred on the origin, wound outward. */
export function box(sx = 10, sy = 10, sz = 10) {
  const [x, y, z] = [sx / 2, sy / 2, sz / 2];
  const c = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ];
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  const tris = [];
  for (const [a, b, d, e] of quads) {
    tris.push([c[a], c[b], c[d]], [c[a], c[d], c[e]]);
  }
  return soup(tris);
}

/**
 * A prism swept along +Z from z=0, whose cross-section is given by `radii` —
 * one radius per angular step, evenly spaced.
 *
 * With every radius equal this is a tessellated cylinder; `segments: 6` makes a
 * hex bar; pushing one radius in cuts a flat. That single knob is what lets the
 * symmetry tests compare a round part against a nearly-round one built the same
 * way.
 */
export function prism(radii, height = 20) {
  const n = radii.length;
  const ring = (z) => radii.map((r, i) => {
    const a = (i / n) * 2 * Math.PI;
    return [r * Math.cos(a), r * Math.sin(a), z];
  });
  const lo = ring(0), hi = ring(height);
  const tris = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push([lo[i], lo[j], hi[j]], [lo[i], hi[j], hi[i]]);   // wall
    tris.push([[0, 0, 0], lo[j], lo[i]]);                       // bottom cap
    tris.push([[0, 0, height], hi[i], hi[j]]);                  // top cap
  }
  return soup(tris);
}

/** A tessellated cylinder along +Z — the canonical "this is a lathe part". */
export function cylinder(radius = 10, height = 20, segments = 32) {
  return prism(new Array(segments).fill(radius), height);
}

/**
 * A stepped shaft: two concentric diameters end to end. Still a pure solid of
 * revolution, but with a real turned profile rather than one constant radius.
 */
export function steppedShaft(r1 = 10, h1 = 15, r2 = 6, h2 = 10, segments = 32) {
  const a = prism(new Array(segments).fill(r1), h1);
  const b = cylinder(r2, h2, segments);
  // Shift the second stage up to sit on top of the first.
  const shifted = new Float32Array(b.positions);
  for (let i = 2; i < shifted.length; i += 3) shifted[i] += h1;
  const positions = new Float32Array(a.positions.length + shifted.length);
  positions.set(a.positions);
  positions.set(shifted, a.positions.length);
  return {
    positions,
    normals: new Float32Array((a.triangleCount + b.triangleCount) * 3),
    triangleCount: a.triangleCount + b.triangleCount,
  };
}

/** A cylinder with one flat milled along its length — no longer a revolve. */
export function shaftWithFlat(radius = 10, height = 20, segments = 32, depth = 2) {
  const radii = new Array(segments).fill(radius);
  // Flatten the arc spanned by a chord cut `depth` deep.
  const halfAngle = Math.acos((radius - depth) / radius);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * 2 * Math.PI;
    const d = Math.atan2(Math.sin(a), Math.cos(a)); // wrap to [-pi, pi]
    if (Math.abs(d) < halfAngle) radii[i] = (radius - depth) / Math.cos(d);
  }
  return prism(radii, height);
}

/** A hex bar — six facets, which the roundness rule must reject as a polygon. */
export function hexBar(acrossCorners = 20, height = 20) {
  return prism(new Array(6).fill(acrossCorners / 2), height);
}

/**
 * Revolve a closed outline in the (z, r) half-plane about the Z axis.
 *
 * This is the fixture builder the turning tests actually want, because it is
 * the inverse of what `turningProfile` does: give it a profile, get a solid,
 * and the extracted profile must come back. Bores, grooves, tapers and steps
 * are all just different outlines — no separate builder each.
 *
 * `outline` is a closed polygon of `{z, r}` with r >= 0, wound so that material
 * is on the inside. Points at r = 0 sit on the axis and produce the degenerate
 * triangles that close the ends, which is correct: the axis is a single point
 * on every ring.
 */
export function revolveOutline(outline, segments = 48) {
  const n = outline.length;
  const at = (i, j) => {
    const a = (j / segments) * 2 * Math.PI;
    const { z, r } = outline[i % n];
    return [r * Math.cos(a), r * Math.sin(a), z];
  };
  const tris = [];
  for (let i = 0; i < n; i++) {
    const r0 = outline[i % n].r, r1 = outline[(i + 1) % n].r;
    for (let j = 0; j < segments; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      // A band with one edge on the axis is a fan of single triangles, not
      // quads. Emitting both halves there would give one collapsed triangle per
      // segment, and a collapsed triangle's edges are shared three ways — which
      // is exactly what `shellReport` calls non-manifold.
      // Corners are ordered so the outward normal points away from the axis for
      // an outline wound with material on its inside — a negative volume here
      // would make every fixture read as an inside-out STL.
      if (r0 <= 0 && r1 <= 0) continue;      // both on the axis: nothing there
      if (r0 <= 0) tris.push([a, c, b]);     // fan from the axis point
      else if (r1 <= 0) tris.push([a, d, b]);
      else tris.push([a, c, b], [a, d, c]);
    }
  }
  return soup(tris);
}

/** A bored tube: outer wall, bore, and two annular end faces. */
export function tube(rOuter = 20, rInner = 10, length = 30, segments = 64) {
  return revolveOutline([
    { z: 0, r: rInner }, { z: 0, r: rOuter },
    { z: length, r: rOuter }, { z: length, r: rInner },
  ], segments);
}

/**
 * A shaft with a square groove turned into it — the canonical undercut, and the
 * case a plain profiling pass must be stopped from attempting.
 */
export function groovedShaft({
  radius = 15, length = 60, grooveZ = 30, grooveWidth = 4, grooveDepth = 3, segments = 64,
} = {}) {
  const g0 = grooveZ - grooveWidth / 2, g1 = grooveZ + grooveWidth / 2;
  return revolveOutline([
    { z: 0, r: 0 }, { z: 0, r: radius },
    { z: g0, r: radius },
    { z: g0, r: radius - grooveDepth },
    { z: g1, r: radius - grooveDepth },
    { z: g1, r: radius },
    { z: length, r: radius },
    { z: length, r: 0 },
  ], segments);
}

/** A two-diameter shaft built as one fused revolve, not two stacked shells. */
export function turnedShaft({
  r1 = 15, z1 = 25, r2 = 8, z2 = 45, segments = 64,
} = {}) {
  return revolveOutline([
    { z: 0, r: 0 }, { z: 0, r: r1 },
    { z: z1, r: r1 },
    { z: z1, r: r2 },
    { z: z2, r: r2 },
    { z: z2, r: 0 },
  ], segments);
}
