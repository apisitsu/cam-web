/**
 * Speeds and feeds — turning cutting data into spindle RPM and feedrate.
 *
 * The arithmetic is the standard shop formula, and it is short enough that the
 * value of putting it here is not the maths but the *clamping*: a Ø2 endmill in
 * aluminium wants 63,000 rpm, which no machine has, and a Ø63 facemill in
 * titanium wants 250 rpm, which is fine. Every recommendation therefore comes
 * back with the limit that shaped it, so the UI can explain why a number is
 * what it is instead of presenting it as an oracle.
 *
 * Milling:  S = 1000·Vc / (π·D)      F = S · z · fz
 * Turning:  S = 1000·Vc / (π·D)      F = S · fn        (fn is mm/rev)
 *
 * Pure functions. No React, no store, no DOM.
 */

import { materialById } from './library.js';

/** Machine envelope. Overridable, because a router and a VMC are not alike. */
export const DEFAULT_MACHINE = {
  maxRpm: 12000,
  minRpm: 100,
  maxFeed: 10000,   // mm/min
  rapidRate: 5000,  // mm/min — matches camStore's default
  maxTurnRpm: 3000, // lathes spin slower than mills
};

/**
 * Feed per tooth scaled for cutter diameter.
 *
 * The table's `fzBase` is quoted for a 10 mm cutter. A small endmill cannot
 * take the same chip — its core is far weaker — so feed per tooth is scaled by
 * the square root of the diameter ratio. That is the conventional rule of
 * thumb, and it degrades gently: a Ø3 gets 55% of the Ø10 chipload, a Ø20 gets
 * 141%.
 */
export function chipload(material, diameter) {
  const m = materialById(material);
  return m.fzBase * Math.sqrt(Math.max(diameter, 0.1) / 10);
}

/**
 * @param {object} args
 * @param {string} args.material   material id
 * @param {number} args.diameter   cutter diameter (mm)
 * @param {number} args.flutes
 * @param {number} [args.vcScale]  1 for roughing; finishing passes run faster
 *                                 and lighter, so callers raise it
 * @param {object} [args.machine]
 * @returns {{rpm:number, feed:number, vc:number, fz:number, limitedBy:string|null,
 *   idealRpm:number}}
 *   `limitedBy` is 'maxRpm' / 'minRpm' / 'maxFeed' when the envelope clipped the
 *   ideal value, otherwise null.
 */
export function millingSpeeds({ material, diameter, flutes, vcScale = 1, machine = DEFAULT_MACHINE }) {
  const m = materialById(material);
  const vc = m.vcMill * vcScale;
  const idealRpm = (1000 * vc) / (Math.PI * Math.max(diameter, 0.1));

  let rpm = idealRpm;
  let limitedBy = null;
  if (rpm > machine.maxRpm) { rpm = machine.maxRpm; limitedBy = 'maxRpm'; }
  else if (rpm < machine.minRpm) { rpm = machine.minRpm; limitedBy = 'minRpm'; }

  const fz = chipload(material, diameter);
  let feed = rpm * flutes * fz;
  if (feed > machine.maxFeed) { feed = machine.maxFeed; limitedBy = 'maxFeed'; }

  return {
    rpm: Math.round(rpm),
    feed: Math.round(feed),
    // The speed actually achieved, which is what the operator cares about when
    // the spindle was the binding constraint.
    vc: Math.round((Math.PI * diameter * rpm) / 1000),
    fz: Number(fz.toFixed(4)),
    idealRpm: Math.round(idealRpm),
    limitedBy,
  };
}

/**
 * Turning cutting data at a given work diameter.
 *
 * Surface speed on a lathe depends on the diameter being cut *right now*, which
 * changes continuously as the tool moves in X. Constant surface speed (G96)
 * exists precisely for this, and the honest answer for a lathe is a G96 speed
 * plus a G50 clamp — not a single RPM. `rpm` is still returned, evaluated at
 * `diameter`, for posts and operators that prefer G97.
 *
 * @param {object} args
 * @param {string} args.material
 * @param {number} args.diameter   work diameter at the cut (mm)
 * @param {number} [args.fnScale]  <1 for finishing (lighter feed, better finish)
 * @param {number} [args.noseRadius] insert nose radius, used for the finish estimate
 */
