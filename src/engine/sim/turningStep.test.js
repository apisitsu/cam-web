import { describe, it, expect } from 'vitest';
import { createTurningSession, carveTurningSessionTo } from './index.js';

/**
 * A single long roughing pass: face in, then one 60 mm `G1` down the bar.
 *
 * The whole complaint is about *this* shape of program. A turning pass is one
 * feed move covering the length of the part, so a simulator that counts whole
 * moves shows nothing at all while the insert travels and then drops the entire
 * cut in at the end — "หายไปทีละสเต็ป" rather than following the tool.
 */
const PROGRAM = [
  'G21 G18',
  'G0 X30. Z2.',
  'G1 X20. F0.2',   // feed 1: plunge to Ø40
  'G1 Z-60. F0.15', // feed 2: one long pass down the bar
  'G0 X30.',
  'M30',
].join('\n');

const session = () => createTurningSession(PROGRAM, {
  stockSize: { x: 60, z: 70 }, cellSize: 0.5,
});

/** The radius profile as a plain array, so two states can be compared. */
const profile = (s) => Array.from(s.stock.radius);
const cutCount = (p, r0) => p.filter((r) => r < r0 - 1e-9).length;

describe('turning carves under the insert, not a move at a time', () => {
  it('removes more as the pass progresses, not all at its end', () => {
    const s = session();
    const r0 = s.stock.rStock;

    carveTurningSessionTo(s, 1);          // the plunge only
    const atStart = cutCount(profile(s), r0);

    carveTurningSessionTo(s, 1.5);        // half way along the long pass
    const half = cutCount(profile(s), r0);

    carveTurningSessionTo(s, 2);          // pass complete
    const whole = cutCount(profile(s), r0);

    // The point: half way along, half the bar is cut. Counting whole moves gave
    // `half === atStart` — nothing until the move ended.
    expect(half).toBeGreaterThan(atStart);
    expect(whole).toBeGreaterThan(half);
  });

  it('moves in small increments, so playback looks continuous', () => {
    const s = session();
    const seen = [];
    for (let t = 1; t <= 2; t += 0.1) {
      carveTurningSessionTo(s, t);
      seen.push(cutCount(profile(s), s.stock.rStock));
    }
    // Strictly non-decreasing, and it grows in more than one jump.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(new Set(seen).size).toBeGreaterThan(3);
  });

  it('lands on the same part whether it was scrubbed or run straight through', () => {
    const straight = session();
    carveTurningSessionTo(straight, straight.totalFeeds);

    const scrubbed = session();
    for (let t = 0; t <= scrubbed.totalFeeds; t += 0.25) carveTurningSessionTo(scrubbed, t);
    carveTurningSessionTo(scrubbed, scrubbed.totalFeeds);

    expect(profile(scrubbed)).toEqual(profile(straight));
  });

  it('refills the bar when scrubbed backwards', () => {
    const s = session();
    carveTurningSessionTo(s, s.totalFeeds);
    const cut = cutCount(profile(s), s.stock.rStock);
    carveTurningSessionTo(s, 0);
    expect(cutCount(profile(s), s.stock.rStock)).toBe(0);
    carveTurningSessionTo(s, s.totalFeeds);
    expect(cutCount(profile(s), s.stock.rStock)).toBe(cut);
  });
});
