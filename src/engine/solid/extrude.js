/**
 * Turn sketch regions into a solid — the step that makes a 2D sketcher a 3D one.
 *
 * The output is a **triangle soup** in exactly the shape `mesh/import.js`
 * produces: `{ positions: Float32Array, triangleCount, format }`, nine floats
 * per triangle. That is deliberate and it is the whole reason this is cheap:
 * `camPlanStore.loadPart` converts an imported file to a soup and *everything*
 * after that — measure, features, slice, plan, simulate, post — works on the
 * soup and never asks where it came from. A solid built here therefore enters
 * the CAM pipeline through the same door an STL does, with no change to any of
 * it.
 *
 * Winding is outward-facing throughout, because `analyzeMesh` checks it and an
 * inside-out part is the failure it exists to warn about.
 *
 * Pure: plain arrays, no three.js, no DOM.
 */
import { triangulate } from './triangulate.js';
import { planeBasis } from '../sketch/plane.js';

/** Two points close enough to be the same vertex. */
const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9
  && Math.abs(a[1] - b[1]) < 1e-9
  && Math.abs(a[2] - b[2]) < 1e-9;

/** Accumulates triangles and hands back the soup shape the CAM engine reads. */
function soupBuilder() {
  const xs = [];
  return {
    /**
     * One triangle from three [x,y,z] points, in the order given.
     *
     * A triangle with two corners in the same place is **dropped**. A revolve
     * makes them wherever the profile touches the axis: the quad round a
     * cone tip has one edge of zero length, so half of it collapses. Keeping
     * those would leave a surface that is no longer edge-manifold and a set of
     * faces with no definable normal — and `analyzeMesh` reads normals.
     */
    tri(a, b, c) {
      if (same(a, b) || same(b, c) || same(a, c)) return;
      xs.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    },
    /** A quad as two triangles, corners in order round the face. */
    quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); },
    build(format) {
      return {
        positions: Float32Array.from(xs),
        triangleCount: xs.length / 9,
        format,
      };
    },
  };
}

/**
 * Place a sketch-plane point at height `h` along the plane normal, in world
 * coordinates. This is the only place the plane enters: the profile maths is all
 * done in flat sketch coordinates and lifted at the last moment.
 */
function placer(plane) {
  const { origin, u, v, n } = planeBasis(plane);
  return (x, y, h) => [
    origin[0] + u[0] * x + v[0] * y + n[0] * h,
    origin[1] + u[1] * x + v[1] * y + n[1] * h,
    origin[2] + u[2] * x + v[2] * y + n[2] * h,
  ];
}

/** Loop-to-loop side walls between heights `z0` and `z1`. */
function walls(loop, at, z0, z1, out) {
  const n = loop.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [x0, y0] = [loop[i * 2], loop[i * 2 + 1]];
    const [x1, y1] = [loop[j * 2], loop[j * 2 + 1]];
    // For a counter-clockwise loop the outward normal is (dy, -dx), which this
    // corner order produces; a hole is clockwise, so the same order faces into
    // the hole — outward from the material either way. That is exactly why the
    // outer-CCW / hole-CW convention is worth enforcing upstream.
    out.quad(at(x0, y0, z0), at(x1, y1, z0), at(x1, y1, z1), at(x0, y0, z1));
  }
}

/** Side walls between a loop at `z0` and the same loop, moved, at `z1` (a draft). */
function taperedWalls(loop0, loop1, at, z0, z1, out) {
  const n = loop0.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    out.quad(
      at(loop0[i * 2], loop0[i * 2 + 1], z0),
      at(loop0[j * 2], loop0[j * 2 + 1], z0),
      at(loop1[j * 2], loop1[j * 2 + 1], z1),
      at(loop1[i * 2], loop1[i * 2 + 1], z1),
    );
  }
}

const loopArea = (loop) => {
  let a = 0;
  for (let i = 0, n = loop.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += loop[i * 2] * loop[j * 2 + 1] - loop[j * 2] * loop[i * 2 + 1];
  }
  return a / 2;
};

/**
 * A loop moved `d` into the material at every vertex along its mitre — the
 * profile a drafted wall reaches at the far end. Outer loops are counter-clockwise
 * and holes clockwise, so the same rule shrinks an outer and grows a hole. Vertex
 * for vertex, so the walls join it quad by quad. Throws when an edge would turn
 * round (the draft is too steep for the profile).
 */
