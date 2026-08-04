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
