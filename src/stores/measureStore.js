/**
 * Measure: whether it is on, and the one or two clicks it holds.
 *
 * A store of its own because three places meet here — the Ribbon button that
 * turns it on, the part that takes the clicks, and the panel that reads them —
 * and none of them owns the others. The picks are in the frame of the part they
 * were clicked on, so anything that changes that frame clears them.
 */
import { create } from 'zustand';

export const useMeasureStore = create((set, get) => ({
  active: false,
  picks: [],

  /** On, with nothing picked; or off. */
  toggle() { set({ active: !get().active, picks: [] }); },
  stop() { set({ active: false, picks: [] }); },
  clear() { set({ picks: [] }); },

  /** A click. A third starts a new measurement rather than piling up. */
  add(pick) {
    const { picks } = get();
    set({ picks: picks.length >= 2 ? [pick] : [...picks, pick] });
  },
}));
