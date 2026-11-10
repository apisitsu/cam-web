/**
 * Hole Wizard — the holes a part is drilled with, built as SolidWorks builds them.
 *
 * A hole is not a profile to extrude: it is a **standard shape at a position**. The
 * operator says what kind (a plain drill, a tapped hole, a counterbore for a cap
 * screw, a countersink for a flat head) and where (points on a sketch), and the
 * shape follows from the kind. That is the whole point of a hole feature over a
 * circle and a cut — and what a later CAM step can read back: an M6 tapped hole is
 * a spot, a Ø5 drill and an M6 tap, which a Ø5 cylinder in a mesh never says.
 *
 * Each hole is a revolve of its half-section about its own axis, which runs from
 * the point into the part. Pure — plain arrays, like the rest of `engine/`.
 */
import { revolveRegion, mergeSoups } from './extrude.js';
import { planeBasis, planeToWorld } from '../sketch/plane.js';

/** The kinds of hole, by the name on the button. */
export const HOLE_TYPES = {
  drill: 'Drill',
  tap: 'Tapped',
  cbore: "C'bore",
  csk: "C'sink",
};

/**
 * Metric coarse threads and the drill each is tapped from (ISO 261 pitches, the
 * tap drill being the nominal size less the pitch).
 */
export const THREADS = {
  M3: { pitch: 0.5, drill: 2.5 },
  M4: { pitch: 0.7, drill: 3.3 },
  M5: { pitch: 0.8, drill: 4.2 },
  M6: { pitch: 1.0, drill: 5.0 },
  M8: { pitch: 1.25, drill: 6.8 },
  M10: { pitch: 1.5, drill: 8.5 },
  M12: { pitch: 1.75, drill: 10.2 },
  M16: { pitch: 2.0, drill: 14.0 },
  M20: { pitch: 2.5, drill: 17.5 },
};

/** Shortest side (mm) a hole's wall is faceted at — see `holeSegments`. */
const FACET = 0.3;

/**
 * How many sides a hole of radius `r` is drawn with: sides no shorter than
 * `FACET`, between 24 and 120. The revolve's usual one-per-3° gave a Ø6 hole
 * sides of 0.16 mm, and the boolean that cuts it cannot keep triangles that thin
 * apart where they cross a large face: the mouth came out with open edges. At
 * 0.3 mm a Ø6 is 64-sided and its sides stand under 0.004 mm off the true circle.
 */
export function holeSegments(r) {
  return Math.max(24, Math.min(120, Math.ceil((2 * Math.PI * r) / FACET)));
}

/** A drill's point: 118° included, the twist drill everyone has. */
const TIP_HALF = (59 * Math.PI) / 180;
/** How far above the face a hole starts, so its mouth never lies on the face it opens. */
const ABOVE = 0.5;

/** The diameter the hole is drilled at. */
export function drillDiameter(spec) {
  if (spec.holeType === 'tap') return THREADS[spec.thread]?.drill ?? THREADS.M6.drill;
  return spec.diameter;
}

/**
 * The hole's half-section: `[along, radius, ...]`, counter-clockwise, `along`
 * running from the face (0) into the part. A blind hole ends in a drill point;
 * one that goes through needs none.
 *
 * @param {object} spec  the hole feature's fields
 * @param {number} depth  how deep the full-diameter part goes
 * @param {boolean} through  whether it comes out the far side
 */
export function holeSection(spec, depth, through) {
  const r = drillDiameter(spec) / 2;
  if (!(r > 0)) throw new Error('a hole needs a diameter');
  if (!(depth > 0)) throw new Error('a hole needs a depth');
  const pts = [[-ABOVE, 0]];
  if (spec.holeType === 'cbore') {
    const R = spec.cbDiameter / 2;
    if (!(R > r)) throw new Error('the counterbore must be wider than the hole');
    if (!(spec.cbDepth > 0 && spec.cbDepth < depth)) throw new Error('the counterbore must be shallower than the hole');
    // 45° chamfers: `chamfer` on the counterbore's mouth, `holeChamfer` on the hole's
    // edge at the counterbore floor.
    const c = spec.chamfer > 0 ? spec.chamfer : 0;
    const h = spec.holeChamfer > 0 ? spec.holeChamfer : 0;
    if (!(c < spec.cbDepth)) throw new Error('the counterbore chamfer is deeper than the counterbore');
    if (!(r + h < R)) throw new Error('the hole chamfer is wider than the counterbore');
    if (!(spec.cbDepth + h < depth)) throw new Error('the hole chamfer is deeper than the hole');
    pts.push(c > 0 ? [-ABOVE, R + c + ABOVE] : [-ABOVE, R]);
    if (c > 0) pts.push([c, R]);
    pts.push([spec.cbDepth, R]);
    pts.push(h > 0 ? [spec.cbDepth, r + h] : [spec.cbDepth, r]);
    if (h > 0) pts.push([spec.cbDepth + h, r]);
  } else if (spec.holeType === 'csk') {
    const R = spec.cskDiameter / 2;
    if (!(R > r)) throw new Error('the countersink must be wider than the hole');
    const half = ((spec.cskAngle || 90) * Math.PI) / 360;
    const sinkDepth = (R - r) / Math.tan(half);
    if (!(sinkDepth < depth)) throw new Error('the countersink is deeper than the hole');
    pts.push([-ABOVE, R], [0, R], [sinkDepth, r]);
  } else if (spec.chamfer > 0) {
    // A 45° chamfer on the mouth, carried on above the face like every mouth here.
    if (!(spec.chamfer < depth)) throw new Error('the chamfer is deeper than the hole');
    pts.push([-ABOVE, r + spec.chamfer + ABOVE], [spec.chamfer, r]);
  } else {
    pts.push([-ABOVE, r]);
  }
  pts.push([depth, r]);
  pts.push(through ? [depth, 0] : [depth + r / Math.tan(TIP_HALF), 0]);

  // Counter-clockwise in (along, radius), the winding a profile is revolved with.
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    area += x0 * y1 - x1 * y0;
  }
  if (area < 0) pts.reverse();
  return pts.flat();
}

