/**
 * Read a DXF into a sketch — the other half of `dxf.js`, and the thing that
 * closes the loop with the rest of the shop.
 *
 * Export existed from the start; import did not, so a drawing that already
 * existed in SolidWorks or AutoCAD had to be redrawn here before it could be
 * machined. This reads the same **R12 ASCII** dialect `dxf.js` writes, plus the
 * entities later versions put in files that still call themselves R12 —
 * `LWPOLYLINE` above all, which is what every modern CAD writes a rectangle as.
 *
 * ## Endpoints are welded, and that is the point
 *
 * A DXF carries no topology: four lines round a rectangle are four independent
 * pairs of coordinates that happen to coincide. The sketcher is point-based, and
 * `sketchLoops` chains through *shared point ids* — so an import that made eight
 * separate points would produce a profile that looks closed, cannot be chained,
 * and refuses to extrude for no visible reason. Every endpoint therefore goes
 * through a tolerance weld on the way in.
 *
 * ## Units
 *
 * `$INSUNITS` is honoured. A drawing in inches is scaled to mm, because
 * everything downstream — feeds, tools, the machine — is mm, and a part that
 * comes in 25.4× too small is the kind of mistake that reaches the floor.
 *
 * Pure: text in, sketch document out. No DOM.
 */
import {
  createSketch, addPoint, addLine, addCircle, addArc,
} from './model.js';
import { LAYER_CONSTRUCTION } from './dxf.js';

const DEG = Math.PI / 180;

/**
 * `$INSUNITS` codes worth handling. Anything else (or absent) is taken as mm:
 * the value is optional in the spec and a great many exporters leave it 0, so
 * refusing those would reject most real files.
 */
const UNIT_SCALE = {
  1: 25.4, // inches
  2: 304.8, // feet
  4: 1, // millimetres
  5: 10, // centimetres
  6: 1000, // metres
};

/**
 * Split the file into `{ code, value }` pairs.
 *
 * A DXF is strictly one group code per line followed by one value per line.
 * Handles CRLF and a trailing blank line; a stray odd line at the end is
 * dropped rather than throwing, because it cannot carry meaning on its own.
 */
export function parsePairs(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isFinite(code)) return out; // not a DXF from here on
    out.push({ code, value: lines[i + 1].trim() });
  }
  return out;
}

/** Group the ENTITIES section into one record per entity. */
function readEntities(pairs) {
  const entities = [];
  let inEntities = false;
  let current = null;

  for (let i = 0; i < pairs.length; i++) {
    const { code, value } = pairs[i];
    if (code === 0 && value === 'SECTION') {
      const next = pairs[i + 1];
      inEntities = next?.code === 2 && next.value === 'ENTITIES';
      continue;
    }
    if (code === 0 && value === 'ENDSEC') {
      if (current) { entities.push(current); current = null; }
      inEntities = false;
      continue;
    }
    if (!inEntities) continue;
    if (code === 0) {
      if (current) entities.push(current);
      current = value === 'EOF' ? null : { type: value, codes: [] };
      continue;
    }
    if (current) current.codes.push({ code, value });
  }
  if (current) entities.push(current);
  return entities;
}

/** First value for a group code, as a number. */
const num = (e, code, fallback = null) => {
  for (const c of e.codes) if (c.code === code) return Number(c.value);
  return fallback;
};
/** First value for a group code, as text. */
const str = (e, code, fallback = '') => {
  for (const c of e.codes) if (c.code === code) return c.value;
  return fallback;
};
/** Every value for a group code, in order — polyline vertices repeat theirs. */
const all = (e, code) => e.codes.filter((c) => c.code === code).map((c) => Number(c.value));

/** The document scale from the HEADER's `$INSUNITS`, in mm per drawing unit. */
export function unitScale(pairs) {
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].code === 9 && pairs[i].value === '$INSUNITS') {
      const v = pairs[i + 1];
      if (v && v.code === 70) return UNIT_SCALE[Number(v.value)] ?? 1;
      return 1;
    }
  }
  return 1;
}