export function draftLoop(loop, d) {
  const n = loop.length / 2;
  const P = (i) => [loop[((i + n) % n) * 2], loop[((i + n) % n) * 2 + 1]];
  const normal = (a, b) => {
    const dx = b[0] - a[0]; const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [dy / l, -dx / l];
  };
  const out = new Array(loop.length);
  for (let i = 0; i < n; i++) {
    const n1 = normal(P(i - 1), P(i));
    const n2 = normal(P(i), P(i + 1));
    const k = 1 + n1[0] * n2[0] + n1[1] * n2[1];
    const m = k > 1e-6 ? [(n1[0] + n2[0]) / k, (n1[1] + n2[1]) / k] : n1;
    out[i * 2] = P(i)[0] - d * m[0];
    out[i * 2 + 1] = P(i)[1] - d * m[1];
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = loop[j * 2] - loop[i * 2]; const ey = loop[j * 2 + 1] - loop[i * 2 + 1];
    const fx = out[j * 2] - out[i * 2]; const fy = out[j * 2 + 1] - out[i * 2 + 1];
    if (ex * fx + ey * fy <= 0) throw new Error('The draft is too steep for this profile — an edge would vanish. Make it smaller or the extrude shorter.');
  }
  if (Math.sign(loopArea(out)) !== Math.sign(loopArea(loop))) {
    throw new Error('The draft is too steep for this profile — it closes up before the far end.');
  }
  return out;
}

/**
 * Extrude one region — an outer loop and its holes — into a solid slab.
 *
 * `depth` runs along the plane's normal. A negative depth extrudes the other
 * way, which is what "reverse direction" means in any CAD; the caps swap so the
 * result is still outward-facing.
 *
 * @param {{outer:number[], holes?:number[][]}} region  loops in sketch coordinates
 * @param {{depth:number, plane?:object, base?:number}} opts
 *   `base` lifts the whole slab off the plane (a boss standing on a face).
 */
export function extrudeRegion(region, {
  depth, plane, base = 0, draft = 0,
} = {}) {
  if (!region?.outer || region.outer.length < 6) {
    throw new Error('That profile has no closed outer boundary to extrude.');
  }
  if (!Number.isFinite(depth) || depth === 0) {
    throw new Error('An extrude needs a depth.');
  }
  const holes = region.holes || [];
  const { vertices, indices } = triangulate(region.outer, holes);
  if (!indices.length) {
    throw new Error('That profile could not be triangulated — check it for crossing lines.');
  }

  const at = placer(plane);
  const out = soupBuilder();
  const lo = base + Math.min(0, depth);
  const hi = base + Math.max(0, depth);
  const V = (i, h) => at(vertices[i * 2], vertices[i * 2 + 1], h);

  // Draft: the walls lean in by `draft` degrees, so the profile at the far end
  // (away from the plane) is the sketch moved into the material; a negative
  // draft leans them out.
  if (draft) {
    const d = Math.abs(depth) * Math.tan((draft * Math.PI) / 180);
    const loops = [region.outer, ...holes];
    const far = loops.map((l) => draftLoop(l, d));
    const t = triangulate(far[0], far.slice(1));
    if (!t.indices.length) throw new Error('The drafted end could not be triangulated — make the draft smaller.');
    const up = depth > 0;
    const nearH = up ? lo : hi;
    const farH = up ? hi : lo;
    const Vf = (i) => at(t.vertices[i * 2], t.vertices[i * 2 + 1], farH);
    for (let k = 0; k < indices.length; k += 3) {
      const [a, b, c] = [indices[k], indices[k + 1], indices[k + 2]];
      if (up) out.tri(V(c, nearH), V(b, nearH), V(a, nearH));
      else out.tri(V(a, nearH), V(b, nearH), V(c, nearH));
    }
    for (let k = 0; k < t.indices.length; k += 3) {
      const [a, b, c] = [t.indices[k], t.indices[k + 1], t.indices[k + 2]];
      if (up) out.tri(Vf(a), Vf(b), Vf(c));
      else out.tri(Vf(c), Vf(b), Vf(a));
    }
    loops.forEach((l, i) => (up
      ? taperedWalls(l, far[i], at, lo, hi, out)
      : taperedWalls(far[i], l, at, lo, hi, out)));
    return out.build('extrude');
  }

  for (let k = 0; k < indices.length; k += 3) {
    const [a, b, c] = [indices[k], indices[k + 1], indices[k + 2]];
    out.tri(V(a, hi), V(b, hi), V(c, hi)); // top cap: CCW as triangulated
    out.tri(V(c, lo), V(b, lo), V(a, lo)); // bottom cap: reversed, facing down
  }
  for (const loop of [region.outer, ...holes]) walls(loop, at, lo, hi, out);

  return out.build('extrude');
}

/** Merge several soups into one, so a sketch of many regions is a single part. */
export function mergeSoups(soups, format = 'extrude') {
  const live = soups.filter((s) => s && s.triangleCount > 0);
  if (!live.length) throw new Error('Nothing to build — no closed profile was found.');
  if (live.length === 1) return { ...live[0], format };
  const total = live.reduce((n, s) => n + s.positions.length, 0);
  const positions = new Float32Array(total);
  let at = 0;
  for (const s of live) { positions.set(s.positions, at); at += s.positions.length; }
  return { positions, triangleCount: positions.length / 9, format };
}

