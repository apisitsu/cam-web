/**
 * Does the cutter the operator picked actually reach the stock?
 *
 * `cutterShape.test.js` proves a cone-shaped tool leaves a cone. This asks the
 * question one level up, through the whole pipeline — G-code text in, carved
 * height field out — because that is where the answer used to be wrong.
 *
 * The complaint was that a chamfer simulated as no chamfer at all: the material
 * came out with a square-shouldered groove. The geometry was never the problem.
 * `gcode/tools.js` resolved an unrecognised tool comment to a confident
 * `'endmill'`, `effectiveTool` gives the program's comment precedence over the
 * fallback picker, and so the pick could never win on any program that declared
 * its tools — which is nearly all of them. Case B below is that bug.
 */
import { describe, it, expect } from 'vitest';
import { createSession, carveTo } from './session.js';

const CS = 0.25;

/**
 * One chamfer pass along Y at X0, tip at Z-2, with a Ø6 90° cutter. A cone
 * leaves flanks rising 1 mm per mm out; a flat endmill leaves a floor.
 */
const program = (toolLine) => `%
O1000 (CHAMFER)
G21 G17 G90 G54
${toolLine}
S6000 M3
G0 X0 Y-10 Z5
G1 Z-2 F200
G1 Y10 F400
G0 Z20
M30
`;

function grooveSlope(toolLine, opts) {
  const s = createSession(program(toolLine), { cellSize: CS, radius: 3, margin: 6, ...opts });
  carveTo(s, s.totalFeeds);
  const { stock } = s;
  const at = (x) => {
    const ix = Math.floor((x - stock.xMin) / stock.cellSize);
    const iy = Math.floor((0 - stock.yMin) / stock.cellSize);
    return stock.heights[iy * stock.nx + ix];
  };
  // Rise over 1 mm of the flank: 1.0 for a 90° cone, 0 for a flat floor.
  return { slope: at(1.5) - at(0.5), tool: s.tool({ tool: 1 }) };
}

/** What the fallback picker sends when the operator chooses Chamfer. */
const PICKED_CHAMFER = { cutter: 'chamfer', angle: 90 };

describe('the picked cutter reaches the carve', () => {
  it('carves a cone when the program declares no tools at all', () => {
    const { slope } = grooveSlope('(NO TOOL LINE)', PICKED_CHAMFER);
    expect(slope).toBeCloseTo(1, 1);
  });

  it('carves a cone when the program NAMES a chamfer mill', () => {
    const { slope } = grooveSlope('T1 M6 (CHAMFER D6 90DEG)', PICKED_CHAMFER);
    expect(slope).toBeCloseTo(1, 1);
  });

  it('carves a cone when the tool comment says nothing about the shape', () => {
    // THE BUG: `T1 M6 (ROUGH D6)` gives a size and no shape, and used to resolve
    // as an endmill — a square-shouldered groove where the part has a chamfer.
    const { slope, tool } = grooveSlope('T1 M6 (ROUGH D6)', PICKED_CHAMFER);
    expect(tool.type).toBe('cone');
    expect(slope).toBeCloseTo(1, 1);
  });

  it('carves a cone when the tool table forces one over a wrong comment', () => {
    const { slope } = grooveSlope('T1 M6 (ROUGH D6)', {
      ...PICKED_CHAMFER,
      toolOverrides: { 1: { cutter: 'chamfer', simType: 'ball', angle: 90 } },
    });
    expect(slope).toBeCloseTo(1, 1);
  });

  it('still carves FLAT when the program names an endmill', () => {
    // The comment outranks the picker whenever it actually says something —
    // otherwise a picker set once would quietly re-cut every tool in a program
    // that describes its tooling properly.
    const { slope, tool } = grooveSlope('T1 M6 (ENDMILL D6)', PICKED_CHAMFER);
    expect(tool.type).toBe('flat');
    expect(slope).toBeCloseTo(0, 5);
  });

  it('leaves a reamer on the plain flat/ball, not on the picked cone', () => {
    // A reamer is recognised and deliberately shapeless: it sizes a hole that is
    // already there. It must not borrow the picker's shape the way an
    // unrecognised comment does.
    const { tool } = grooveSlope('T1 M6 (REAMER D6)', PICKED_CHAMFER);
    expect(tool.type).toBe('flat');
    expect(tool.cutter).toBeUndefined();
  });

  it('honours an angle typed into the picker, not the catalogue default', () => {
    // A 60° cone is steeper: it rises 1/tan(30°) ≈ 1.73 mm per mm out.
    const { slope } = grooveSlope('T1 M6 (ROUGH D6)', { cutter: 'chamfer', angle: 60 });
    expect(slope).toBeGreaterThan(1.4);
  });
});
