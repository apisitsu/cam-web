/**
 * Phase 2 — 2D Sketch document model (dependency-free, point-based).
 *
 * The app-side representation of a sketch: geometry entities and the
 * constraints between them, plus degree-of-freedom bookkeeping. It is
 * *solver-agnostic* — planegcs (FreeCAD's WASM constraint solver) does the
 * actual solve in `planegcs.js`, which this model maps to almost 1:1.
 *
 * Geometry is **point-based**, exactly like planegcs and every real CAD kernel:
 * points are first-class entities; lines and circles reference point ids rather
 * than owning coordinates. Shared corners are therefore the *same* point, so a
 * closed profile needs no coincidence constraints at all.
 *
 * Coordinate system: sketch-local XY, millimetres. Angles in radians.
 */

/**
 * Entity kinds and the free numeric parameters each contributes to the solve.
 * A point owns [x, y]; lines/arcs are defined by the points they reference, so
 * they add no parameters of their own except a circle/arc radius.
 *   point  : 2 (x, y)          — 0 if fixed
 *   line   : 0 (two point refs)
 *   circle : 1 (radius; centre is a point)
 *   arc    : 3 (radius + start/end angle; centre + 2 endpoints are point refs)
 *
 * An arc references a centre and two endpoint points, and owns radius plus its
 * two sweep angles. Its endpoints are pinned to the rim by the solver's built-in
 * `arc_rules` (see planegcs.js), which removes 4 DOF (2 per endpoint); that
 * internal removal is accounted for in `dof()`, not here, since it is not a
 * user-visible constraint.
 */
export const ENTITY_KINDS = {
  point: { refs: 0, ownParams: 2 },
  line: { refs: 2, refTypes: ['point', 'point'], ownParams: 0 },
  circle: { refs: 1, refTypes: ['point'], ownParams: 1 },
  arc: { refs: 3, refTypes: ['point', 'point', 'point'], ownParams: 3 },
};

/** DOF removed by an arc's built-in rim coupling (arc_rules): 2 per endpoint. */
const ARC_INTERNAL_DOF = 4;

/**
 * Constraint kinds: which entity types they reference, whether they carry a
 * numeric value (a dimension), and the nominal degrees of freedom removed.
 * `dof` assumes independence — planegcs detects real redundancy/conflict; this
 * figure drives the sketcher's under/full/over feedback only.
 */
export const CONSTRAINT_KINDS = {
  coincident: { refTypes: ['point', 'point'], value: false, dof: 2 },
  lockX: { refTypes: ['point'], value: true, dof: 1 }, // pin x coordinate
  lockY: { refTypes: ['point'], value: true, dof: 1 },
  horizontal: { refTypes: ['point', 'point'], value: false, dof: 1 },
  vertical: { refTypes: ['point', 'point'], value: false, dof: 1 },
  parallel: { refTypes: ['line', 'line'], value: false, dof: 1 },
  perpendicular: { refTypes: ['line', 'line'], value: false, dof: 1 },
  pointOnLine: { refTypes: ['point', 'line'], value: false, dof: 1 },
  distance: { refTypes: ['point', 'point'], value: true, dof: 1 },
  pointLineDistance: { refTypes: ['point', 'line'], value: true, dof: 1 },
  radius: { refTypes: ['circle'], value: true, dof: 1 },
  equalLength: { refTypes: ['line', 'line'], value: false, dof: 1 },
};

/** Create an empty sketch document. */
export function createSketch() {
  return { entities: new Map(), constraints: [], nextId: 1 };
}

function requireEntity(sk, id, wantType) {
  const e = sk.entities.get(id);
  if (!e) throw new Error(`missing entity ${id}`);
  if (wantType && e.type !== wantType) {
    throw new Error(`expected ${wantType} for entity ${id}, got ${e.type}`);
  }
  return e;
}

/** Add a point. `fixed` grounds it (contributes no DOF). Returns its id. */
export function addPoint(sk, x, y, fixed = false) {
  const id = sk.nextId++;
  sk.entities.set(id, { id, type: 'point', x, y, fixed: !!fixed });
  return id;
}

