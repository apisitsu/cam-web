import { describe, it, expect } from 'vitest';
import {
  workRotates, rotaryFrameFor, workTransform, toolTilt, sweptFitBox, frameLabel,
} from './rotaryFrame.js';
import { interpret } from '../gcode/interpreter.js';
import { machineById } from '../cam/machines.js';

/** Apply a workTransform to a point the way the nested groups do. */
function place(t, [x, y, z]) {
  const [tx, ty, tz] = t.unpivot;
  let px = x + tx;
  let py = y + ty;
  let pz = z + tz;
  const [theta] = t.rotation;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const ry = py * c - pz * s;
  const rz = py * s + pz * c;
  py = ry; pz = rz;
  const [ox, oy, oz] = t.pivot;
  return [px + ox, py + oy, pz + oz];
}

describe('workRotates', () => {
  it('is true for a mill with an A axis', () => {
    expect(workRotates(machineById('generic-vmc-4axis'))).toBe(true);
    expect(workRotates(machineById('mazak-vcn530c-4th'))).toBe(true);
  });

  it('is false for a plain 3-axis mill', () => {
    expect(workRotates(machineById('haas-vf2'))).toBe(false);
    expect(workRotates(machineById('fanuc-generic-vmc'))).toBe(false);
  });

  it('is false for a 5-axis BC machine — nothing here indexes on B/C', () => {
    expect(workRotates(machineById('dmgmori-dmu50'))).toBe(false);
  });

  it("is false for a lathe, C axis or not — turning has no part frame to choose", () => {
    expect(workRotates(machineById('okuma-lb3000'))).toBe(false);
    expect(workRotates(machineById('fanuc-generic-lathe'))).toBe(false);
  });

  it('survives a missing or malformed machine', () => {
    expect(workRotates(null)).toBe(false);
    expect(workRotates({ kind: 'mill' })).toBe(false);
  });
});

describe('rotaryFrameFor', () => {
  it('picks the machine frame automatically for a 4-axis mill', () => {
    expect(rotaryFrameFor(machineById('generic-vmc-4axis'))).toBe('machine');
  });

  it('stays in the part frame for a 3-axis mill', () => {
    expect(rotaryFrameFor(machineById('haas-vf2'))).toBe('part');
  });

  it('an explicit pick beats the machine, in both directions', () => {
    expect(rotaryFrameFor(machineById('generic-vmc-4axis'), 'part')).toBe('part');
    expect(rotaryFrameFor(machineById('haas-vf2'), 'machine')).toBe('machine');
  });

  it("'auto' is the same as saying nothing", () => {
    expect(rotaryFrameFor(machineById('generic-vmc-4axis'), 'auto')).toBe('machine');
  });
});

