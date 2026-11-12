/**
 * Chamfer / Fillet while it is being set up: which one, how big, and the edges
 * clicked so far. Kept apart for the same reason Measure is — the Ribbon button,
 * the part that takes the clicks and the panel that reads them all meet here.
 *
 * `editingId` is set when an existing feature's edges are being picked again.
 */
import { create } from 'zustand';
import { sameEdge } from '../engine/solid/edgeTreat.js';

const DEFAULT_SIZE = { chamfer: 1, fillet: 2 };

export const useEdgeTreatStore = create((set, get) => ({
  active: null,
  size: DEFAULT_SIZE.chamfer,
  edges: [],
  editingId: null,
  hover: null,
  error: null,

  /** Start picking for a new feature, or for `feature` again. */
  start(kind, feature = null) {
    set({
      active: kind,
      size: feature?.size ?? DEFAULT_SIZE[kind],
      edges: feature?.edges ? [...feature.edges] : [],
      editingId: feature?.id ?? null,
      hover: null,
      error: null,
    });
  },
  stop() {
    set({
      active: null, edges: [], editingId: null, hover: null, error: null,
    });
  },
  setSize(size) { set({ size }); },
  setHover(hover) { set({ hover }); },
  setError(error) { set({ error }); },

  /** A click on an edge: picked, or picked off again. */
  toggleEdge(ref) {
    if (!ref) return;
    const { edges } = get();
    const kept = edges.filter((e) => !sameEdge(e, ref));
    set({ edges: kept.length === edges.length ? [...edges, ref] : kept, error: null });
  },
  removeEdge(i) {
    set({ edges: get().edges.filter((_, k) => k !== i) });
  },
}));
