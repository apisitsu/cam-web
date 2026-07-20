import { describe, it, expect } from 'vitest';
import { post } from './fanuc.js';
import { dialectFor, DIALECT_LIST, programHeader } from './dialect.js';
import { interpret } from '../../gcode/interpreter.js';
import { planJob } from '../plan.js';
import { weld } from '../../mesh/stl.js';
import { box, turnedShaft } from '../../mesh/fixtures.js';

const millSoup = box(60, 40, 15);
const turnSoup = turnedShaft({ r1: 15, z1: 25, r2: 8, z2: 45 });

/** Post the same milling job through a given control. */
function millNc(controller, opts = {}) {
  const p = planJob(millSoup, weld(millSoup), { material: 'aluminium' });
  return post(
    { name: 'plate', mode: 'mill', material: p.material, stock: p.stock, operations: p.operations, ...opts.program },
    { controller, ...opts },
  );
}

function turnNc(controller, opts = {}) {
  const p = planJob(turnSoup, weld(turnSoup), { material: 'mild-steel' });
  return post(
    { name: 'shaft', mode: 'turn', material: p.material, stock: p.stock, operations: p.operations },
    { controller, ...opts },
  );
}

describe('the control changes the program', () => {
  it('numbers a Haas program with five digits and a Fanuc one with four', () => {
    expect(millNc('fanuc', { programNumber: 7 })).toMatch(/^O0007 /m);
    expect(millNc('haas', { programNumber: 7 })).toMatch(/^O00007 /m);
  });

  it('omits the tape marks a Siemens control does not use', () => {
    expect(millNc('fanuc').startsWith('%')).toBe(true);
    expect(millNc('siemens').startsWith('%')).toBe(false);
  });

  it('comments with a semicolon on Siemens and parentheses elsewhere', () => {
    expect(millNc('siemens')).toMatch(/^; .*VERIFY BEFORE CUTTING$/m);
    expect(millNc('haas')).toMatch(/^\(.*VERIFY BEFORE CUTTING\)$/m);
  });

  it('comes home the way each control comes home', () => {
    expect(millNc('fanuc')).toContain('G91 G28 Z0.');
    expect(millNc('haas')).toContain('G53 Z0.');
    expect(millNc('haas')).not.toContain('G91 G28 Z0.');
  });

  it('ends an Okuma program with M02 and the others with M30', () => {
    expect(millNc('okuma').trim().endsWith('M02')).toBe(true);
    expect(millNc('fanuc')).toContain('M30');
  });

  it('drops tool changes, offsets and length comp for a single-tool router', () => {
    const nc = millNc('grbl');
    expect(nc).not.toMatch(/M06/);
    expect(nc).not.toMatch(/G43/);
    expect(nc).not.toMatch(/G54/);
    expect(nc).not.toMatch(/M08/);
    // ...and warns that the operator is changing tools by hand.
    expect(nc).toMatch(/SINGLE TOOL ASSUMED/);
  });

  it('prints the caveat where the output is only approximate', () => {
    expect(millNc('mazatrol-eia')).toMatch(/MUST NOT BE IN MAZATROL MODE/);
    expect(millNc('siemens')).toMatch(/NOT SHOPMILL/);
    // Fanuc is the native dialect, so it has nothing to apologise for.
    expect(millNc('fanuc')).not.toMatch(/CAVEAT/);
  });

  it('names the machine in the header when one is given', () => {
    const nc = millNc('haas', { program: { machineLabel: 'Haas · VF-2' } });
    expect(nc).toMatch(/\(MACHINE: HAAS · VF-2\)/);
  });

  it('spells the safe-start block in the control’s own words', () => {
    expect(millNc('fanuc')).toContain('G21 G17 G40 G49 G80 G90');
    expect(millNc('siemens')).toContain('G71 G17 G40 G90');
  });
});

describe('turning, per control', () => {
  it('keeps the G96/G50 pair on every control', () => {
    for (const d of DIALECT_LIST) {
      const nc = turnNc(d.id);
      expect(nc, d.id).toMatch(/G50 S\d+/);
      expect(nc, d.id).toMatch(/G96 S\d+ M03/);
    }
  });

  it('uses each control’s own return-to-home between tools', () => {
    expect(turnNc('fanuc')).toContain('G28 U0. W0.');
    expect(turnNc('haas')).toContain('G53 X0. Z0.');
  });
});

describe('every dialect still produces a readable program', () => {
  // The point of the whole CAM side: whatever we post, our own interpreter has
  // to be able to read the motion back out of it.
  for (const d of DIALECT_LIST) {
    it(`round-trips ${d.label} milling`, () => {
      const { segments } = interpret(millNc(d.id), { mode: 'mill' });
      expect(segments.length).toBeGreaterThan(20);
    });

    it(`round-trips ${d.label} turning`, () => {
      const { segments } = interpret(turnNc(d.id), { mode: 'turn', diameterMode: true });
      expect(segments.length).toBeGreaterThan(20);
    });
  }
});

describe('programHeader', () => {
  it('returns nothing for a control with no O-number', () => {
    expect(programHeader(dialectFor('siemens'), 1, 'part')).toBeNull();
    expect(programHeader(dialectFor('grbl'), 1, 'part')).toBeNull();
  });

  it('strips parentheses out of the part name', () => {
    expect(programHeader(dialectFor('fanuc'), 1, 'bracket (rev b)')).toBe('O0001 (BRACKET REV B)');
  });
});
