import { describe, it, expect } from 'vitest';
import {
  stockStated, originStated, autoSimKey, shouldAutoSimulate,
} from './autoSim.js';

const SETUP = {
  gcode: 'G21 G90\nG0 X0 Y0\nG1 Z-2 F200\nM30',
  stockEnabled: true,
  stockSize: { x: 100, y: 60, z: 20 },
  stockOrigin: { x: 0, y: 0, z: 0 },
  datum: { axesSet: [true, true, true], point: [0, 0, 0] },
};

describe('stockStated', () => {
  it('is a switch that is on AND a dimension that was typed', () => {
    expect(stockStated({ stockEnabled: true, stockSize: { x: 100 } })).toBe(true);
    expect(stockStated({ stockEnabled: true, stockSize: { z: 20 } })).toBe(true);
  });

  it('is not the switch on its own — the carver is still fitting the toolpath', () => {
    expect(stockStated({ stockEnabled: true, stockSize: { x: null, y: null, z: null } }))
      .toBe(false);
    expect(stockStated({ stockEnabled: true })).toBe(false);
  });

  it('is not a billet the operator switched off', () => {
    expect(stockStated({ stockEnabled: false, stockSize: { x: 100, y: 60, z: 20 } }))
      .toBe(false);
    expect(stockStated()).toBe(false);
  });

  it('is not a zero or a negative — those are a cleared field, not a size', () => {
    expect(stockStated({ stockEnabled: true, stockSize: { x: 0 } })).toBe(false);
    expect(stockStated({ stockEnabled: true, stockSize: { x: -5 } })).toBe(false);
  });
});

describe('originStated', () => {
  it('milling needs all three linear axes — a partly set datum is worse than none', () => {
    expect(originStated({ axesSet: [true, false, false] })).toBe(false);
    expect(originStated({ axesSet: [true, true, false] })).toBe(false);
    expect(originStated({ axesSet: [true, true, true] })).toBe(true);
  });

  it('turning needs only the one axis it measures along', () => {
    expect(originStated({ axesSet: [false, false, true] }, 'turn')).toBe(true);
    expect(originStated({ axesSet: [true, false, false] }, 'turn')).toBe(true);
  });

  it('is a datum point carried in from a saved project, whatever the mode', () => {
    expect(originStated({ axesSet: [false, false, false], point: [10, 5, 0] })).toBe(true);
    expect(originStated({ axesSet: [false, false, false], point: [10, 5, 0] }, 'turn')).toBe(true);
  });

  it('is nothing at all when nothing has been picked', () => {
    expect(originStated({ axesSet: [false, false, false], point: null })).toBe(false);
    expect(originStated({ axesSet: [true, true, true] }, 'turn')).toBe(true);
    expect(originStated({})).toBe(false);
    expect(originStated(null)).toBe(false);
  });
});

describe('autoSimKey — the setup that would be simulated', () => {
  it('is a string once there is a program, a billet and an origin', () => {
    expect(typeof autoSimKey(SETUP)).toBe('string');
  });

  it('is null with any one of the three missing', () => {
    expect(autoSimKey({ ...SETUP, gcode: '' })).toBeNull();
    expect(autoSimKey({ ...SETUP, gcode: '   \n  ' })).toBeNull();
    expect(autoSimKey({ ...SETUP, stockEnabled: false })).toBeNull();
    expect(autoSimKey({ ...SETUP, datum: { axesSet: [false, false, false] } })).toBeNull();
    expect(autoSimKey()).toBeNull();
  });

  it('holds until milling has all three linear axes, but turning needs only one', () => {
    expect(autoSimKey({ ...SETUP, datum: { axesSet: [true, true, false], point: [0, 0, 0] } })).toBeNull();
    expect(autoSimKey({ ...SETUP, mode: 'turn', datum: { axesSet: [false, false, true], point: [0, 0, 0] } }))
      .toEqual(expect.any(String));
  });

  it('changes when the stock changes', () => {
    expect(autoSimKey({ ...SETUP, stockSize: { x: 120, y: 60, z: 20 } }))
      .not.toBe(autoSimKey(SETUP));
  });

  it('changes when the origin moves', () => {
    expect(autoSimKey({ ...SETUP, stockOrigin: { x: -50, y: 0, z: 0 } }))
      .not.toBe(autoSimKey(SETUP));
    expect(autoSimKey({ ...SETUP, datum: { axesSet: [true, true, true], point: [1, 0, 0] } }))
      .not.toBe(autoSimKey(SETUP));
    // For turning, which axis was touched off is still part of the key: two
    // setups can share a point and mean different things about which axis owns it.
    expect(autoSimKey({ ...SETUP, mode: 'turn', datum: { axesSet: [true, false, false], point: [0, 0, 0] } }))
      .not.toBe(autoSimKey({ ...SETUP, mode: 'turn', datum: { axesSet: [false, false, true], point: [0, 0, 0] } }));
  });

  it('changes when the program does', () => {
    expect(autoSimKey({ ...SETUP, gcode: `${SETUP.gcode}\nG1 X50` }))
      .not.toBe(autoSimKey(SETUP));
  });

  it('changes when the rotary face being carved changes', () => {
    expect(autoSimKey({ ...SETUP, aIndex: 90 })).not.toBe(autoSimKey({ ...SETUP, aIndex: 0 }));
  });

  it('is stable for a setup that has not moved', () => {
    // The whole point: a view that re-derives this every render must get the
    // same string back, or it re-carves forever.
    expect(autoSimKey(SETUP)).toBe(autoSimKey({ ...SETUP }));
  });
});

describe('shouldAutoSimulate', () => {
  const key = autoSimKey(SETUP);

  it('runs when the setup is new', () => {
    expect(shouldAutoSimulate({ key, last: null })).toBe(true);
    expect(shouldAutoSimulate({ key, last: 'something else' })).toBe(true);
  });

  it('does not run the same setup twice', () => {
    expect(shouldAutoSimulate({ key, last: key })).toBe(false);
  });

  it('does not run with the setup incomplete', () => {
    expect(shouldAutoSimulate({ key: null, last: null })).toBe(false);
  });

  it('holds off while a program is playing', () => {
    // Re-carving mid-run would pull the block out from under the playhead.
    expect(shouldAutoSimulate({ key, last: null, playing: true })).toBe(false);
  });

  it('holds off while a run is already going', () => {
    expect(shouldAutoSimulate({ key, last: null, running: true })).toBe(false);
  });

  it('holds off on the sketch page, where there is no machine', () => {
    expect(shouldAutoSimulate({ key, last: null, sketching: true })).toBe(false);
  });
});
