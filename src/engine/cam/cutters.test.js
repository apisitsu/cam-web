import { describe, it, expect } from 'vitest';
import {
  CUTTERS, cutterById, simTypeOf, clampFlutes, defaultFlutes,
  profileRise, cutterGeometry, cutterWarning, DEFAULT_CUTTER,
  defaultThickness, clampThickness, defaultShank, clampShank, cutFootprint,
} from './cutters.js';
import { millingSpeeds } from './feeds.js';

describe('the catalogue covers the tools a mill actually holds', () => {
  it('has the six types the shop asks for', () => {
    expect(CUTTERS.map((c) => c.id)).toEqual(
      ['endmill', 'shoulder', 'face', 'slot', 'ball', 'chamfer'],
    );
  });

  it.each(CUTTERS)('$id is described, not just named', ({ label, note }) => {
    expect(label.trim()).toBeTruthy();
    expect(note.split(/\s+/).length).toBeGreaterThanOrEqual(6);
  });

  it.each(CUTTERS)('$id has a flute count inside its own range', ({ flutes, fluteRange }) => {
    const [lo, hi] = fluteRange;
    expect(lo).toBeLessThanOrEqual(hi);
    expect(flutes).toBeGreaterThanOrEqual(lo);
    expect(flutes).toBeLessThanOrEqual(hi);
  });

  it('gives each type a distinct body proportion', () => {
    // A face mill is a disc and an endmill is a stick; drawing them the same
    // says nothing about whether the holder clears the fixture.
    const face = cutterById('face').bodyRatio;
    const endmill = cutterById('endmill').bodyRatio;
    expect(face).toBeLessThan(endmill);
  });

  it('falls back rather than throwing on an unknown id', () => {
    expect(cutterById('nope').id).toBe(DEFAULT_CUTTER);
    expect(cutterById(undefined).id).toBe(DEFAULT_CUTTER);
  });
});

describe('flute counts are clamped to what the type is made in', () => {
  it('keeps a sensible count untouched', () => {
    expect(clampFlutes('endmill', 3)).toBe(3);
    expect(clampFlutes('face', 8)).toBe(8);
  });

  it('refuses a 12-flute slot drill', () => {
    // Flutes multiply the feed directly, so a wrong count is a cycle time
    // quietly several times too fast with nothing on screen to contradict it.
    expect(clampFlutes('slot', 12)).toBe(3);
    expect(clampFlutes('slot', 0)).toBe(2);
  });

  it('falls back to the type default for a non-number', () => {
    expect(clampFlutes('ball', NaN)).toBe(defaultFlutes('ball'));
    expect(clampFlutes('ball', null)).toBe(2);
  });

  it('rounds a fractional count', () => {
    expect(clampFlutes('endmill', 3.4)).toBe(3);
  });
});

describe('flutes reach the feed rate — the reason the count matters', () => {
  const speeds = (flutes) => millingSpeeds({
    material: 'aluminium', diameter: 10, flutes,
  });

  it('a 6-flute cutter feeds three times a 2-flute one', () => {
    expect(speeds(6).feed / speeds(2).feed).toBeCloseTo(3, 5);
  });

  it('the catalogue defaults give visibly different feeds per type', () => {
    const slot = speeds(defaultFlutes('slot'));
    const face = speeds(defaultFlutes('face'));
    expect(face.feed).toBeGreaterThan(slot.feed * 2);
  });
});

