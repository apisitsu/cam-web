/**
 * Why did the simulation remove nothing?
 *
 * A carve that takes nothing off looks identical to a carve that never ran:
 * a solid block sitting where a machined part should be. There is no error, no
 * empty state, nothing to read — so every distinct cause produces the same
 * picture, and the only conclusion available to the operator is "the simulator
 * is broken". It usually is not. It is usually one of a handful of ordinary
 * setup mistakes, every one of which is detectable from data already to hand.
 *
 * So: when the removed volume comes back at zero, say which one it was.
 *
 * The checks are ordered by how early the cause sits in the workflow, because
 * the first thing that is wrong is the thing worth reporting — telling someone
 * their blank is mis-positioned when they have not written a program yet is
 * noise.
 *
 * Pure. No store, no DOM, no worker.
 */

/** Below this a "removal" is grid noise, not a cut. */
const EPS = 1e-6;

/**
 * @param {object} s
 * @param {boolean} s.hasProgram     is there any G-code at all?
 * @param {number} s.feeds           cutting moves the sim was given
 * @param {number} s.removedVolume   mm³ the carve reports
 * @param {{min:number[], max:number[]}|null} s.cutBounds  extent of the CUTTING
 *   moves (not rapids) — a rapid overhead proves nothing about the material
 * @param {{xMin:number,xMax:number,yMin:number,yMax:number,top:number,base:number}|null} s.box
 * @param {boolean} [s.followsPlayback] is cut-with-playback carving to the
 *   playhead instead of to the end?
 * @param {number} [s.playhead]
 * @returns {string|null} one sentence, or null when material really did come off
 */
export function removalDiagnosis({
  hasProgram, feeds = 0, removedVolume = 0, cutBounds, box,
  followsPlayback = false, playhead = 0,
} = {}) {
  if (removedVolume > EPS) return null;

  if (!hasProgram) {
    return 'No program loaded — write or open one, and there is something to cut with.';
  }
  if (feeds === 0) {
    return 'The program has no cutting moves (G1/G2/G3), so there is nothing to remove — only rapids.';
  }
  // Carving to a playhead that has not moved is a full simulation immediately
  // undone. It is the one cause that is not a mistake about the geometry.
  if (followsPlayback && playhead <= 0) {
    return 'The playhead is at the start and "cut with playback" is on, so the stock is showing its uncut state. Press play, or drag the slider.';
  }

  const known = cutBounds?.min && cutBounds?.max
    && cutBounds.min.every(Number.isFinite) && cutBounds.max.every(Number.isFinite);
  if (box && known) {
    // The trap the X/Y/Z stock form makes easy: `Origin` is the blank's
    // MINIMUM corner, so an origin of Z0 puts the whole blank ABOVE the work
    // plane and an ordinary program passes underneath it, cutting air.
    if (cutBounds.max[2] < box.base - EPS) {
      return `Every cutting move is below the blank. The blank runs Z ${box.base.toFixed(1)} to ${box.top.toFixed(1)}, and the highest cut is at Z ${cutBounds.max[2].toFixed(1)} — check the stock Origin Z, which is the blank's BOTTOM.`;
    }
    if (cutBounds.min[2] > box.top + EPS) {
      return `Every cutting move is above the blank. The blank's top is Z ${box.top.toFixed(1)} and the deepest cut only reaches Z ${cutBounds.min[2].toFixed(1)}.`;
    }
    const clearsXY = cutBounds.min[0] > box.xMax || cutBounds.max[0] < box.xMin
      || cutBounds.min[1] > box.yMax || cutBounds.max[1] < box.yMin;
    if (clearsXY) {
      return `The toolpath misses the blank in XY. The blank covers X ${box.xMin.toFixed(1)}…${box.xMax.toFixed(1)}, Y ${box.yMin.toFixed(1)}…${box.yMax.toFixed(1)}, and the cutting does not reach it.`;
    }
  }
  return 'The program ran but removed nothing — the cutting moves never reach into the blank.';
}

/**
 * The extent of the moves that actually **cut**.
 *
 * Deliberately not the full toolpath bounds: a rapid at Z50 over a blank whose
 * top is Z0 says nothing about whether material is reached, and including it
 * would defeat every Z check above.
 *
 * Nor is it simply "the feed moves", for the same reason one step further in. A
 * plunge is a feed move and it *begins in the air* — `G1 Z-8` from a Z50
 * clearance height is a feed segment spanning Z50 to Z-8, so its top is the
 * retract plane, not a cut. The moves that prove where the tool is cutting are
 * the ones that travel in XY, which is the same distinction `feedTopZ` draws in
 * `session.js` for the same reason. A pure drilling program has none, so it
 * falls back to every feed rather than reporting nothing.
 */
export function cuttingBounds(segments) {
  const measure = (list) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const s of list) {
      for (const p of [s.a, s.b]) {
        for (let k = 0; k < 3; k++) {
          if (p[k] < min[k]) min[k] = p[k];
          if (p[k] > max[k]) max[k] = p[k];
        }
      }
    }
    return Number.isFinite(min[0]) ? { min, max } : null;
  };

  const feeds = (segments ?? []).filter((s) => s.type !== 'rapid');
  const travelling = feeds.filter(
    (s) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) > 1e-6,
  );
  if (travelling.length === 0) return measure(feeds);
  // Sideways cuts fix where the tool cuts; plunges still fix how deep it gets.
  const across = measure(travelling);
  const all = measure(feeds);
  return { min: all.min, max: [across.max[0], across.max[1], across.max[2]] };
}
