/**
 * A continuously rotating 4th axis must not cost memory per distinct angle.
 *
 * This is the *"Parse failed — Array buffer allocation failed"* a real program
 * produced. `feedPrefixAt` used to be one full-length `Uint32Array(n)` per
 * distinct rotary index, on the stated assumption that a program has four or six
 * of them. `A` is not normalised — a rotary engraving winds on past A360, A720,
 * A3600 — so nearly every block became its own index and the structure went
 * quadratic: 2,000 blocks cost 15 MB, 4,000 cost 61 MB, and a real 50,000-segment
 * program asked the browser for about 10 GB.
 *
 * The guard is a ratio, not a byte count: what matters is that the cost follows
 * the number of feed segments and NOT the number of angles, on a machine of any
 * speed.
 */
import { describe, it, expect } from 'vitest';
import { interpret } from './interpreter.js';
import { buildPath, feedsBeforeAt } from './path.js';

/** `n` cutting blocks, each advancing A by `da` degrees. */
function program(n, da) {
  const out = ['%', 'O9100 (ROTARY)', 'G21 G90 G54', 'T1 M6 (ENDMILL D6)', 'S3000 M3',
    'G0 X0 Y0 Z1', 'G1 Z-1 F200'];
  for (let i = 1; i <= n; i++) {
    out.push(`G1 X${(i % 40).toFixed(2)} A${(i * da).toFixed(3)} F600`);
  }
  out.push('G0 Z20', 'M30');
  return out.join('\n');
}

const pathFor = (n, da) => buildPath(interpret(program(n, da), {}).segments);

/** Total entries held across every index's array. */
const entries = (path) => [...path.feedPrefixAt.values()]
  .reduce((sum, arr) => sum + arr.length, 0);

describe('a continuously rotating A axis', () => {
  it('gives nearly every block its own index — the case that broke it', () => {
    const path = pathFor(600, 0.5);
    expect(path.feedPrefixAt.size).toBeGreaterThan(500);
  });

  it('stores one entry per FEED SEGMENT, not one array per angle', () => {
    const path = pathFor(600, 0.5);
    // The old shape was indices x count entries; this must stay at most count.
    expect(entries(path)).toBeLessThanOrEqual(path.count);
    expect(entries(path)).toBeGreaterThan(0);
  });

  it('does not grow super-linearly as the program gets longer', () => {
    const small = pathFor(400, 0.5);
    const big = pathFor(800, 0.5);
    // Twice the program, about twice the storage. The old structure was four
    // times, which is the whole bug.
    expect(entries(big) / entries(small)).toBeLessThan(2.6);
  });

  it('still counts the feeds at one index correctly', () => {
    // Four real orientations, revisited — the case the old code was written for.
    const path = pathFor(40, 90);
    for (const a of [...path.feedPrefixAt.keys()].slice(0, 4)) {
      const positions = path.feedPrefixAt.get(a);
      // Nothing before the first one, everything after the last.
      expect(feedsBeforeAt(path, positions[0], a)).toBe(0);
      expect(feedsBeforeAt(path, positions[0] + 1, a)).toBe(1);
      expect(feedsBeforeAt(path, path.count, a)).toBe(positions.length);
    }
  });

  it('is monotonic in k, and zero for an index the program never reaches', () => {
    const path = pathFor(60, 90);
    const a = [...path.feedPrefixAt.keys()][0];
    let last = 0;
    for (let k = 0; k <= path.count; k++) {
      const v = feedsBeforeAt(path, k, a);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
    expect(feedsBeforeAt(path, path.count, 12345)).toBe(0);
  });
});