describe('profileRise — what shape each cutter leaves', () => {
  it('a flat cutter is a plane at the tip', () => {
    const t = { radius: 5, type: 'flat' };
    expect(profileRise(t, 0)).toBe(0);
    expect(profileRise(t, 4.9)).toBe(0);
  });

  it('a ball nose is the sphere tangent to its tip', () => {
    const t = { radius: 5, type: 'ball' };
    expect(profileRise(t, 0)).toBeCloseTo(0);
    expect(profileRise(t, 5)).toBeCloseTo(5);          // the equator
    expect(profileRise(t, 3)).toBeCloseTo(5 - 4);      // 3-4-5
  });

  it('a 90° chamfer mill rises 1 mm per mm out — a 45° flank', () => {
    const t = { radius: 5, type: 'cone', angle: 90 };
    expect(profileRise(t, 2)).toBeCloseTo(2);
    expect(profileRise(t, 5)).toBeCloseTo(5);
  });

  it('a sharper included angle gives a steeper flank', () => {
    const at = (angle) => profileRise({ radius: 5, type: 'cone', angle }, 2);
    expect(at(60)).toBeCloseTo(2 * Math.sqrt(3));
    expect(at(60)).toBeGreaterThan(at(90));
    expect(at(120)).toBeLessThan(at(90));
  });

  it('is symmetric and clamped at the cutter radius', () => {
    const t = { radius: 5, type: 'ball' };
    expect(profileRise(t, -3)).toBeCloseTo(profileRise(t, 3));
    expect(profileRise(t, 99)).toBeCloseTo(profileRise(t, 5));
  });

  it('never divides by zero on a degenerate cone', () => {
    for (const angle of [0, 180, 360, NaN, undefined]) {
      const v = profileRise({ radius: 5, type: 'cone', angle }, 2);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('survives a zero-radius tool', () => {
    expect(Number.isFinite(profileRise({ radius: 0, type: 'ball' }, 0))).toBe(true);
  });
});

describe('cutterGeometry — what the carver is handed', () => {
  it('halves the diameter and carries the profile', () => {
    expect(cutterGeometry({ cutter: 'ball', diameter: 8 }))
      .toEqual({ radius: 4, type: 'ball' });
  });

  it('carries the angle only for a cone', () => {
    expect(cutterGeometry({ cutter: 'chamfer', diameter: 10 }).angle).toBe(90);
    expect(cutterGeometry({ cutter: 'chamfer', diameter: 10, angle: 60 }).angle).toBe(60);
    expect(cutterGeometry({ cutter: 'endmill', diameter: 10 }).angle).toBeUndefined();
  });

  it('hands on a STATED cutting-body length, and only that', () => {
    // Only the voxel carver can use it — a height-field column has nothing
    // below its own top — and only a measurement should cap a cut. The implied
    // thickness is a drawing default; silently capping every cut at 3x the
    // diameter is not something a guess has earned.
    expect(cutterGeometry({ cutter: 'slot', diameter: 12, thickness: 8 }))
      .toEqual({ radius: 6, type: 'flat', thickness: 8 });
    expect(cutterGeometry({ cutter: 'slot', diameter: 12 }).thickness).toBeUndefined();
    expect(cutterGeometry({ cutter: 'endmill', diameter: 6, thickness: 8 }).thickness)
      .toBeUndefined();
  });
});

describe('cutFootprint — the shape under the tool', () => {
  it('cares only how far out the cell is, not which way', () => {
    // Every cutter is a solid of revolution about the spindle axis.
    for (const type of ['flat', 'ball', 'cone']) {
      const tool = { radius: 5, type, angle: 90 };
      expect(cutFootprint(tool, 3, 0)).toBeCloseTo(cutFootprint(tool, 0, 3), 9);
    }
  });

  it('is the tool radius that bounds it', () => {
    expect(cutFootprint({ radius: 5, type: 'flat' }, 4.9, 0)).toBe(0);
    expect(cutFootprint({ radius: 5, type: 'flat' }, 5.1, 0)).toBeNull();
    expect(cutFootprint({ radius: 5, type: 'flat' }, 4, 4)).toBeNull();   // 5.66 out
  });

  it('agrees with profileRise on the shape it leaves', () => {
    // It is the same surface — the carvers just hand it two offsets, because
    // that is what a cell's position naturally is.
    const ball = { radius: 5, type: 'ball' };
    expect(cutFootprint(ball, 3, 0)).toBeCloseTo(profileRise(ball, 3), 9);
    expect(cutFootprint(ball, 3, 4)).toBeCloseTo(profileRise(ball, 5), 9);
  });

  it('is symmetric in both offsets', () => {
    const ball = { radius: 10, type: 'ball' };
    expect(cutFootprint(ball, -6, 1)).toBeCloseTo(cutFootprint(ball, 6, -1), 9);
  });
});

describe('simTypeOf — the flat/ball the older code speaks', () => {
  it('maps the square-ended types to flat', () => {
    for (const id of ['endmill', 'shoulder', 'face', 'slot']) {
      expect(simTypeOf(id)).toBe('flat');
    }
  });

  it('maps a cone to ball, not flat', () => {
    // Wrong either way, but rounded-bottom is the safer lie than a sharp
    // corner where the part has a chamfer.
    expect(simTypeOf('chamfer')).toBe('ball');
    expect(simTypeOf('ball')).toBe('ball');
  });
});

describe('cutterWarning advises, never blocks', () => {
  it('says when a diameter is not made in that type', () => {
    expect(cutterWarning({ cutter: 'face', diameter: 8 })).toMatch(/not usually made below/);
  });

  it('is silent for an ordinary combination', () => {
    expect(cutterWarning({ cutter: 'face', diameter: 50 })).toBeNull();
    expect(cutterWarning({ cutter: 'endmill', diameter: 2 })).toBeNull();
  });
});

describe('the cutting body\'s thickness', () => {
  it('follows the diameter through bodyRatio when nothing is stated', () => {
    expect(defaultThickness('slot', 10)).toBe(30);        // ratio 3
    expect(defaultThickness('face', 50)).toBe(17.5);      // a shallow disc
  });

  it('is never zero, whatever the diameter', () => {
    // A cutting body of no length is not a thin tool, it is an invisible one.
    expect(defaultThickness('face', 0)).toBeGreaterThan(0);
    expect(defaultThickness('slot', -5)).toBeGreaterThan(0);
    expect(defaultThickness('nope', 6)).toBeGreaterThan(0);
  });

  it('offers a shank diameter alongside it, on the same one type', () => {
    // A necked slot mill is wide where it cuts and narrow where the holder
    // grips it. Every other type's shank is its own diameter.
    const asks = CUTTERS.filter((c) => c.shankAdjustable).map((c) => c.id);
    expect(asks).toEqual(['slot']);
  });

  it('implies a shank just under the cutting diameter', () => {
    // Drawn a hair under so the flutes read as flutes and not as more shank.
    expect(defaultShank('slot', 20)).toBeLessThan(20);
    expect(defaultShank('slot', 20)).toBeGreaterThan(17);
    expect(defaultShank('endmill', 6)).toBeGreaterThan(0);
    expect(defaultShank('endmill', 0)).toBeGreaterThan(0);
  });

  it('clamps a shank to what the type is made in, and passes null through', () => {
    const [lo, hi] = cutterById('slot').shankRange;
    expect(clampShank('slot', 0)).toBe(lo);
    expect(clampShank('slot', 1e6)).toBe(hi);
    expect(clampShank('slot', 8)).toBe(8);
    expect(clampShank('slot', NaN)).toBeNull();
  });

  it('is offered only where the diameter cannot imply it', () => {
    // A slot cutter is bought as Ø x thickness; every other type's body follows
    // its diameter closely enough not to ask.
    const asks = CUTTERS.filter((c) => c.thicknessAdjustable).map((c) => c.id);
    expect(asks).toEqual(['slot']);
  });

  it('clamps to what the type is made in, and passes null through', () => {
    const [lo, hi] = cutterById('slot').thicknessRange;
    expect(clampThickness('slot', 0)).toBe(lo);
    expect(clampThickness('slot', 1000)).toBe(hi);
    expect(clampThickness('slot', 4)).toBe(4);
    expect(clampThickness('slot', NaN)).toBeNull();
  });
});
