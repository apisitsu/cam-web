import { describe, it, expect } from 'vitest';
import { cadFormatOf, readCad } from './cadImport.js';
import { meshToStep } from './step.js';
import { box, tube } from './fixtures.js';
import { weld } from './stl.js';
import { detectFormat, PART_ACCEPT } from './import.js';
import { volume, isClosed } from '../solid/solidAssert.js';
import { loadOcct } from '../../lib/occtLoader.js';

const bytes = (text) => new TextEncoder().encode(text);

describe('STEP / IGES import', () => {
  it('knows a STEP file by its header and IGES by its name', () => {
    expect(cadFormatOf(bytes('ISO-10303-21;\nHEADER;'), 'part.txt')).toBe('step');
    expect(cadFormatOf(bytes('anything'), 'PART.IGS')).toBe('iges');
    expect(cadFormatOf(bytes('solid x'), 'part.stl')).toBe(null);
    expect(PART_ACCEPT).toContain('.step');
    expect(detectFormat(bytes('solid x\nfacet normal 0 0 1'), 'p.stl')).toBe('stl');
  });

  it('reads back what it writes: a block, and a tube with its round walls', async () => {
    const occt = await loadOcct();
    const block = readCad(occt, bytes(meshToStep(weld(box(30, 20, 10)))), 'step');
    expect(isClosed(block)).toBe(true);
    expect(volume(block)).toBeCloseTo(6000, 1);
    // Written as true cylinders, read back as fine facets of them.
    const t = readCad(occt, bytes(meshToStep(weld(tube(20, 10, 30, 64)))), 'step');
    const exact = Math.PI * (20 * 20 - 10 * 10) * 30;
    expect(Math.abs(volume(t) - exact) / exact).toBeLessThan(0.002);
  }, 60000);

  it('says so when the file is not one it can read', async () => {
    const occt = await loadOcct();
    expect(() => readCad(occt, bytes('ISO-10303-21;\nnot really'), 'step')).toThrow(/could not be read|no solid/);
  }, 60000);
});