export function turningSpeeds({ material, diameter, fnScale = 1, noseRadius = 0.4, machine = DEFAULT_MACHINE }) {
  const m = materialById(material);
  const vc = m.vcTurn;
  const idealRpm = (1000 * vc) / (Math.PI * Math.max(diameter, 0.1));

  let rpm = idealRpm;
  let limitedBy = null;
  const maxRpm = machine.maxTurnRpm ?? machine.maxRpm;
  if (rpm > maxRpm) { rpm = maxRpm; limitedBy = 'maxRpm'; }
  else if (rpm < machine.minRpm) { rpm = machine.minRpm; limitedBy = 'minRpm'; }

  const fn = m.fnTurn * fnScale;
  return {
    vc: Math.round(vc),
    rpm: Math.round(rpm),
    idealRpm: Math.round(idealRpm),
    clampRpm: Math.round(maxRpm),  // the G50 clamp that must accompany G96
    fn: Number(fn.toFixed(3)),
    feed: Number(fn.toFixed(3)),   // lathes feed in mm/rev under G99
    // The same feed as the machine experiences it, which is the only form
    // comparable with a milling feed, a cycle time, or the readout. The posted
    // program still carries `fn` under G99 — this is for people, not for posts.
    feedPerMin: Math.round(fn * rpm),
    // Theoretical peak-to-valley finish: Ra ~ fn^2 / (18*sqrt(3)*r). Useful for
    // telling the operator when the feed, not the insert, is what limits finish.
    estimatedRa: Number(((fn * fn) / (18 * Math.sqrt(3) * Math.max(noseRadius, 0.05)) * 1000).toFixed(2)),
    limitedBy,
  };
}

/**
 * Roughing depth of cut and stepover for a milling cutter, from the material's
 * aggressiveness factors. Clamped so a facemill does not try to take a 50 mm
 * deep cut just because its diameter allows it.
 *
 * The machine's `rigidity` scales the depth of cut, because the material table
 * alone is not the whole story: 1×D in aluminium is routine on a 40-taper VMC
 * and will stall or chatter a hobby router with the same cutter and the same
 * material. Stepover is left alone — it is the *depth* that loads the spindle
 * and the frame, and taking a lighter, wider cut is how a light machine keeps
 * its chipload sane rather than rubbing.
 */
export function millingEngagement({ material, diameter, type = 'endmill', machine = DEFAULT_MACHINE }) {
  const m = materialById(material);
  const rigidity = machine?.rigidity ?? 1;
  if (type === 'facemill') {
    return { ap: Math.min(2, m.apFactor * 2) * rigidity, ae: diameter * 0.7 };
  }
  return {
    ap: Number((diameter * m.apFactor * rigidity).toFixed(3)),
    ae: Number((diameter * m.aeFactor).toFixed(3)),
  };
}

/**
 * Drilling data. Peck depth is what keeps a deep hole from packing with chips —
 * past about 3×D a plain G81 stops being safe, so this reports when G83 is
 * needed rather than leaving the caller to guess.
 */
export function drillingSpeeds({ material, diameter, depth, machine = DEFAULT_MACHINE }) {
  const m = materialById(material);
  // Drills run slower than mills in the same material.
  const vc = m.vcMill * 0.35;
  const idealRpm = (1000 * vc) / (Math.PI * Math.max(diameter, 0.1));
  let rpm = Math.min(Math.max(idealRpm, machine.minRpm), machine.maxRpm);
  let limitedBy = null;
  if (idealRpm > machine.maxRpm) limitedBy = 'maxRpm';
  else if (idealRpm < machine.minRpm) limitedBy = 'minRpm';

  const fn = 0.02 * diameter; // mm/rev, a standard first guess
  const ratio = depth / Math.max(diameter, 0.1);
  return {
    rpm: Math.round(rpm),
    feed: Math.round(rpm * fn),
    idealRpm: Math.round(idealRpm),
    peck: ratio > 3 ? Number((diameter * 0.8).toFixed(2)) : null,
    cycle: ratio > 3 ? 'G83' : 'G81',
    depthRatio: Number(ratio.toFixed(2)),
    limitedBy,
  };
}

/**
 * Cutting time for a length of path, in minutes. The planner sums these into a
 * per-operation estimate, which is the number a quote actually depends on.
 */
export function cuttingTime(lengthMm, feedMmPerMin) {
  if (!(feedMmPerMin > 0)) return 0;
  return lengthMm / feedMmPerMin;
}
