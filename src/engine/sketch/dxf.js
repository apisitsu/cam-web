/**
 * DXF export for a sketch.
 *
 * DXF is the one interchange format that is both open and universally read —
 * AutoCAD, SolidWorks, CATIA, Fusion and every CAM package import it — so it is
 * how a 2D sketch leaves cam-web. (DWG, SLDPRT and CATPart are closed binary
 * formats with no practical writer; solids will need STEP once Phase 3 brings
 * OCCT in.)
 *
 * Emits **R12 ASCII**, the most widely accepted dialect: no object handles, no
 * classes, just a HEADER, a LAYER table and ENTITIES. Pure — takes a sketch,
 * returns a string.
 */

/** DXF group code + value, one per line. */
const g = (code, value) => `${code}\n${value}\n`;

/** Trim float noise so the file reads cleanly and diffs stably. */
const num = (v) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
};

const DEG = 180 / Math.PI;
const normDeg = (d) => ((d % 360) + 360) % 360;

export const LAYER_GEOMETRY = 'SKETCH';
export const LAYER_CONSTRUCTION = 'CONSTRUCTION';

/**
 * Convert a sketch to DXF text.
 *
 * Points, lines, circles and arcs are written; construction geometry goes on its
 * own layer so the receiving CAD can hide or delete it in one action, matching
 * how it is treated here (reference only, excluded from the profile).
 *
 * @param {object} sk  sketch document (model.js)
 * @param {{includePoints?:boolean, includeConstruction?:boolean}} [opts]
 */
export function sketchToDxf(sk, { includePoints = false, includeConstruction = true } = {}) {
  const P = (id) => sk?.entities?.get(id);
  const ents = sk?.entities ? [...sk.entities.values()] : [];
  let out = '';

  // HEADER: millimetres, and the R12 version marker readers switch on.
  out += g(0, 'SECTION') + g(2, 'HEADER');
  out += g(9, '$ACADVER') + g(1, 'AC1009');
  out += g(9, '$INSUNITS') + g(70, 4); // 4 = millimetres
  out += g(0, 'ENDSEC');

  // TABLES: declare the layers. Some readers drop entities on undeclared layers.
  out += g(0, 'SECTION') + g(2, 'TABLES');
  out += g(0, 'TABLE') + g(2, 'LAYER') + g(70, 2);
  for (const [name, colour] of [[LAYER_GEOMETRY, 7], [LAYER_CONSTRUCTION, 8]]) {
    out += g(0, 'LAYER') + g(2, name) + g(70, 0) + g(62, colour) + g(6, 'CONTINUOUS');
  }
  out += g(0, 'ENDTAB') + g(0, 'ENDSEC');

  out += g(0, 'SECTION') + g(2, 'ENTITIES');
  const layerOf = (e) => (e.construction ? LAYER_CONSTRUCTION : LAYER_GEOMETRY);
  const skip = (e) => e.construction && !includeConstruction;

  for (const e of ents) {
    if (skip(e)) continue;
    if (e.type === 'line') {
      const a = P(e.p1);
      const b = P(e.p2);
      if (!a || !b) continue;
      out += g(0, 'LINE') + g(8, layerOf(e))
        + g(10, num(a.x)) + g(20, num(a.y)) + g(30, '0')
        + g(11, num(b.x)) + g(21, num(b.y)) + g(31, '0');
    } else if (e.type === 'circle') {
      const c = P(e.center);
      if (!c) continue;
      out += g(0, 'CIRCLE') + g(8, layerOf(e))
        + g(10, num(c.x)) + g(20, num(c.y)) + g(30, '0') + g(40, num(e.r));
    } else if (e.type === 'arc') {
      const c = P(e.center);
      const s = P(e.start);
      const en = P(e.end);
      if (!c || !s || !en) continue;
      // DXF arcs sweep counter-clockwise from start angle to end angle — the same
      // convention the sketcher (and planegcs) use, so the angles map straight
      // across with no reversal.
      out += g(0, 'ARC') + g(8, layerOf(e))
        + g(10, num(c.x)) + g(20, num(c.y)) + g(30, '0') + g(40, num(e.r))
        + g(50, num(normDeg(Math.atan2(s.y - c.y, s.x - c.x) * DEG)))
        + g(51, num(normDeg(Math.atan2(en.y - c.y, en.x - c.x) * DEG)));
    } else if (e.type === 'point' && includePoints) {
      out += g(0, 'POINT') + g(8, layerOf(e))
        + g(10, num(e.x)) + g(20, num(e.y)) + g(30, '0');
    }
  }
  out += g(0, 'ENDSEC') + g(0, 'EOF');
  return out;
}

/** Whether a sketch holds anything a DXF would show. */
export function sketchHasGeometry(sk) {
  if (!sk?.entities) return false;
  for (const e of sk.entities.values()) {
    if (e.type === 'line' || e.type === 'circle' || e.type === 'arc') return true;
  }
  return false;
}
