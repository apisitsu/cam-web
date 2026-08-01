import { describe, it, expect } from 'vitest';
import {
  buildPath, feedsBefore, feedsBeforeAt, timeAt, segmentAtTime, sliceUpTo,
  rotaryAt, toolAt, lineAt, segmentIndexAt, toolPointAt, blockTargetAt,
  nextBlockEnd, prevBlockStart,
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

/**
 * A program of three blocks, the middle one tessellated the way an arc is:
 *
 *   N10  one straight move            segment 0
 *   N20  an arc, three chords         segments 1-3
 *   N30  a plunge                     segment 4
 *
 * Every segment runs 1 s, so machine time and segment index line up.
 */
function blockPath() {
  return buildPath([
    seg('feed', { a: [0, 0, 0], b: [10, 0, 0], line: 10 }),
    seg('feed', { a: [10, 0, 0], b: [12, 2, 0], line: 20 }),
    seg('feed', { a: [12, 2, 0], b: [14, 4, 0], line: 20 }),
    seg('feed', { a: [14, 4, 0], b: [16, 6, 0], line: 20 }),
    seg('feed', { a: [16, 6, 0], b: [16, 6, -5], line: 30 }),
  ]);
}

describe('buildPath — block boundaries', () => {
  it('gives every segment of a tessellated block the same end', () => {
    expect(Array.from(blockPath().blockEnd)).toEqual([0, 3, 3, 3, 4]);
  });

  it('makes each segment its own block when every line is different', () => {
    const path = buildPath([seg('feed', { line: 1 }), seg('feed', { line: 2 })]);
    expect(Array.from(path.blockEnd)).toEqual([0, 1]);
  });
});

describe('segmentIndexAt', () => {
  it('names the segment in progress, not the count entered', () => {
    const path = blockPath();
    expect(segmentIndexAt(path, 0.5)).toBe(0);
    expect(segmentIndexAt(path, 1)).toBe(1);   // segment 0 is done at t=1
    expect(segmentIndexAt(path, 2.5)).toBe(2);
  });

  it('has no segment before the program starts', () => {
    expect(segmentIndexAt(blockPath(), 0)).toBe(-1);
    expect(segmentIndexAt(buildPath([]), 1)).toBe(-1);
  });

  it('holds on the last segment once the program has run out', () => {
    expect(segmentIndexAt(blockPath(), 999)).toBe(4);
  });

  it('still agrees with toolPointAt, which is built on it', () => {
    const path = blockPath();
    expect(toolPointAt(path, 0.5)).toEqual([5, 0, 0]);
    expect(toolPointAt(path, 999)).toEqual([16, 6, -5]);
    expect(toolPointAt(path, 0)).toBeNull();
  });
});

describe('blockTargetAt', () => {
  it('targets the end of the block, not the end of the chord', () => {
    // Mid-arc at t=1.5 the segment ends at [12,2,0] a chord away; what the
    // operator is waiting for is the arc's own end point.
    expect(blockTargetAt(blockPath(), 1.5)).toEqual([16, 6, 0]);
  });

  it('targets the move itself on a single-segment block', () => {
    expect(blockTargetAt(blockPath(), 0.5)).toEqual([10, 0, 0]);
  });

  it('posts the block queued up when stopped exactly on a boundary', () => {
    // t=1 is the instant the arc starts: the whole arc is still to go.
    expect(blockTargetAt(blockPath(), 1)).toEqual([16, 6, 0]);
  });

  it('has no target before the program starts', () => {
    expect(blockTargetAt(blockPath(), 0)).toBeNull();
  });

  it('falls back to a scan for a path with no precomputed block ends', () => {
    const { blockEnd, ...legacy } = blockPath();
    expect(blockEnd).toBeDefined();
    expect(blockTargetAt(legacy, 1.5)).toEqual([16, 6, 0]);
  });
});

describe('nextBlockEnd — single block', () => {
  it('runs the whole of the next block from a boundary', () => {
    const path = blockPath();
    expect(nextBlockEnd(path, 0)).toBe(1);   // N10, one segment
    expect(nextBlockEnd(path, 1)).toBe(4);   // N20, all three chords at once
    expect(nextBlockEnd(path, 4)).toBe(5);   // N30
  });

  it('finishes the block in progress when the playhead sits inside one', () => {
    // A time-paced playhead usually stops mid-arc; one block on from there is
    // the end of that arc, not the end of the chord.
    expect(nextBlockEnd(blockPath(), 2)).toBe(4);
    expect(nextBlockEnd(blockPath(), 3)).toBe(4);
  });

  it('stops at the end of the program', () => {
    expect(nextBlockEnd(blockPath(), 5)).toBe(5);
    expect(nextBlockEnd(blockPath(), 999)).toBe(5);
  });

  it('is 0 with no program to step', () => {
    expect(nextBlockEnd(buildPath([]), 0)).toBe(0);
    expect(nextBlockEnd(null, 3)).toBe(0);
  });

  it('walks the whole program one block at a time, hitting every block', () => {
    const path = blockPath();
    const stops = [];
    let k = 0;
    for (let i = 0; i < 20 && k < path.count; i++) {
      k = nextBlockEnd(path, k);
      stops.push(k);
    }
    expect(stops).toEqual([1, 4, 5]);
  });
});

describe('prevBlockStart', () => {
  it('rewinds to the start of the block that just ran, so it can be re-run', () => {
    const path = blockPath();
    expect(prevBlockStart(path, 5)).toBe(4);
    expect(prevBlockStart(path, 4)).toBe(1);
    expect(prevBlockStart(path, 1)).toBe(0);
  });

  it('rewinds to the start of the block the playhead is inside', () => {
    expect(prevBlockStart(blockPath(), 3)).toBe(1);
  });

  it('stops at the beginning of the program', () => {
    expect(prevBlockStart(blockPath(), 0)).toBe(0);
    expect(prevBlockStart(null, 3)).toBe(0);
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
