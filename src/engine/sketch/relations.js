/**
 * The relations a sketch selection can take — SolidWorks' "Add Relations" list,
 * worked out from what is selected so the right-click menu offers only the ones
 * that apply.
 *
 * Pure: reads the sketch, never changes it. Each entry is
 * `{ key, label, constraints: [[kind, refs], …] }`; one relation may be several
 * model constraints (Equal on four lines is three `equalLength`s, chained to the
 * first one picked), and the store applies them together as one undo step.
 */

const chain = (kind, ids) => ids.slice(1).map((id) => [kind, [ids[0], id]]);

export function relationsFor(sk, selection) {
  const ents = selection.map((id) => sk.entities.get(id));
  if (!ents.length || ents.some((e) => !e)) return [];
  const n = ents.length;
  const of = (...types) => ents.filter((e) => types.includes(e.type)).map((e) => e.id);
  const points = of('point');
  const lines = of('line');
  const curves = of('circle', 'arc');
  const arcs = of('arc');
  const out = [];
  const add = (key, label, constraints) => { if (constraints.length) out.push({ key, label, constraints }); };
  const ends = (id) => { const l = sk.entities.get(id); return [l.p1, l.p2]; };
  const centre = (id) => sk.entities.get(id).center;

  if (lines.length === n) {
    add('horizontal', 'Horizontal', lines.map((id) => ['horizontal', ends(id)]));
    add('vertical', 'Vertical', lines.map((id) => ['vertical', ends(id)]));
    if (n >= 2) {
      add('equal', 'Equal', chain('equalLength', lines));
      add('parallel', 'Parallel', chain('parallel', lines));
    }
    if (n === 2) add('perpendicular', 'Perpendicular', [['perpendicular', lines]]);
  }

  if (curves.length === n && n >= 2) {
    add('equal', 'Equal', chain('equalRadius', curves));
    const c0 = centre(curves[0]);
    add('concentric', 'Concentric', curves.slice(1)
      .filter((id) => centre(id) !== c0)
      .map((id) => ['coincident', [c0, centre(id)]]));
    if (n === 2 && arcs.length === 2) add('tangent', 'Tangent', [['tangentArcArc', arcs]]);
  }

  if (points.length === n && n === 2) {
    add('coincident', 'Coincident', [['coincident', points]]);
    add('horizontal', 'Horizontal', [['horizontal', points]]);
    add('vertical', 'Vertical', [['vertical', points]]);
  }

  if (n === 2 && points.length === 1 && lines.length === 1) {
    add('onLine', 'On Line', [['pointOnLine', [points[0], lines[0]]]]);
    add('midpoint', 'Midpoint', [['midpoint', [points[0], lines[0]]]]);
  }

  if (n === 2 && points.length === 1 && curves.length === 1) {
    const curve = sk.entities.get(curves[0]);
    add('onCurve', 'On Curve', [[curve.type === 'arc' ? 'pointOnArc' : 'pointOnCircle', [points[0], curves[0]]]]);
    if (curve.center !== points[0]) add('concentric', 'Concentric', [['coincident', [points[0], curve.center]]]);
  }

  if (n === 2 && lines.length === 1 && curves.length === 1) {
    const arc = sk.entities.get(curves[0]).type === 'arc';
    add('tangent', 'Tangent', [[arc ? 'tangentArc' : 'tangent', [lines[0], curves[0]]]]);
  }

  if (n === 3 && points.length === 2 && lines.length === 1) {
    add('symmetric', 'Symmetric', [['symmetric', [points[0], points[1], lines[0]]]]);
  }

  return out;
}
