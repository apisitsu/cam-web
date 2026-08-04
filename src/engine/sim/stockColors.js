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
 * Bright steel for a cut surface, amber for raw stock. The material is white in
 * `StockMesh` when vertex colours are present, so these multiply straight
 * through.
 */

/** A surface the tool has been through. */
export const CUT = [0.80, 0.83, 0.88];

/** Stock as it came: never cut, still at the blank's own size. */
export const RAW = [0.80, 0.55, 0.26];
