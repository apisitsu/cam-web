/**
 * Which simulator can actually show what a program cuts.
 *
 * There are two milling models and they are not interchangeable:
 *
 * - the **height field** (`dexel.js`) keeps one top-Z per XY column. It is fast
 *   and scrub-able with playback, and it is structurally incapable of holding
 *   material *above* a cut — there is nowhere to put it.
 * - the **voxel block** (`voxel.js`) is a 3D lattice. It costs a third
 *   dimension in memory and time — and a coarser grid with it — and it can
 *   hold an undercut.
 *
 * Two things need the second one, and picking the wrong model does not fail
 * loudly — it quietly draws a different part:
 *
 * 1. **more than one rotary index.** A Z-up column can only be carved from
 *    above, so a height field carves one face and the others look uncut.
 * 2. **a cutter that only cuts near its tip.** A slot cutter with a stated
 *    cutting-body thickness leaves a groove with material standing over it —
 *    a keyseat, a T-slot. The height field takes the roof off, every time,
 *    and the result reads as "the slot cutter did not cut a slot".
 *
 * Pure: plain data in, a method and a reason out. The reason is not decoration
 * — a run that silently switches models owes the operator a sentence.
 */

/**
 * Does this tool leave material the height field cannot keep?
 *
 * A stated cutting-body thickness is the whole test: it says the tool cuts for
 * that much of its length and no further, so anything higher stays. Nothing
 * else in a tool implies an undercut on a 3-axis machine.
 */
export function undercutting(tool) {
  return Number(tool?.thickness) > 0;
}

/**
 * @param {{rotaryIndices?:number[], fallbackTool?:object,
 *   overrides?:Object<number,object>}} args
 * @returns {{method:'height'|'voxel', why:string|null}} `why` is null when the
 *   height field is the right model and nothing needs explaining.
 */
export function simMethodFor({
  rotaryIndices = [0], fallbackTool = null, overrides = null,
} = {}) {
  if ((rotaryIndices?.length ?? 1) > 1) {
    return {
      method: 'voxel',
      why: 'This program cuts at more than one rotary index, and a Z-up height field can only carve one of them.',
    };
  }
  const tools = [fallbackTool, ...Object.values(overrides || {})];
  const undercut = tools.filter(undercutting);
  if (undercut.length > 0) {
    const t = undercut[0].thickness;
    return {
      method: 'voxel',
      why: `A cutter that only cuts for its first ${t} mm leaves material standing over the groove. A height field holds one top-Z per column, so it would take that roof off.`,
    };
  }
  return { method: 'height', why: null };
}

/**
 * The smallest and largest cutter actually **in the cut**, as diameters.
 *
 * The small end is what the height field's XY resolution has to answer to: a
 * round feature is only as round as the grid under it, so a Ø2 centre drill on
 * a ½ mm grid comes out a four-sided hole — which is what "the chamfer, the
 * centre drill, the drill and the tap all look rough" turned out to be. Every
 * one of those is a small round tool.
 *
 * The large end is what the *cost* answers to: a stamp covers (2r/cs)² cells, so
 * it is the biggest cutter that decides how expensive a fine grid is.
 *
 * Only tools that cut count. A tool table listing a Ø1 engraver that the program
 * never calls must not drive the whole grid — `feeds` is how many cutting moves
 * a tool actually made, straight from the interpreter.
 *
 * @param {{tools?:object[], fallbackTool?:object, overrides?:object}} args
 * @returns {{min:number, max:number}} diameters in mm; zeros when nothing says.
 */
export function cutterSpan({ tools = [], fallbackTool = null, overrides = null } = {}) {
  const ov = overrides || {};
  const used = (tools || []).filter((t) => (t?.feeds ?? 0) > 0 || (tools || []).length === 1);
  const diameters = [];
  for (const t of used) {
    const o = ov[t.n] || {};
    const d = o.diameter ?? t.diameter ?? (t.radius > 0 ? t.radius * 2 : null);
    if (d > 0) diameters.push(d);
  }
  // Overrides for tools the program never described still count — the operator
  // typed them precisely so those moves would carve at that size.
  for (const o of Object.values(ov)) if (o?.diameter > 0) diameters.push(o.diameter);
  // The fallback picker covers every move whose tool nothing else knows about.
  if (fallbackTool?.radius > 0) diameters.push(fallbackTool.radius * 2);
  if (diameters.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...diameters), max: Math.max(...diameters) };
}

/** Cells across the smallest cutter's diameter — what makes a bore look round. */
export const CIRCLE_CELLS = 24;
/** No finer than this, whatever the tool: past here the grid is a memory leak. */
export const MIN_CELL = 0.02;
/**
 * Ceiling on the grid itself. Every mesh build scans it once, and a mesh is
 * built per playback tick — this is that scan, not memory, which would allow
 * far more.
 */
export const MAX_CELLS = 1.2e6;
/**
 * Ceiling on the **carving**, in cell-stamps: the sweep steps every half cell
 * and each stamp touches the cells under the cutter, so halving the cell size
 * is eight times the work. This is the budget that actually binds — a grid fine
 * enough to draw a Ø2 drill is free to render and ruinous to carve a facing
 * pass on, and the difference between those two jobs is exactly this number.
 *
 * Calibrated at roughly 30k stamps per millisecond, so the ceiling is a couple
 * of seconds of carving on the machine this was measured on.
 */
export const MAX_STAMPS = 7e7;

