/**
 * Playback pacing — pure, so the loop's arithmetic can be tested without a timer.
 *
 * Playback is **time-paced, not segment-paced**: a helix tessellates into tens of
 * thousands of tiny segments while a face mill is a few long moves, so stepping
 * per segment parks on the helix and never shows the rest of the program. Pacing
 * by machine time gives every operation screen time in proportion to how long it
 * actually runs.
 *
 * Speed is a multiplier on a **fixed wall-clock budget**, not real machine time:
 * whatever a program's real cycle time, it spans `PLAY_BASE_SECONDS` at 1×.
 */

/** Wall-clock seconds a whole program takes at 1× — the slowest speed. */
export const PLAY_BASE_SECONDS = 600;
/** The animation timer's period, in seconds. */
export const TICK_SECONDS = 0.04;

/**
 * Speeds, laid out like a machine's %Rapid override: 25 / 50 / 100 % of full
 * speed, plus a 1× crawl (the machine's F0/jog position) for watching a cut.
 */
export const SPEEDS = [
  { label: '1×', value: 1 },
  { label: '25%', value: 25 },
  { label: '50%', value: 50 },
  { label: '100%', value: 100 },
];

/** Machine seconds to advance per timer tick at `speed`. */
export function perTick(totalTime, speed, { base = PLAY_BASE_SECONDS, tick = TICK_SECONDS } = {}) {
  return ((Math.max(totalTime, 1e-9) * tick) / base) * speed;
}

/** Wall-clock seconds a whole program takes at `speed`. */
export function wallClockSeconds(speed, { base = PLAY_BASE_SECONDS } = {}) {
  return base / speed;
}

/**
 * One step of the playback clock: advance machine time and report where the
 * playhead lands.
 *
 * `segmentAt` is `path.js`'s `segmentAtTime` bound to the path — passed in so
 * this module stays free of the buffer cache.
 *
 * The reason this is a function rather than three lines inside the timer: the
 * loop used to be rebuilt whenever the carved mesh changed, and each rebuild
 * reset the clock to the *end* of the segment in progress. Playback then advanced
 * a whole segment per carve, ignoring the speed setting entirely. Keeping the
 * clock in one place makes that class of bug testable.
 */
export function playbackStep(time, totalTime, speed, segmentAt, opts) {
  const next = time + perTick(totalTime, speed, opts);
  const playhead = segmentAt(next);
  return { time: next, playhead };
}
