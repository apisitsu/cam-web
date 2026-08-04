import { describe, it, expect } from 'vitest';
import { effectiveTool } from './effectiveTool.js';

const fallback = { radius: 3, cutter: 'endmill', type: 'flat' };

describe('effectiveTool — the cutter that is really in the spindle', () => {
  it('draws the cutter the program named, not the fallback', () => {
    // The bug this whole module exists for: a program with tools ignored the
    // type entirely, so a Ø50 face mill was drawn as a Ø50 endmill stick.
    const t = effectiveTool({
      detected: { n: 1, type: 'facemill', simType: 'flat', cutter: 'face', diameter: 50, radius: 25 },
      fallback,
    });
    expect(t.cutter).toBe('face');
    expect(t.radius).toBe(25);
  });

  it('lets the operator override the program', () => {
    const t = effectiveTool({
      detected: { cutter: 'endmill', simType: 'flat', diameter: 10, radius: 5 },
      override: { cutter: 'ball' },
      fallback,
    });
    expect(t.cutter).toBe('ball');
    expect(t.type).toBe('ball');
    expect(t.radius).toBe(5);     // the override said nothing about the size
  });

  it('carries the chamfer angle so the cone is the one that was picked', () => {
    const sharp = effectiveTool({ override: { cutter: 'chamfer', angle: 60, diameter: 10 } });
    expect(sharp.type).toBe('cone');
    expect(sharp.angle).toBe(60);
    // The type's own angle stands in when the tool table has not been given one.
    expect(effectiveTool({ override: { cutter: 'chamfer', diameter: 10 } }).angle).toBe(90);
  });

  it('never puts an angle on a cutter that has no cone', () => {
    expect(effectiveTool({ override: { cutter: 'face', diameter: 50, angle: 60 } }).angle)
      .toBeUndefined();
  });

  it('keeps a drill on the plain flat/ball — none of the six shapes is a drill', () => {
    const t = effectiveTool({
      detected: { type: 'drill', simType: 'flat', cutter: null, diameter: 9, radius: 4.5 },
      fallback: { radius: 3, cutter: 'face', type: 'flat' },
    });
    expect(t.cutter).toBeUndefined();   // NOT the fallback's face mill
    expect(t.type).toBe('flat');
    expect(t.radius).toBe(4.5);
  });

  it('falls back only when nothing at all is known about the tool', () => {
    // This is exactly when `toolResolver` hands the move to the fallback, so
    // the marker has to agree — otherwise the cut is made by a tool that is
    // not on screen.
    expect(effectiveTool({ detected: null, fallback })).toMatchObject(fallback);
    // A tool that only ever appeared as a bare `T5` is listed by the
    // interpreter with a stamped-on simType of 'flat' and nothing else. That is
    // not knowledge about the tool, and it must not stop the fallback.
    expect(effectiveTool({ detected: { n: 5, type: 'unknown', simType: 'flat' }, fallback }))
      .toMatchObject({ radius: 3, cutter: 'endmill' });
  });

  it('keeps a known shape at the fallback size, rather than losing both', () => {
    // A comment that names the cutter but not its diameter: the size has to
    // come from somewhere, and it is the only thing missing.
    const t = effectiveTool({
      detected: { type: 'ballmill', simType: 'ball', cutter: 'ball', radius: null },
      fallback,
    });
    expect(t).toMatchObject({ cutter: 'ball', type: 'ball', radius: 3 });
  });

  it('keeps a picked cutter even when the size is unknown', () => {
    const t = effectiveTool({
      detected: { n: 5, type: 'unknown', radius: null },
      override: { cutter: 'face' },
      fallback,
    });
    expect(t.cutter).toBe('face');
    expect(t.radius).toBe(3);          // the fallback's size, for want of any other
  });

  it('honours the old Flat/Ball override a saved project carries', () => {
    // Ball was an explicit pick and still wins...
    expect(effectiveTool({
      detected: { cutter: 'face', simType: 'flat', radius: 25 },
      override: { simType: 'ball' },
    })).toMatchObject({ cutter: 'ball', type: 'ball' });
    // ...but "flat" was the default half of a two-way switch, and says nothing
    // the detected face mill does not say better.
    expect(effectiveTool({
      detected: { cutter: 'face', simType: 'flat', radius: 25 },
      override: { simType: 'flat' },
    }).cutter).toBe('face');
  });

  it('reports the gauge length, overridden over detected', () => {
    expect(effectiveTool({ detected: { radius: 5, length: 48 } }).length).toBe(48);
    expect(effectiveTool({ detected: { radius: 5, length: 48 }, override: { length: 60 } }).length)
      .toBe(60);
    expect(effectiveTool({ detected: { radius: 5 } }).length).toBe(0);
  });
});

