import { describe, it, expect } from 'vitest';
import { viewKey, keyIs, typing } from './viewKeys.js';

const k = (code, mods = {}) => ({ code, key: '', ...mods });

describe('SolidWorks view keys', () => {
  it('puts the standard views on Ctrl+1…7', () => {
    expect(viewKey(k('Digit1', { ctrlKey: true }))).toEqual({ type: 'view', view: 'front' });
    expect(viewKey(k('Digit5', { ctrlKey: true }))).toEqual({ type: 'view', view: 'top' });
    expect(viewKey(k('Digit7', { metaKey: true }))).toEqual({ type: 'view', view: 'iso' });
    expect(viewKey(k('Digit1'))).toBeNull();
  });

  it('rotates 15° on the arrows, 90° with Shift, and pans with Ctrl', () => {
    expect(viewKey(k('ArrowRight')).left).toBeCloseTo(Math.PI / 12);
    expect(viewKey(k('ArrowUp', { shiftKey: true })).up).toBeCloseTo(-Math.PI / 2);
    expect(viewKey(k('ArrowLeft', { ctrlKey: true }))).toMatchObject({ type: 'pan', x: -40, y: 0 });
  });

  it('fits on F and zooms on Z, by key position so the Thai layout works', () => {
    expect(viewKey({ code: 'KeyF', key: 'ด' })).toEqual({ type: 'fit' });
    expect(viewKey(k('KeyZ')).factor).toBeLessThan(1);
    expect(viewKey(k('KeyZ', { shiftKey: true })).factor).toBeGreaterThan(1);
    expect(viewKey(k('KeyZ', { ctrlKey: true }))).toBeNull();
    expect(keyIs({ code: 'KeyS', key: 'ห' }, 's')).toBe(true);
  });

  it('leaves keys typed into a field alone', () => {
    expect(typing({ target: { tagName: 'INPUT' } })).toBe(true);
    expect(typing({ target: { tagName: 'CANVAS' } })).toBe(false);
  });
});
