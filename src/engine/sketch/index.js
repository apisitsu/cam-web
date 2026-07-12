/**
 * Phase 2 — Sketch engine public API.
 *
 * Slice 1: the dependency-free, point-based sketch document model (`model.js`).
 * Slice 2: the planegcs (WASM) constraint solver bridge (`planegcs.js`).
 */
export {
  ENTITY_KINDS,
  CONSTRAINT_KINDS,
  createSketch,
  addPoint,
  addLine,
  addLineXY,
  addCircle,
  addCircleXY,
  addConstraint,
  totalDof,
  dof,
  serialize,
  deserialize,
} from './model.js';

export { createSolver, toPlanegcs } from './planegcs.js';

export { hitTestPoint, getOrCreatePoint, deleteEntity, removeConstraint } from './edit.js';
