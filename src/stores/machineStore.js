/**
 * machineStore — the shop's machines (added, or changed from the built-in
 * list), and the Machines dialog that edits them.
 *
 * The list itself lives in `engine/cam/machines.js` (`setShopMachines`), where
 * every lookup already goes; `version` bumps on each change so components that
 * list machines re-render. Storage is `lib/machineApi.js`.
 */
import { create } from 'zustand';
import { listMachines, saveMachine, deleteMachine } from '../lib/machineApi.js';
import { setShopMachines, machineById, isBuiltIn, DEFAULT_MILL_ID, DEFAULT_LATHE_ID } from '../engine/cam/machines.js';
import { useCamPlanStore } from './camPlanStore.js';

/** Re-select the machine in use when it is the one that changed, so limits and timing follow. */
function reapply(id, kind) {
  const plan = useCamPlanStore.getState();
  if (plan.machineId !== id) return;
  const still = machineById(id);
  plan.setMachine(still.id === id ? id : (kind === 'turn' ? DEFAULT_LATHE_ID : DEFAULT_MILL_ID));
}

export const useMachineStore = create((set, get) => ({
  rows: [],
  loaded: false,
  /** Why the list could not be read or written, as a sentence — or null. */
  error: null,
  version: 0,
  editorOpen: false,

  async load() {
    try {
      const rows = await listMachines();
      setShopMachines(rows);
      set({ rows, loaded: true, error: null, version: get().version + 1 });
    } catch (err) {
      // No table yet, or the server is down: the built-in list still works.
      set({ loaded: true, error: err?.message || String(err) });
    }
    return get().rows;
  },

  /** Add or change one machine. Rejects with the server's sentence. */
  async save(id, body) {
    await saveMachine(id, body);
    await get().load();
    reapply(id, body.kind);
  },

  /** Reset a built-in to its own figures, or remove an added machine. */
  async remove(id) {
    const kind = machineById(id)?.kind;
    await deleteMachine(id);
    await get().load();
    reapply(id, kind);
  },

  isBuiltIn,
  openEditor() { set({ editorOpen: true }); get().load(); },
  closeEditor() { set({ editorOpen: false }); },
}));