/**
 * Revolve a region about one of the sketch's own axes — how a turned part is
 * drawn: a half-profile against a centreline, swept round.
 *
 * The profile has to sit entirely on one side of the axis, and the side it is on
 * is worked out rather than demanded, so a profile drawn below the X axis
 * revolves the same as one drawn above it. Crossing the axis is refused: the
 * result would be a solid that passes through its own centre, which is never
 * what was meant and is not obvious on screen.
 *
 * A full turn needs no end caps and does not get any; a partial one is capped
 * with the profile at each end.
 *
 * @param {{outer:number[], holes?:number[][]}} region
 * @param {{axis?:'x'|'y', angle?:number, plane?:object, segments?:number}} opts
 */
export function revolveRegion(region, {
  axis = 'x', angle = Math.PI * 2, plane, segments,
} = {}) {
  if (!region?.outer || region.outer.length < 6) {
    throw new Error('That profile has no closed outer boundary to revolve.');
  }
  const loops = [region.outer, ...(region.holes || [])];
  // Distance from the axis is the radius; the other coordinate runs along it.
  const radiusAt = (loop, i) => (axis === 'x' ? loop[i * 2 + 1] : loop[i * 2]);
  const alongAt = (loop, i) => (axis === 'x' ? loop[i * 2] : loop[i * 2 + 1]);

  let minR = Infinity;
  let maxR = -Infinity;
  for (const loop of loops) {
    for (let i = 0; i < loop.length / 2; i++) {
      const r = radiusAt(loop, i);
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
  }
  if (minR < -1e-9 && maxR > 1e-9) {
    throw new Error(`That profile crosses the ${axis.toUpperCase()} axis — a revolve needs it wholly on one side.`);
  }
  const flip = maxR <= 1e-9; // drawn on the negative side: mirror it up

  const full = Math.abs(Math.abs(angle) - Math.PI * 2) < 1e-9;
  const sweep = full ? Math.PI * 2 : angle;
  // One segment per ~3°, which is where a turned face stops looking faceted, and
  // enough radial resolution for the dexel/voxel simulator to bite into.
  const steps = Math.max(12, Math.min(720, segments || Math.ceil(Math.abs(sweep) / (Math.PI / 60))));

  // Angles are precomputed so a full turn can close on **exactly** the angle it
  // started at. Computed as `sweep * steps / steps` the last one is 2π, whose
  // sine is −2.4e-16 rather than zero, and the seam ends a hair away from where
  // it began — a surface that is watertight everywhere except one line.
  const angles = [];
  for (let k = 0; k <= steps; k++) angles.push((sweep * k) / steps);
  if (full) angles[steps] = angles[0];

  const at = placer(plane);
  const out = soupBuilder();
  // Sketch-plane coordinates of a profile point turned by `a` about the axis.
  const spin = (r, s, a) => (axis === 'x'
    ? at(s, r * Math.cos(a), r * Math.sin(a))
    : at(r * Math.cos(a), s, r * Math.sin(a)));

  for (const loop of loops) {
    const n = loop.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const r0 = (flip ? -1 : 1) * radiusAt(loop, i);
      const r1 = (flip ? -1 : 1) * radiusAt(loop, j);
      const s0 = alongAt(loop, i);
      const s1 = alongAt(loop, j);
      for (let k = 0; k < steps; k++) {
        const a0 = angles[k];
        const a1 = angles[k + 1];
        // Mirroring reverses the profile's handedness, so the quad is wound the
        // other way to keep the surface facing out.
        if (flip) out.quad(spin(r0, s0, a0), spin(r0, s0, a1), spin(r1, s1, a1), spin(r1, s1, a0));
        else out.quad(spin(r0, s0, a0), spin(r1, s1, a0), spin(r1, s1, a1), spin(r0, s0, a1));
      }
    }
  }

  if (!full) {
    const { vertices, indices } = triangulate(region.outer, region.holes || []);
    const V = (i, a) => {
      const r = (flip ? -1 : 1) * (axis === 'x' ? vertices[i * 2 + 1] : vertices[i * 2]);
      const s = axis === 'x' ? vertices[i * 2] : vertices[i * 2 + 1];
      return spin(r, s, a);
    };
    for (let k = 0; k < indices.length; k += 3) {
      const [a, b, c] = [indices[k], indices[k + 1], indices[k + 2]];
      out.tri(V(a, 0), V(c, 0), V(b, 0));
      out.tri(V(a, sweep), V(b, sweep), V(c, sweep));
    }
  }

  return out.build('revolve');
}

/**
 * Build a solid from every region of a sketch.
 *
 * `regions` comes from `sketchRegions`. Each is built independently and the
 * results merged, so two separate profiles on one sketch make one part with two
 * bodies — which is what extruding them together means, and what the CAM
 * pipeline (which has no concept of a body) will treat them as anyway.
 */
export function buildSolid(regions, { op = 'extrude', ...opts } = {}) {
  if (!regions?.length) {
    throw new Error('Nothing to build — draw a closed profile first.');
  }
  const build = op === 'revolve' ? revolveRegion : extrudeRegion;
  return mergeSoups(regions.map((r) => build(r, opts)), op);
}