/** Add a line between two existing point ids. Returns its id. */
export function addLine(sk, p1, p2) {
  requireEntity(sk, p1, 'point');
  requireEntity(sk, p2, 'point');
  const id = sk.nextId++;
  sk.entities.set(id, { id, type: 'line', p1, p2 });
  return id;
}

/** Convenience: create two points and the line joining them. */
export function addLineXY(sk, x1, y1, x2, y2) {
  const p1 = addPoint(sk, x1, y1);
  const p2 = addPoint(sk, x2, y2);
  return { line: addLine(sk, p1, p2), p1, p2 };
}

/** Add a circle around an existing centre point id. Returns its id. */
export function addCircle(sk, center, r) {
  requireEntity(sk, center, 'point');
  const id = sk.nextId++;
  sk.entities.set(id, { id, type: 'circle', center, r });
  return id;
}

/** Convenience: create the centre point and the circle around it. */
export function addCircleXY(sk, cx, cy, r) {
  const center = addPoint(sk, cx, cy);
  return { circle: addCircle(sk, center, r), center };
}

/**
 * Add an arc from three existing point ids — a centre, a start, and an end — plus
 * a radius. planegcs sweeps **counter-clockwise** from start to end, so the caller
 * decides orientation by which endpoint is `start`. The two endpoints should sit
 * on (or near) the rim of radius `r`; the solver's arc_rules pull them exact.
 * Returns the arc id.
 */
export function addArc(sk, center, start, end, r) {
  requireEntity(sk, center, 'point');
  requireEntity(sk, start, 'point');
  requireEntity(sk, end, 'point');
  const id = sk.nextId++;
  sk.entities.set(id, { id, type: 'arc', center, start, end, r });
  return id;
}

/**
 * Add a constraint. `refs` are entity ids whose types must match the kind;
 * `value` is required for dimensional kinds and forbidden otherwise. Returns
 * the constraint index.
 */
export function addConstraint(sk, kind, refs, value) {
  const spec = CONSTRAINT_KINDS[kind];
  if (!spec) throw new Error(`unknown constraint: ${kind}`);
  if (refs.length !== spec.refTypes.length) {
    throw new Error(`${kind} needs ${spec.refTypes.length} refs, got ${refs.length}`);
  }
  refs.forEach((id, i) => requireEntity(sk, id, spec.refTypes[i]));
  if (spec.value && !Number.isFinite(value)) {
    throw new Error(`${kind} requires a numeric value`);
  }
  if (!spec.value && value !== undefined) {
    throw new Error(`${kind} does not take a value`);
  }
  sk.constraints.push({ kind, refs: refs.slice(), value: spec.value ? value : null });
  return sk.constraints.length - 1;
}

/** Sum of free geometric parameters (fixed points and point-defined lines add none). */
export function totalDof(sk) {
  let n = 0;
  for (const e of sk.entities.values()) {
    if (e.type === 'point') n += e.fixed ? 0 : 2;
    else n += ENTITY_KINDS[e.type].ownParams;
  }
  return n;
}

/**
 * DOF summary: { params, removed, free, state } where state is
 * 'under' | 'full' | 'over' — the standard sketcher feedback.
 */
export function dof(sk) {
  const params = totalDof(sk);
  let removed = 0;
  for (const c of sk.constraints) removed += CONSTRAINT_KINDS[c.kind].dof;
  // Each arc carries its built-in rim coupling (arc_rules), not a user constraint.
  for (const e of sk.entities.values()) if (e.type === 'arc') removed += ARC_INTERNAL_DOF;
  const free = params - removed;
  const state = free > 0 ? 'under' : free === 0 ? 'full' : 'over';
  return { params, removed, free, state };
}

/** Serialize to a plain JSON-safe object. */
export function serialize(sk) {
  return {
    entities: [...sk.entities.values()].map((e) => ({ ...e })),
    constraints: sk.constraints.map((c) => ({ ...c, refs: [...c.refs] })),
    nextId: sk.nextId,
  };
}

/** Rebuild a sketch from `serialize` output. */
export function deserialize(doc) {
  const sk = createSketch();
  for (const e of doc.entities) sk.entities.set(e.id, { ...e });
  sk.constraints = doc.constraints.map((c) => ({ ...c, refs: c.refs.slice() }));
  sk.nextId = doc.nextId;
  return sk;
}
