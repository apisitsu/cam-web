import { describe, it, expect } from 'vitest';
import {
  buildPath, feedsBefore, feedsBeforeAt, timeAt, segmentAtTime, sliceUpTo,
  rotaryAt, toolAt, lineAt,
} from './path.js';

/** A minimal segment, in the shape `interpret()` produces. */
function seg(type, opts = {}) {
  return {
    type,
    a: opts.a ?? [0, 0, 0],
    b: opts.b ?? [1, 0, 0],
    t: opts.t ?? 1,
    a4: opts.a4 ?? 0,
    b4: opts.b4 ?? 0,
    line: opts.line ?? 0,
    tool: opts.tool ?? 0,
  };
}

describe('buildPath', () => {
  it('counts feed segments in a running prefix', () => {
    const path = buildPath([seg('rapid'), seg('feed'), seg('feed'), seg('rapid'), seg('feed')]);
    expect(Array.from(path.feedPrefix)).toEqual([0, 1, 2, 2, 3]);
  });

  it('accumulates elapsed time', () => {
    const path = buildPath([seg('feed', { t: 2 }), seg('feed', { t: 3 })]);
    expect(Array.from(path.timePrefix)).toEqual([2, 5]);
    expect(path.totalTime).toBe(5);
  });
});

describe('feedsBefore', () => {
  it('reads the plain feed-count prefix at k-1', () => {
    const path = buildPath([seg('rapid'), seg('feed'), seg('feed')]);
    expect(feedsBefore(path, 0)).toBe(0);
    expect(feedsBefore(path, 1)).toBe(0);
    expect(feedsBefore(path, 3)).toBe(2);
  });
});

describe('feedsBeforeAt', () => {
  it('counts only the feeds at the requested rotary index', () => {
    const path = buildPath([
      seg('feed', { a4: 0 }),
      seg('feed', { a4: 90 }),
      seg('feed', { a4: 0 }),
      seg('rapid', { a4: 90 }), // a rapid never counts, even at the matching index
      seg('feed', { a4: 90 }),
    ]);
    expect(feedsBeforeAt(path, 5, 0)).toBe(2);
    expect(feedsBeforeAt(path, 5, 90)).toBe(2);
    // Partway through: only the first two segments have run.
    expect(feedsBeforeAt(path, 2, 0)).toBe(1);
    expect(feedsBeforeAt(path, 2, 90)).toBe(1);
  });

  it('is 0 for an index the program never machines at', () => {
    const path = buildPath([seg('feed', { a4: 0 }), seg('feed', { a4: 0 })]);
    expect(feedsBeforeAt(path, 2, 270)).toBe(0);
  });

  it('is 0 at k=0 regardless of index', () => {
    const path = buildPath([seg('feed', { a4: 0 })]);
    expect(feedsBeforeAt(path, 0, 0)).toBe(0);
  });

  it('clamps k beyond the path length', () => {
    const path = buildPath([seg('feed', { a4: 0 }), seg('feed', { a4: 0 })]);
    expect(feedsBeforeAt(path, 999, 0)).toBe(2);
  });

  it('matches a brute-force count across many indices and playhead positions', () => {
    // Cross-check the O(1) lookup against the definition it replaced, over a
    // program that keeps returning to indices it has already visited.
    const angles = [0, 90, 180, 270];
    const segs = [];
    for (let i = 0; i < 60; i++) {
      const a4 = angles[i % angles.length];
      segs.push(seg(i % 5 === 0 ? 'rapid' : 'feed', { a4 }));
    }
    const path = buildPath(segs);
    const bruteForce = (k, aIndex) => {
      let n = 0;
      for (let i = 0; i < Math.min(k, segs.length); i++) {
        if (segs[i].type !== 'rapid' && (segs[i].a4 || 0) === aIndex) n++;
      }
      return n;
    };
    for (const a4 of angles) {
      for (const k of [0, 1, 7, 23, 41, 60, 999]) {
        expect(feedsBeforeAt(path, k, a4)).toBe(bruteForce(k, a4));
      }
    }
  });
});

describe('timeAt / segmentAtTime', () => {
  it('round-trips: the segment reached by a time is at or before that time', () => {
    const path = buildPath([seg('feed', { t: 1 }), seg('feed', { t: 2 }), seg('feed', { t: 1 })]);
    expect(timeAt(path, 1)).toBe(1);
    expect(timeAt(path, 2)).toBe(3);
    expect(timeAt(path, 3)).toBe(4);
    expect(segmentAtTime(path, 0)).toBe(0);
    expect(segmentAtTime(path, 1)).toBe(1);
    expect(segmentAtTime(path, 3.5)).toBe(3);
    expect(segmentAtTime(path, 100)).toBe(path.count);
  });
});

describe('sliceUpTo', () => {
  it('splits the executed segments by type', () => {
    const path = buildPath([
      seg('rapid', { a: [0, 0, 0], b: [1, 0, 0] }),
      seg('feed', { a: [1, 0, 0], b: [2, 0, 0] }),
      seg('feed', { a: [2, 0, 0], b: [3, 0, 0] }),
    ]);
    const s = sliceUpTo(path, 2);
    expect(s.rapids.length).toBe(6); // one rapid segment
    expect(s.feeds.length).toBe(6);  // one feed segment executed so far
    expect(s.tool).toEqual([2, 0, 0]); // end of segment index 1
  });

  it('returns no tool position at k=0', () => {
    const path = buildPath([seg('feed')]);
    expect(sliceUpTo(path, 0).tool).toBeNull();
  });
});

describe('rotaryAt / toolAt / lineAt', () => {
  it('report the modal state after k segments', () => {
    const path = buildPath([
      seg('feed', { a4: 0, tool: 1, line: 10 }),
      seg('feed', { a4: 90, tool: 2, line: 20 }),
    ]);
    expect(rotaryAt(path, 1).a).toBe(0);
    expect(rotaryAt(path, 2).a).toBe(90);
    expect(toolAt(path, 1)).toBe(1);
    expect(toolAt(path, 2)).toBe(2);
    expect(lineAt(path, 2)).toBe(20);
  });
});