/**
 * The cell size to actually carve the height field at.
 *
 * The operator's setting is a **ceiling**, not the answer: it says "no coarser
 * than this", and the sim refines below it when the tooling needs it and the
 * budgets allow. Refining is what makes a drilled hole round; the budgets are
 * what stop a hole program's resolution being applied to a facing job and
 * turning Simulate into a thirty-second wait.
 *
 * The budgets bound the **refinement only**. A setting that is already
 * expensive for the tooling in the program is left exactly as it is: that is
 * the operator's call, and quietly simulating coarser than they asked would be
 * the app overruling a number they typed.
 *
 * @param {{requested?:number, span?:{min:number,max:number},
 *   bounds?:{min:number[],max:number[]}|null, cutLength?:number}} args
 * @returns {{size:number, limited:boolean, wanted:number}} `limited` = a budget,
 *   not the tooling, decided the answer — and the caller should say so.
 */
export function cellSizeFor({
  requested = 0.5, span = null, bounds = null, cutLength = 0,
} = {}) {
  const asked = requested > 0 ? requested : 0.5;
  const minD = span?.min > 0 ? span.min : 0;
  const maxR = span?.max > 0 ? span.max / 2 : 0;
  const wanted = Math.max(minD > 0 ? Math.min(asked, minD / CIRCLE_CELLS) : asked, MIN_CELL);

  const spanX = bounds ? Math.max(bounds.max[0] - bounds.min[0], 0) : 0;
  const spanY = bounds ? Math.max(bounds.max[1] - bounds.min[1], 0) : 0;
  const cells = (cs) => (spanX > 0 && spanY > 0
    ? Math.ceil(spanX / cs) * Math.ceil(spanY / cs) : 0);
  // Stamps every half cell along the cut, each covering the disc of the cutter.
  const stamps = (cs) => (cutLength > 0 && maxR > 0
    ? (cutLength / (cs / 2)) * Math.PI * (maxR / cs) * (maxR / cs) : 0);

  let size = wanted;
  let limited = false;
  // Coarsen in steps rather than solving for it: two ceilings on different
  // powers of the cell size have no closed form worth writing down.
  while (size < asked && (cells(size) > MAX_CELLS || stamps(size) > MAX_STAMPS)) {
    size = Math.min(asked, size * 1.15);
    limited = true;
  }
  return { size, limited, wanted };
}

/**
 * The thinnest stated cutting body among every tool in play, or 0 when none
 * says. This is what the voxel grid has to be able to hold: the tool table can
 * state a thickness per tool, and looking only at the fallback picker left a
 * per-tool slot cutter carved on a grid coarser than its own groove.
 */
export function thinnestCut({ fallbackTool = null, overrides = null } = {}) {
  const tools = [fallbackTool, ...Object.values(overrides || {})].filter(undercutting);
  return tools.length ? Math.min(...tools.map((t) => Number(t.thickness))) : 0;
}

/** Voxel layers wanted across the thinnest thing being cut. */
export const VOXEL_LAYERS = 4;
/**
 * Ceiling on grid size, so a fine cutter on a big part still runs.
 *
 * The voxel block is now a playback session, and every carve step re-scans the
 * whole grid to rebuild its surface. That scan is what this bounds — not
 * memory, which would allow far more. A grid over the ceiling is carved
 * coarser and the caller says so, which is a slower answer made honest rather
 * than a tab that never comes back.
 */
export const MAX_VOXELS = 4e6;

/**
 * The voxel size to actually carve at — a footprint and a height.
 *
 * A voxel grid can only show a feature it can hold, and a **cut is rounded out
 * to whole voxels**: a 3 mm cutting body carved on a 1 mm grid comes back as a
 * groove up to 4 mm tall, which is exactly the "the slot is taller than the
 * cutter" it looks like. The dimension it is always wrong in is **Z** — the
 * groove's height is what the cutting body sets — so that is the one refined,
 * to `VOXEL_LAYERS` across the thinnest cut.
 *
 * Refining Z alone costs cells in proportion. Refining all three costs the cube
 * of it: the isotropic grid this used to ask for turned a thin cutter on an
 * ordinary billet into millions of voxels, hit `MAX_VOXELS`, and got coarsened
 * straight back to a groove that did not match the tool. The footprint stays at
 * the resolution the operator asked for, which is what the slot's outline
 * needs and no more.
 *
 * @param {{requested?:number, thickness?:number,
 *   bounds?:{min:number[], max:number[]}|null}} args
 * @returns {{size:number, sizeZ:number, limited:boolean}} `limited` = the
 *   budget, not the cutter, decided the height.
 */
export function voxelSizeFor({ requested = 1, thickness = 0, bounds = null } = {}) {
  const size = requested > 0 ? requested : 1;
  let sizeZ = thickness > 0
    ? Math.min(size, Math.max(thickness / VOXEL_LAYERS, 0.02))
    : size;
  if (!bounds?.min || !bounds?.max) return { size, sizeZ, limited: false };
  const span = [0, 1, 2].map((k) => Math.max(bounds.max[k] - bounds.min[k], 0));
  const cells = (z) => Math.max(1, Math.ceil(span[0] / size))
    * Math.max(1, Math.ceil(span[1] / size))
    * Math.max(1, Math.ceil(span[2] / z));
  let limited = false;
  // Coarsen in steps rather than solving for it: the count is a product of
  // ceilings, so the closed form is only ever approximately right anyway.
  while (sizeZ < size && cells(sizeZ) > MAX_VOXELS) {
    sizeZ = Math.min(size, sizeZ * 1.25);
    limited = true;
  }
  return { size, sizeZ, limited };
}