describe('effectiveTool — the cutting body\'s thickness', () => {
  it('reports it only when the operator has measured one', () => {
    // Absent means "no measurement": the marker falls back to what the type
    // implies and the carvers leave the cut alone. A drawing default must not
    // arrive at the simulator looking like a depth limit.
    expect(effectiveTool({ override: { cutter: 'slot', diameter: 10 } }).thickness)
      .toBeUndefined();
    expect(effectiveTool({ override: { cutter: 'slot', diameter: 10, thickness: 8 } }).thickness)
      .toBe(8);
  });

  it('lets a stated thickness win — it is the tool the operator has', () => {
    const t = effectiveTool({
      detected: { cutter: 'slot', simType: 'flat', diameter: 12, radius: 6 },
      override: { thickness: 8 },
    });
    expect(t.thickness).toBe(8);
    expect(t.radius).toBe(6);         // and nothing else moved
  });

  it('keeps a stated thickness on a tool the program named', () => {
    expect(effectiveTool({
      detected: { cutter: 'endmill', simType: 'flat', diameter: 20, radius: 10 },
      override: { cutter: 'slot', thickness: 6 },
    })).toMatchObject({ cutter: 'slot', radius: 10, thickness: 6 });
  });

  it('says nothing about thickness for a tool with no cutter shape', () => {
    // A drill has no cutting-body thickness to offer, so the field is not shown
    // and `undefined` is the honest answer.
    expect(effectiveTool({ detected: { type: 'drill', cutter: null, radius: 4.5 } }).thickness)
      .toBeUndefined();
  });
});

describe('effectiveTool — the shank diameter', () => {
  it('reports it only when the operator has measured one', () => {
    expect(effectiveTool({ override: { cutter: 'slot', diameter: 20 } }).shank)
      .toBeUndefined();
    expect(effectiveTool({ override: { cutter: 'slot', diameter: 20, shank: 10 } }).shank)
      .toBe(10);
  });

  it('is independent of the cutting diameter and of the thickness', () => {
    const t = effectiveTool({
      detected: { cutter: 'endmill', simType: 'flat', diameter: 20, radius: 10 },
      override: { cutter: 'slot', shank: 6, thickness: 4 },
    });
    expect(t).toMatchObject({ cutter: 'slot', radius: 10, shank: 6, thickness: 4 });
  });
});

describe('effectiveTool — the fallback fills in what nobody else measured', () => {
  const named = { cutter: 'slot', simType: 'flat', diameter: 20, radius: 10 };

  it('gives a program-named tool the cutting body typed on the picker', () => {
    // A comment can name the cutter and give its diameter; there is no comment
    // syntax for a cutting-body length. If the operator typed one anywhere and
    // this tool has none of its own, that is the only measurement there is.
    expect(effectiveTool({ detected: named, fallback: { thickness: 3 } }).thickness).toBe(3);
    expect(effectiveTool({ detected: named, fallback: { shank: 8 } }).shank).toBe(8);
  });

  it('still lets the tool\'s own row win over it', () => {
    expect(effectiveTool({
      detected: named,
      override: { thickness: 5, shank: 6 },
      fallback: { thickness: 3, shank: 8 },
    })).toMatchObject({ thickness: 5, shank: 6 });
  });

  it('does NOT let the fallback overrule the type or the size', () => {
    // The difference that makes filling in defensible: here the program did
    // say, and overruling it would be overruling the program.
    const t = effectiveTool({
      detected: named,
      fallback: { radius: 3, cutter: 'face', type: 'flat', thickness: 3 },
    });
    expect(t).toMatchObject({ cutter: 'slot', radius: 10, thickness: 3 });
  });

  it('leaves a tool alone when nothing anywhere states one', () => {
    expect(effectiveTool({ detected: named, fallback: { radius: 3 } }).thickness)
      .toBeUndefined();
  });
});
