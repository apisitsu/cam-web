import { describe, it, expect } from 'vitest';
import {
  MACHINES, machineById, machinesFor, machinesByBrand, machineForMode,
  DEFAULT_MILL_ID, DEFAULT_LATHE_ID, axisLabel, axisLetters, travelLabel,
} from './machines.js';
import { millingSpeeds, turningSpeeds, millingEngagement } from './feeds.js';
import { dialectFor, DIALECTS } from './post/dialect.js';

describe('the library itself', () => {
  it('gives every machine a unique id', () => {
    const ids = MACHINES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names every machine by make and model', () => {
    for (const m of MACHINES) {
      expect(m.label, m.id).toBe(`${m.brand} · ${m.model}`);
      expect(m.note.length, m.id).toBeGreaterThan(10);
    }
  });

  it('points every machine at a dialect that exists', () => {
    for (const m of MACHINES) {
      expect(DIALECTS[m.controller], `${m.id} -> ${m.controller}`).toBeTruthy();
    }
  });

  it('gives every machine a usable envelope', () => {
    for (const m of MACHINES) {
      expect(m.maxRpm, m.id).toBeGreaterThan(m.minRpm);
      expect(m.maxFeed, m.id).toBeGreaterThan(0);
      expect(m.rapidRate, m.id).toBeGreaterThanOrEqual(m.maxFeed);
      if (m.kind === 'turn') expect(m.maxTurnRpm, m.id).toBeGreaterThan(0);
    }
  });

  it('knows the stroke of every axis of every machine', () => {
    // The gap this closes: lathes carried no travel at all, so "will it fit"
    // could only ever be answered for mills.
    for (const m of MACHINES) {
      expect(m.travel, m.id).toBeTruthy();
      for (const axis of m.linear) {
        expect(m.travel[axis], `${m.id} ${axis}`).toBeGreaterThan(0);
      }
      // ...and carries no stroke for an axis it does not have.
      const extra = Object.keys(m.travel).filter((a) => !m.linear.includes(a));
      expect(extra, m.id).toEqual([]);
    }
  });

  it('knows how many axes every machine has, and which letters', () => {
    for (const m of MACHINES) {
      expect(m.axisCount, m.id).toBe(m.linear.length + m.rotary.length);
      expect(m.linear.length, m.id).toBeGreaterThanOrEqual(2);
      expect(axisLetters(m), m.id).toEqual([...m.linear, ...m.rotary]);
    }
  });

  it('gives a mill XYZ and a plain lathe XZ', () => {
    expect(machineById('haas-vf2').linear).toEqual(['X', 'Y', 'Z']);
    expect(machineById('haas-vf2').axisCount).toBe(3);
    expect(machineById('haas-st20').linear).toEqual(['X', 'Z']);
    expect(machineById('haas-st20').axisCount).toBe(2);
  });

  it('counts the rotary axes on the machines that have them', () => {
    const dmu = machineById('dmgmori-dmu50');
    expect(dmu.axisCount).toBe(5);
    expect(dmu.rotary).toEqual(['B', 'C']);
    expect(machineById('generic-vmc-4axis').rotary).toEqual(['A']);
    // A Swiss lathe has a Y and a C — it is not a 2-axis machine.
    const swiss = machineById('citizen-l20');
    expect(swiss.linear).toContain('Y');
    expect(swiss.axisCount).toBe(4);
    // Driven tools on a turret lathe: C, but still no Y.
    expect(machineById('okuma-lb3000').rotary).toEqual(['C']);
    expect(machineById('okuma-lb3000').linear).not.toContain('Y');
  });

  it('describes axes and stroke in one line each, for the UI', () => {
    expect(axisLabel(machineById('haas-vf2'))).toBe('3-axis (XYZ)');
    expect(axisLabel(machineById('dmgmori-dmu50'))).toBe('5-axis (XYZ+BC)');
    expect(axisLabel(machineById('haas-st20'))).toBe('2-axis (XZ)');
    expect(travelLabel(machineById('haas-vf2'))).toBe('762 × 406 × 508 mm');
    // A lathe's line has two numbers, not three padded with a lie.
    expect(travelLabel(machineById('haas-st20'))).toBe('209 × 559 mm');
  });

  it('keeps the Mazak 530C pair apart — Nexus and Smart are different machines', () => {
    // Regression: these were first entered as one machine, with the VCN's Y
    // stroke on an entry labelled VCS. Same number in the model name, 20 mm
    // different in Y, different control generation.
    const vcs = machineById('mazak-vcs530c');
    const vcn = machineById('mazak-vcn530c');
    expect(vcs.model).toBe('VCS-530C');
    expect(vcn.model).toBe('VCN-530C');
    expect(vcs.travel).toEqual({ X: 1050, Y: 510, Z: 510 });
    expect(vcn.travel).toEqual({ X: 1050, Y: 530, Z: 510 });
    expect(vcn.travel.Y).toBeGreaterThan(vcs.travel.Y);
    // Both are long-table machines: X takes a part no VCN-410A can hold.
    for (const m of [vcs, vcn]) {
      expect(m.travel.X).toBeGreaterThan(machineById('mazak-vcn410').travel.X);
    }
  });

  it('has the VCN-530C with a rotary table as its own entry', () => {
    // A real configuration — these are sold with a Kitagawa or Nikken rotary
    // bolted on — so it is a machine you can pick, not a checkbox.
    const m = machineById('mazak-vcn530c-4th');
    expect(m.axisCount).toBe(4);
    expect(m.rotary).toEqual(['A']);
    expect(m.linear).toEqual(['X', 'Y', 'Z']);
    // The rotary is not a linear axis and must not appear in the stroke line.
    expect(travelLabel(m)).toBe('1050 × 530 × 510 mm');
    expect(axisLabel(m)).toBe('4-axis (XYZ+A)');
  });

  it('has both processes covered, with a generic default in each', () => {
    expect(machinesFor('mill').length).toBeGreaterThan(2);
    expect(machinesFor('turn').length).toBeGreaterThan(2);
    expect(machineById(DEFAULT_MILL_ID).kind).toBe('mill');
    expect(machineById(DEFAULT_LATHE_ID).kind).toBe('turn');
  });

  it('falls back rather than throwing on an unknown id', () => {
    expect(machineById('no-such-machine').id).toBe(DEFAULT_MILL_ID);
  });
});