/**
 * The arc through two polyline vertices carrying a **bulge**.
 *
 * Bulge is `tan(θ/4)` for the included angle θ, signed so positive sweeps
 * counter-clockwise — the same direction the sketch model and planegcs use, so a
 * positive bulge maps to `addArc(centre, from, to)` directly and a negative one
 * is the same arc named from the other end.
 *
 * @returns {{cx:number, cy:number, r:number, ccwFromFirst:boolean}|null}
 */
export function bulgeArc(x1, y1, x2, y2, bulge) {
  if (!bulge) return null;
  const chord = Math.hypot(x2 - x1, y2 - y1);
  if (!(chord > 0)) return null;
  const theta = 4 * Math.atan(bulge);
  const half = Math.sin(theta / 2);
  if (Math.abs(half) < 1e-12) return null; // a straight line in all but name
  const r = chord / (2 * half); // signed with the sweep
  const h = r * Math.cos(theta / 2);
  return {
    cx: (x1 + x2) / 2 - ((y2 - y1) / chord) * h,
    cy: (y1 + y2) / 2 + ((x2 - x1) / chord) * h,
    r: Math.abs(r),
    ccwFromFirst: theta > 0,
  };
}

/** Vertices of an LWPOLYLINE / POLYLINE, with the bulge that follows each. */
function polylineVertices(e) {
  const xs = all(e, 10);
  const ys = all(e, 20);
  // Bulges are sparse: a group 42 belongs to the vertex whose 10 preceded it.
  const bulges = new Array(xs.length).fill(0);
  let at = -1;
  for (const c of e.codes) {
    if (c.code === 10) at += 1;
    else if (c.code === 42 && at >= 0 && at < bulges.length) bulges[at] = Number(c.value);
  }
  const n = Math.min(xs.length, ys.length);
  return { points: Array.from({ length: n }, (_, i) => [xs[i], ys[i]]), bulges };
}

/**
 * Convert DXF text to a sketch document.
 *
 * @param {string} text
 * @param {{weldTol?:number, includePoints?:boolean}} [opts]
 *   `weldTol` is in **millimetres after scaling** — 1 µm by default, tight
 *   enough that two genuinely distinct points survive and loose enough to
 *   absorb what a CAD wrote out at six decimal places.
 * @returns {{sk:object, counts:object, warnings:string[]}}
 */
