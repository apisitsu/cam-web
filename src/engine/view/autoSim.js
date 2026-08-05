/**
 * When the app should press Simulate for you.
 *
 * Simulating is not an extra step an operator wants to remember — it is what
 * they came for. The moment there is a program, a **billet** to cut it from and
 * an **origin** to cut it against, the answer to "what will this make?" is
 * knowable, and making the operator ask for it is making them ask for the only
 * thing on screen they were ever after. Before those two are stated the answer
 * is a guess: a blank fitted to the toolpath and a datum the machine never had.
 *
 * The rule is expressed as a **key** rather than a boolean, and that is the
 * whole trick. A boolean is true for as long as the setup stands, so a view
 * watching it fires on every render and re-carves forever. A key is a string
 * describing *which* setup would be simulated: the view remembers the last key
 * it ran, and runs again only when the string changes — which is exactly when
 * the answer on screen has gone stale. Changing the stock, the origin, or the
 * program changes it; pressing Simulate by hand, scrubbing, or anything the
 * simulation itself writes back does not.
 *
 * Pure. No React, no store, no timers.
 */

/**
 * Has the operator stated a billet?
 *
 * The switch alone is not a statement — it can be on with every field blank,
 * and then the carver is still fitting a blank around the toolpath. One
 * dimension is: it says the material is this big in an axis the toolpath cannot
 * imply.
 */
export function stockStated({ stockEnabled = false, stockSize = null } = {}) {
  if (!stockEnabled || !stockSize) return false;
  return ['x', 'y', 'z'].some((k) => Number(stockSize[k]) > 0);
}

/**
 * Has the operator set an origin?
 *
 * Per-axis touch-off, the way a setter actually works: X0 off one face, Y0 off
 * another, Z0 off the top. Any one of them is a datum the program is now
 * measured against, so any one of them counts. A part carrying a datum point
 * from an older project counts too, which is what `point` covers.
 */
export function originStated(datum = null) {
  if (!datum) return false;
  if (Array.isArray(datum.axesSet) && datum.axesSet.some(Boolean)) return true;
  return Boolean(datum.point);
}

/**
 * The setup that would be simulated, as a string — or **null** when it is not
 * yet worth simulating.
 *
 * Null covers every reason not to run: no program to run, no billet to run it
 * into, no origin to run it against.
 *
 * @param {{gcode?:string, stockEnabled?:boolean, stockSize?:object,
 *   stockOrigin?:object, datum?:object, aIndex?:number|null}} args
 */
export function autoSimKey({
  gcode = '', stockEnabled = false, stockSize = null, stockOrigin = null,
  datum = null, aIndex = null,
} = {}) {
  if (!gcode || !gcode.trim()) return null;
  if (!stockStated({ stockEnabled, stockSize })) return null;
  if (!originStated(datum)) return null;
  const size = ['x', 'y', 'z'].map((k) => stockSize?.[k] ?? '-').join(',');
  const at = ['x', 'y', 'z'].map((k) => stockOrigin?.[k] ?? '-').join(',');
  const point = Array.isArray(datum?.point) ? datum.point.map((v) => Number(v).toFixed(4)).join(',') : '-';
  const axes = Array.isArray(datum?.axesSet) ? datum.axesSet.map((b) => (b ? 1 : 0)).join('') : '---';
  // The program itself, not a version counter: every counter in the store is
  // bumped by the simulation writing its own result back, which would make this
  // key change because it ran and run again because it changed.
  return [gcode.length, size, at, point, axes, aIndex ?? '-'].join('|');
}

/**
 * Should the view start a run now?
 *
 * `last` is the key it ran for previously (null on a fresh session). Held off
 * while a program is **playing** — a re-carve mid-run would yank the block out
 * from under the playhead — and while one is already running, so a setup edited
 * twice in a second does not queue two carves.
 */
export function shouldAutoSimulate({
  key = null, last = null, playing = false, running = false, sketching = false,
} = {}) {
  if (!key || playing || running || sketching) return false;
  return key !== last;
}
