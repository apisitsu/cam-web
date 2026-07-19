import { describe, it, expect } from 'vitest';
import { fitBoundsFor, chuckFromBounds, TURN_RADIAL } from './setup.js';
import {
  playbackStep, perTick, wallClockSeconds, SPEEDS, PLAY_BASE_SECONDS, TICK_SECONDS,
} from './playback.js';

const turnBounds = {
  min: [0, 0, -40], max: [26, 0, 2],
  feedMin: [20, 0, -40], feedMax: [26, 0, 2],
};

describe('fitBoundsFor', () => {
  it('frames turning symmetric about the spindle', () => {
    const f = fitBoundsFor('turn', turnBounds);
    // Radius 26 → ±39 on both cross-axes, so the revolved part is centred.
    expect(f.min[0]).toBeCloseTo(-39, 6);
    expect(f.max[0]).toBeCloseTo(39, 6);
    expect(f.min[1]).toBeCloseTo(-39, 6);
    expect(f.max[1]).toBeCloseTo(39, 6);
  });

  it('pulls the turning box back toward the chuck end', () => {
    expect(fitBoundsFor('turn', turnBounds).min[2]).toBeCloseTo(-50, 6);
  });

  it('reads the radius off the radial axis, not whatever is at index 0', () => {
    // Guard against the axis mix-up that once collapsed the fit: if the radius
    // were taken from the (always zero) Y axis, the span would fall to the
    // ±1.5 floor instead of ±39.
    const f = fitBoundsFor('turn', turnBounds);
    expect(f.max[0]).toBeGreaterThan(10);
    expect(turnBounds.feedMax[TURN_RADIAL]).toBe(26);
  });

  it('leaves milling bounds alone', () => {
    const mill = { min: [-1, -2, -3], max: [4, 5, 6], feedMin: [0, 0, -3], feedMax: [4, 5, 0] };
    expect(fitBoundsFor('mill', mill)).toEqual({ min: [0, 0, -3], max: [4, 5, 0] });
  });

  it('falls back to the overall box when there are no feed moves', () => {
    const noFeeds = { min: [0, 0, -5], max: [3, 0, 0], feedMin: [Infinity, Infinity, Infinity], feedMax: [-Infinity, -Infinity, -Infinity] };
    const f = fitBoundsFor('mill', noFeeds);
    expect(f.min).toEqual([0, 0, -5]);
    expect(f.max).toEqual([3, 0, 0]);
  });

  it('returns null without bounds', () => {
    expect(fitBoundsFor('turn', null)).toBeNull();
  });
});

describe('chuckFromBounds', () => {
  it('grips the raw bar: cut radius plus half the oversize', () => {
    const c = chuckFromBounds('turn', turnBounds, 4);
    expect(c.od).toBeCloseTo(28, 6); // 26 + 4/2
    expect(c.z).toBeCloseTo(-40, 6); // the deepest cut
  });

  it('does not collapse when the radius is taken from the right axis', () => {
    // The bug this guards: reading feedMax[1] (always 0 on a lathe) gave od≈2 and
    // the chuck silently vanished from the scene.
    expect(chuckFromBounds('turn', turnBounds, 4).od).toBeGreaterThan(10);
  });

  it('has a floor so a degenerate program still shows a chuck', () => {
    const tiny = { feedMin: [0, 0, -1], feedMax: [0, 0, 0] };
    expect(chuckFromBounds('turn', tiny, 0).od).toBe(1);
  });

  it('is null for milling, and when nothing was cut', () => {
    expect(chuckFromBounds('mill', turnBounds, 4)).toBeNull();
    expect(chuckFromBounds('turn', null, 4)).toBeNull();
    expect(chuckFromBounds('turn', { feedMin: [Infinity, 0, 0], feedMax: [0, 0, 0] }, 4)).toBeNull();
  });
});

describe('playback pacing', () => {
  /** A fake path: `count` equal segments spanning `totalTime`. */
  const fakePath = (count, totalTime) => ({
    count,
    totalTime,
    segmentAt: (t) => Math.min(count, Math.max(0, Math.ceil((t / totalTime) * count))),
  });

  it('spans the whole program in the wall-clock budget at 1×', () => {
    const p = fakePath(100, 19.4);
    let t = 0;
    let ticks = 0;
    while (p.segmentAt(t) < p.count && ticks < 1e6) {
      t += perTick(p.totalTime, 1);
      ticks++;
    }
    const seconds = ticks * TICK_SECONDS;
    expect(seconds).toBeGreaterThan(PLAY_BASE_SECONDS * 0.95);
    expect(seconds).toBeLessThan(PLAY_BASE_SECONDS * 1.05);
  });

  it('is independent of how many segments the program has', () => {
    // The bug this guards: playback that advanced one segment per carve finished
    // a 9-segment program in 9 ticks, whatever the speed setting said.
    const run = (count) => {
      const p = fakePath(count, 19.4);
      let t = 0;
      let ticks = 0;
      while (p.segmentAt(t) < p.count && ticks < 1e6) {
        t += perTick(p.totalTime, 1);
        ticks++;
      }
      return ticks;
    };
    const few = run(9);
    const many = run(9000);
    // Both take essentially the whole budget; they differ only by where the last
    // segment boundary falls, which is a property of the path, not the pacing.
    expect(few / many).toBeGreaterThan(0.85);
    expect(few * TICK_SECONDS).toBeGreaterThan(PLAY_BASE_SECONDS * 0.8);
    expect(many * TICK_SECONDS).toBeGreaterThan(PLAY_BASE_SECONDS * 0.8);
  });

  it('each speed step divides the wall clock as its label says', () => {
    expect(wallClockSeconds(1)).toBe(PLAY_BASE_SECONDS);
    expect(wallClockSeconds(25)).toBeCloseTo(PLAY_BASE_SECONDS / 25, 9);
    expect(wallClockSeconds(50)).toBeCloseTo(wallClockSeconds(25) / 2, 9);
    expect(wallClockSeconds(100)).toBeCloseTo(wallClockSeconds(50) / 2, 9);
  });

  it('offers exactly the four %Rapid-style steps, slowest first', () => {
    expect(SPEEDS.map((s) => s.value)).toEqual([1, 25, 50, 100]);
    expect(SPEEDS[0].label).toBe('1×');
    expect(SPEEDS.at(-1).label).toBe('100%');
  });

  it('advances monotonically and reports the playhead', () => {
    const p = fakePath(10, 5);
    let state = { time: 0, playhead: 0 };
    for (let i = 0; i < 50; i++) {
      const next = playbackStep(state.time, p.totalTime, 100, p.segmentAt);
      expect(next.time).toBeGreaterThan(state.time);
      expect(next.playhead).toBeGreaterThanOrEqual(state.playhead);
      state = next;
    }
  });

  it('survives a zero-length program without dividing by zero', () => {
    expect(Number.isFinite(perTick(0, 1))).toBe(true);
    expect(perTick(0, 1)).toBeGreaterThan(0);
  });
});