describe('machinesByBrand', () => {
  it('groups models under their make, for a grouped select', () => {
    const groups = machinesByBrand('mill');
    const haas = groups.find((g) => g.brand === 'Haas');
    expect(haas.machines.map((m) => m.model)).toContain('VF-2');
    expect(groups.flatMap((g) => g.machines)).toHaveLength(machinesFor('mill').length);
  });
});

describe('machineForMode', () => {
  it('leaves a machine alone when it already does that process', () => {
    expect(machineForMode('mill', 'brother-s700').id).toBe('brother-s700');
  });

  it('prefers the same make when the process changes', () => {
    // A shop with a Haas mill most likely has the Haas lathe.
    expect(machineForMode('turn', 'haas-vf2').brand).toBe('Haas');
  });

  it('falls back to generic when the make has no such machine', () => {
    expect(machineForMode('turn', 'brother-s700').id).toBe(DEFAULT_LATHE_ID);
  });
});

describe('the machine actually changes the cutting data', () => {
  it('spins a Ø6 cutter faster on a high-speed spindle than on a knee mill', () => {
    const args = { material: 'aluminium', diameter: 6, flutes: 4 };
    const knee = millingSpeeds({ ...args, machine: machineById('knee-mill-cnc') });
    const speedio = millingSpeeds({ ...args, machine: machineById('brother-s700') });
    expect(knee.rpm).toBe(4000);
    expect(speedio.rpm).toBeGreaterThan(knee.rpm);
    expect(knee.limitedBy).toBe('maxRpm');
  });

  it('clamps a Swiss lathe higher than a toolroom lathe', () => {
    const args = { material: 'brass', diameter: 8 };
    const swiss = turningSpeeds({ ...args, machine: machineById('citizen-l20') });
    const toolroom = turningSpeeds({ ...args, machine: machineById('toolroom-lathe') });
    expect(swiss.clampRpm).toBeGreaterThan(toolroom.clampRpm);
  });
});

describe('dialectFor', () => {
  it('maps a machine to its control', () => {
    expect(dialectFor(machineById('haas-vf2').controller).id).toBe('haas');
    expect(dialectFor(machineById('dmgmori-dmu50').controller).id).toBe('siemens');
  });

  it('falls back to Fanuc rather than throwing', () => {
    expect(dialectFor('not-a-control').id).toBe('fanuc');
  });
});

describe('rigidity is not decoration', () => {
  it('takes a lighter depth of cut on a router than on a VMC', () => {
    // Same cutter, same material — 1×D in aluminium is routine on a 40-taper
    // machine and will chatter a hobby router into the floor.
    const args = { material: 'aluminium', diameter: 6 };
    const vmc = millingEngagement({ ...args, machine: machineById('haas-vf2') });
    const router = millingEngagement({ ...args, machine: machineById('router-grbl') });
    expect(router.ap).toBeLessThan(vmc.ap);
    // Stepover is untouched: it is the depth that loads the frame.
    expect(router.ae).toBe(vmc.ae);
  });

  it('leaves the default machine at full book values', () => {
    const full = millingEngagement({ material: 'aluminium', diameter: 10 });
    expect(full.ap).toBeCloseTo(10, 3);
  });
});
