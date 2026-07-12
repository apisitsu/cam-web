/**
 * bufferCache — module-level storage for large binary buffers.
 *
 * Keeping Float32Array / Uint32Array / plain-object data here (outside Zustand
 * state) prevents React DevTools from trying to serialize them via
 * Performance.measure(), which throws DataCloneError: out of memory for large
 * typed arrays.
 *
 * Zustand only stores a small `bufVer` integer that increments every time a
 * buffer is written. Components subscribe to `bufVer` and read actual data
 * directly from this module via the exported getters.
 */

const _cache = {
  rapids: null,   // Float32Array — rapid-move line segments
  feeds:  null,   // Float32Array — feed-move line segments
  bounds: null,   // { min, max } plain object
  stats:  null,   // { lines, segments, warnings[] } plain object
  path:   null,   // { positions, types, feedPrefix, count }
  sim:    null,   // { positions, normals, indices, ... }
};

// The buffers actually drawn this frame — the full backplot, or the sliced
// sub-path during playback. Kept here (not passed as React props) for the same
// reason as `_cache`: React 19's dev Performance Track walks changed props
// element-by-element and Performance.measure() then structured-clones the
// result, which throws `DataCloneError: out of memory` on large typed arrays.
const _view = {
  rapids: null,   // Float32Array — rapids visible at the current playhead
  feeds:  null,   // Float32Array — feeds visible at the current playhead
};

export function setBuffers(patch) {
  Object.assign(_cache, patch);
}

export function setView(patch) {
  Object.assign(_view, patch);
}

export function clearBuffers() {
  _cache.rapids = null;
  _cache.feeds  = null;
  _cache.bounds = null;
  _cache.stats  = null;
  _cache.path   = null;
  _cache.sim    = null;
  _view.rapids  = null;
  _view.feeds   = null;
}

export const getBuf = () => _cache;
export const getView = () => _view;
