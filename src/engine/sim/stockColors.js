/**
 * Machined material looks different from raw material, and the simulators
 * should say so.
 *
 * A single-colour block answers "what shape is left" and nothing else. It
 * cannot answer the question an operator actually has in front of a
 * simulation — *did this pass cut anything, and where?* — because a face the
 * tool has just been through looks exactly like a face it has never touched.
 * The turning sim has told them apart since it was written; this is the same
 * pair of colours, shared, so all three models agree.
 *
 * **The two must differ in hue, not only in brightness.** The cut colour was a
 * near-white "bright steel", and a near-white is exactly what a strong light
 * does to any surface — so a machined face read as a lit face of the same amber
 * block, and the distinction the pair exists to draw was the first thing the
 * lighting undid. A cool blue-steel cannot be produced from amber by any lamp in
 * the scene, so a cut face stays a cut face at every angle.
 *
 * Cool blue-steel for a cut surface, amber for raw stock — opposite sides of the
 * wheel, which is also the pairing that survives being looked at by someone who
 * cannot separate red from green. The material is white in `StockMesh` when
 * vertex colours are present, so these multiply straight through.
 */

/** A surface the tool has been through. */
export const CUT = [0.42, 0.70, 0.82];

/**
 * Stock as it came: never cut, still at the blank's own size.
 *
 * A shade deeper than the tool markers' gold insert (`#e0a92a`), so a turning
 * tool is never read as part of the bar it is standing on.
 */
export const RAW = [0.78, 0.52, 0.22];