/** The places a hole could go: points on their own, and centres of circles. */
function holeSites(doc) {
  const used = new Set();
  const centres = [];
  for (const e of doc.entities.values()) {
    if (e.type === 'line') { used.add(e.p1); used.add(e.p2); }
    if (e.type === 'arc') { used.add(e.center); used.add(e.start); used.add(e.end); }
    if (e.type === 'circle') {
      used.add(e.center);
      if (!e.construction) centres.push(e.center);
    }
  }
  const own = [...doc.entities.values()]
    .filter((e) => e.type === 'point' && !e.origin && !e.construction && !used.has(e.id))
    .map((e) => e.id);
  return { own, centres };
}

/**
 * The points holes go at. `picked` are the entities the operator clicked: a point
 * is itself, a circle its centre, anything else nothing. A hole feature saved
 * before holes were picked has none, and goes at all the sketch's own points or,
 * when it has none, the centres of its circles.
 */
export function holePointIds(doc, picked) {
  if (!picked) {
    const { own, centres } = holeSites(doc);
    return own.length ? own : centres;
  }
  const ids = picked.map((id) => {
    const e = doc.entities.get(id);
    if (e?.type === 'point') return id;
    return e?.type === 'circle' ? e.center : null;
  });
  return [...new Set(ids.filter((id) => id != null))];
}

/** Where the holes go, as sketch (x, y). */
export function holePositions(doc, picked) {
  return holePointIds(doc, picked)
    .map((id) => doc.entities.get(id))
    .filter(Boolean)
    .map((p) => [p.x, p.y]);
}

/** The sites of `doc` that none of `pickedSets`, one per hole feature, has used. */
export function unusedHoleSites(doc, pickedSets) {
  const taken = new Set(pickedSets.flatMap((picked) => holePointIds(doc, picked)));
  const { own, centres } = holeSites(doc);
  return [...own, ...centres].filter((id) => !taken.has(id));
}

/**
 * What each hole of a feature is, for CAM: what a Ø5 cylinder in a mesh cannot say.
 *
 * `at` is the mouth in world coordinates, `axis` runs from it into the part, `depth`
 * is the full-diameter length and `tip` the drill point below that.
 */
export function holeRecords(positions, plane, spec, { depth, through = false, reverse = false }) {
  const { n } = planeBasis(plane);
  const axis = reverse ? [...n] : n.map((v) => -v);
  const drill = drillDiameter(spec);
  const thread = spec.holeType === 'tap'
    ? { name: spec.thread, pitch: THREADS[spec.thread]?.pitch ?? THREADS.M6.pitch, depth: spec.threadDepth }
    : null;
  const counterbore = spec.holeType === 'cbore'
    ? { diameter: spec.cbDiameter, depth: spec.cbDepth }
    : null;
  const countersink = spec.holeType === 'csk'
    ? { diameter: spec.cskDiameter, angle: spec.cskAngle || 90 }
    : null;
  return positions.map(([x, y]) => ({
    holeType: spec.holeType,
    at: planeToWorld(plane, x, y),
    axis,
    drill,
    depth,
    through,
    tip: through ? 0 : drill / 2 / Math.tan(TIP_HALF),
    chamfer: spec.holeType !== 'csk' && spec.chamfer > 0 ? spec.chamfer : 0,
    holeChamfer: spec.holeType === 'cbore' && spec.holeChamfer > 0 ? spec.holeChamfer : 0,
    thread,
    counterbore,
    countersink,
  }));
}

/**
 * The solid to cut: one hole at each position, running into the part.
 *
 * @param {number[][]} positions  sketch (x, y)
 * @param {object} plane  the sketch's plane; a hole runs against its normal
 *   (into a part the plane is the top face of) unless `reverse`
 */
export function holeSolid(positions, plane, spec, { depth, through = false, reverse = false, segments } = {}) {
  if (!positions.length) throw new Error('its sketch has no point to put a hole at');
  const section = holeSection(spec, depth, through);
  const { n, u } = planeBasis(plane);
  const axis = reverse ? n : n.map((v) => -v);
  const sides = segments ?? holeSegments(drillDiameter(spec) / 2);
  const soups = positions.map(([x, y]) => revolveRegion({ outer: section }, {
    axis: 'x',
    // A frame whose X axis is the hole's: from the point, into the part.
    plane: { origin: planeToWorld(plane, x, y), u: axis, v: u },
    segments: sides,
  }));
  return mergeSoups(soups, 'hole');
}