describe('workTransform', () => {
  it('is identity in the part frame, whatever A is', () => {
    const t = workTransform('part', { a: 90, center: [3, 7] });
    expect(t.identity).toBe(true);
    expect(t.degrees).toBe(0);
    expect(place(t, [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('turns the work by +A about X in the machine frame', () => {
    const t = workTransform('machine', { a: 90 });
    const [x, y, z] = place(t, [5, 10, 0]);
    expect(x).toBeCloseTo(5);       // X is the rotary axis — untouched
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(10);
  });

  it('pivots on the picked rotary centre, not the part origin', () => {
    const t = workTransform('machine', { a: 180, center: [3, 7] });
    // A point sitting exactly on the physical A axis cannot move.
    const on = place(t, [12, 3, 7]);
    expect(on[0]).toBeCloseTo(12);
    expect(on[1]).toBeCloseTo(3);
    expect(on[2]).toBeCloseTo(7);
    // One 2 mm above it swings to 2 mm below.
    const off = place(t, [12, 3, 9]);
    expect(off[1]).toBeCloseTo(3);
    expect(off[2]).toBeCloseTo(5);
  });

  it('turns geometry only the remaining way when it is already at baseA', () => {
    // The height-field sim carves in the machine frame at one index, so its
    // stock arrives pre-rotated. At the index it was carved at, nothing moves.
    const t = workTransform('machine', { a: 90, baseA: 90 });
    expect(t.identity).toBe(true);
    expect(place(t, [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('undoes exactly what the interpreter did to reach the part frame', () => {
    // The one relationship that matters: part frame = Rx(-A) of the machine
    // frame, so drawing in the machine frame means Rx(+A) of the part frame.
    const program = 'G90 G0 A90.\nG1 X0 Y10 Z4 F100';
    const asPart = interpret(program, { rotaryFrame: 'part' });
    const asMachine = interpret(program, { rotaryFrame: 'machine' });
    const partPt = asPart.segments.at(-1).b;
    const machinePt = asMachine.segments.at(-1).b;
    expect(partPt).not.toEqual(machinePt);      // the program does index

    const back = place(workTransform('machine', { a: 90 }), partPt);
    back.forEach((n, i) => expect(n).toBeCloseTo(machinePt[i], 6));
  });

  it('undoes it about a picked centre too', () => {
    const program = 'G90 G0 A90.\nG1 X0 Y10 Z4 F100';
    const center = [3, 7];
    const asPart = interpret(program, { rotaryFrame: 'part', rotaryCenter: center });
    const asMachine = interpret(program, { rotaryFrame: 'machine' });
    const back = place(
      workTransform('machine', { a: 90, center }),
      asPart.segments.at(-1).b,
    );
    back.forEach((n, i) => expect(n).toBeCloseTo(asMachine.segments.at(-1).b[i], 6));
  });

  it('treats a missing A as no rotation', () => {
    expect(workTransform('machine').identity).toBe(true);
    expect(workTransform('machine', { a: 0 }).identity).toBe(true);
  });
});

describe('toolTilt', () => {
  it('tilts the tool to the face in the part frame', () => {
    const { a, b } = toolTilt('part', { a: 90, b: 0 });
    expect(a).toBeCloseTo(-Math.PI / 2);
    expect(b).toBe(-0);
  });

  it('never tilts the tool in the machine frame — a spindle does not swivel', () => {
    expect(toolTilt('machine', { a: 90, b: 45 })).toEqual({ a: 0, b: 0 });
  });

  it('carries B through in the part frame', () => {
    expect(toolTilt('part', { a: 0, b: 180 }).b).toBeCloseTo(-Math.PI);
  });

  it('is upright with no rotary reading at all', () => {
    expect(toolTilt('part', null)).toEqual({ a: 0, b: 0 });
  });
});

describe('sweptFitBox', () => {
  it('opens a machine-frame toolpath out to the circle it sweeps', () => {
    // The real shape of the problem: a four-face job cutting at the top of the
    // part spans nothing in Y and 20..30 in Z, but fills ±30 as the table turns.
    const swept = sweptFitBox({ min: [-20, 0, 20], max: [20, 0, 30] });
    expect(swept.min).toEqual([-20, -30, -30]);
    expect(swept.max).toEqual([20, 30, 30]);
  });

  it('leaves X alone — it is the axis of rotation', () => {
    const swept = sweptFitBox({ min: [-5, -1, -1], max: [100, 1, 1] });
    expect(swept.min[0]).toBe(-5);
    expect(swept.max[0]).toBe(100);
  });

  it('sweeps about the picked centre, not the origin', () => {
    // A box already centred on the A axis only opens to its own half-diagonal.
    const swept = sweptFitBox({ min: [0, 2, 6], max: [1, 4, 8] }, [3, 7]);
    const r = Math.hypot(1, 1);
    expect(swept.min[1]).toBeCloseTo(3 - r);
    expect(swept.max[2]).toBeCloseTo(7 + r);
  });

  it('never shrinks the box it was given', () => {
    const box = { min: [-1, -9, -4], max: [1, 9, 4] };
    const swept = sweptFitBox(box);
    expect(swept.min[1]).toBeLessThanOrEqual(box.min[1]);
    expect(swept.max[1]).toBeGreaterThanOrEqual(box.max[1]);
    expect(swept.min[2]).toBeLessThanOrEqual(box.min[2]);
    expect(swept.max[2]).toBeGreaterThanOrEqual(box.max[2]);
  });

  it('passes an absent or empty box straight through', () => {
    expect(sweptFitBox(null)).toBeNull();
    expect(sweptFitBox({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }))
      .toEqual({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  });
});

describe('frameLabel', () => {
  it('names what moves on screen, not the coordinate frame', () => {
    expect(frameLabel('machine')).toBe('Work rotates');
    expect(frameLabel('part')).toBe('Tool rotates');
  });
});