export function dxfToSketch(text, { weldTol = 1e-3, includePoints = true } = {}) {
  const pairs = parsePairs(text);
  if (!pairs.length) throw new Error('That file is not a DXF (nothing could be read from it).');
  const entities = readEntities(pairs);
  if (!entities.length) {
    throw new Error('That DXF has no ENTITIES section — there is nothing in it to import.');
  }
  const scale = unitScale(pairs);

  const sk = createSketch();
  const origin = addPoint(sk, 0, 0, true);
  sk.entities.get(origin).origin = true;

  // Welding by grid bucket rather than by scanning every point: a real drawing
  // can carry thousands of endpoints and the O(n²) scan the sketcher's own weld
  // uses (dozens of points) does not survive that.
  const buckets = new Map();
  const key = (x, y) => `${Math.round(x / weldTol)},${Math.round(y / weldTol)}`;
  const pointAt = (x, y) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const hit = buckets.get(`${Math.round(x / weldTol) + dx},${Math.round(y / weldTol) + dy}`);
        if (hit !== undefined) {
          const p = sk.entities.get(hit);
          if (Math.abs(p.x - x) <= weldTol && Math.abs(p.y - y) <= weldTol) return hit;
        }
      }
    }
    const id = addPoint(sk, x, y);
    buckets.set(key(x, y), id);
    return id;
  };
  // The origin is a real point at (0,0) and geometry landing there must share it.
  buckets.set(key(0, 0), origin);

  const counts = {
    line: 0, circle: 0, arc: 0, point: 0, polyline: 0, skipped: 0,
  };
  const warnings = [];
  const skipped = new Set();

  const mark = (id, e) => {
    if (str(e, 8) === LAYER_CONSTRUCTION) sk.entities.get(id).construction = true;
  };

  const addSeg = (e, x1, y1, x2, y2, bulge) => {
    const arc = bulgeArc(x1, y1, x2, y2, bulge);
    if (!arc) {
      const a = pointAt(x1, y1);
      const b = pointAt(x2, y2);
      if (a === b) return; // zero-length after welding
      mark(addLine(sk, a, b), e);
      counts.line += 1;
      return;
    }
    const c = pointAt(arc.cx, arc.cy);
    const a = pointAt(x1, y1);
    const b = pointAt(x2, y2);
    if (a === b) return;
    // The model sweeps counter-clockwise from start to end, so a clockwise
    // bulge is the same arc named from its other end.
    mark(arc.ccwFromFirst ? addArc(sk, c, a, b, arc.r) : addArc(sk, c, b, a, arc.r), e);
    counts.arc += 1;
  };

  for (const e of entities) {
    switch (e.type) {
      case 'LINE': {
        addSeg(e, num(e, 10, 0) * scale, num(e, 20, 0) * scale,
          num(e, 11, 0) * scale, num(e, 21, 0) * scale, 0);
        break;
      }
      case 'CIRCLE': {
        const r = num(e, 40, 0) * scale;
        if (!(r > 0)) break;
        const c = pointAt(num(e, 10, 0) * scale, num(e, 20, 0) * scale);
        mark(addCircle(sk, c, r), e);
        counts.circle += 1;
        break;
      }
      case 'ARC': {
        const r = num(e, 40, 0) * scale;
        if (!(r > 0)) break;
        const cx = num(e, 10, 0) * scale;
        const cy = num(e, 20, 0) * scale;
        const a0 = num(e, 50, 0) * DEG;
        const a1 = num(e, 51, 0) * DEG;
        const c = pointAt(cx, cy);
        // DXF arcs run counter-clockwise from 50 to 51, the same as the model's,
        // so the endpoints drop straight onto the rim at those angles.
        const s = pointAt(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
        const en = pointAt(cx + r * Math.cos(a1), cy + r * Math.sin(a1));
        if (s === en) break; // a full turn written as an arc — no sweep to take
        mark(addArc(sk, c, s, en, r), e);
        counts.arc += 1;
        break;
      }
      case 'POINT': {
        if (!includePoints) break;
        mark(pointAt(num(e, 10, 0) * scale, num(e, 20, 0) * scale), e);
        counts.point += 1;
        break;
      }
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const { points, bulges } = polylineVertices(e);
        if (points.length < 2) break;
        const closed = (num(e, 70, 0) & 1) === 1;
        const last = closed ? points.length : points.length - 1;
        for (let i = 0; i < last; i++) {
          const [x1, y1] = points[i];
          const [x2, y2] = points[(i + 1) % points.length];
          addSeg(e, x1 * scale, y1 * scale, x2 * scale, y2 * scale, bulges[i]);
        }
        counts.polyline += 1;
        break;
      }
      case 'VERTEX':
      case 'SEQEND':
        // Carried by the POLYLINE above; `polylineVertices` reads a POLYLINE's
        // own 10/20 groups, so a file that puts them on VERTEX records instead
        // arrives here — counted as skipped rather than silently ignored.
        if (e.type === 'VERTEX') { skipped.add('VERTEX'); counts.skipped += 1; }
        break;
      default:
        skipped.add(e.type);
        counts.skipped += 1;
    }
  }

  if (skipped.size) {
    warnings.push(`Not imported: ${[...skipped].sort().join(', ')} — this reads lines, circles, arcs, points and polylines.`);
  }
  if (scale !== 1) {
    warnings.push(`The drawing was in other units and has been scaled ×${scale} to millimetres.`);
  }
  const drawn = counts.line + counts.circle + counts.arc;
  if (!drawn) {
    throw new Error('That DXF holds no lines, circles or arcs to import.');
  }
  return { sk, counts, warnings };
}
