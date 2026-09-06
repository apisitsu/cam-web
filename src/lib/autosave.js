/**
 * Auto-save draft — mirror unsaved sketch / feature / program work to
 * localStorage so a reload can offer it back.
 *
 * This is a safety net, not a save. It deliberately drops the imported STL
 * setup (`cam`), which is heavy and re-importable, and keeps the drawing — the
 * sketches, the feature tree, the program text — which is the part that cannot
 * be got back. An explicit Save (to the library or a file), a New project, and
 * opening a saved project all clear it, because at that point it is stale.
 *
 * Every localStorage access is wrapped: a browser in private mode throws on the
 * property itself, and the store can be full. A failed draft is a no-op, never
 * an error the operator sees.
 */
import { useCamStore } from '../stores/camStore.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { serialize as serializeSketch } from '../engine/sketch/model.js';
import { buildProject } from '../engine/projectFile.js';

const KEY = 'cam.autosave';
const DEBOUNCE_MS = 1500;

/** The drawing worth recovering, as a project doc — without the imported mesh. */
export function draftProject() {
  const cam = useCamStore.getState();
  const sketch = useSketchStore.getState();
  return buildProject({
    gcode: cam.gcode || '',
    fileName: cam.fileName || null,
    sketch: sketch.sk ? serializeSketch(sketch.sk) : null,
    sketches: sketch.serializeSketches(),
    settings: cam,
    cam: null, // the imported STL is heavy and the operator still has the file
    features: useFeatureStore.getState().serialize(),
  });
}

/** Has anything been drawn / typed that would be a loss to drop? */
export function worthSaving(project) {
  if ((project?.gcode || '').trim()) return true;
  if (Array.isArray(project?.features) && project.features.length) return true;
  const items = project?.sketches?.items ?? [];
  return items.some((s) => (s.doc?.entities?.length ?? 0) > 1); // more than the origin
}

let timer = null;
let stopFns = [];
let suspended = false;

/**
 * Write the draft now, synchronously. If there is nothing worth saving it does
 * NOT clear an existing draft — an operator who opens the page and does nothing
 * must still be offered whatever was there last time.
 */
export function writeDraftNow() {
  if (suspended) return;
  let project;
  try { project = draftProject(); } catch { return; }
  if (!worthSaving(project)) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), project }));
  } catch { /* quota exceeded, or no localStorage — best effort only */ }
}

function schedule() {
  if (suspended) return;
  clearTimeout(timer);
  timer = setTimeout(writeDraftNow, DEBOUNCE_MS);
}

/** The saved draft `{ at, project }`, or null when there is nothing to offer. */
export function readDraft() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY));
    if (parsed && parsed.project && worthSaving(parsed.project)) return parsed;
  } catch { /* absent, corrupt, or unreadable — nothing to restore */ }
  return null;
}

export function clearDraft() {
  clearTimeout(timer);
  try { window.localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/**
 * Run `fn` (which applies a project to the stores) with draft writes held off,
 * so restoring does not immediately re-draft over the thing being restored.
 */
export async function suspendAutosave(fn) {
  suspended = true;
  clearTimeout(timer);
  try {
    return await fn();
  } finally {
    suspended = false;
  }
}

/**
 * Start mirroring the stores to localStorage. Returns a stop function for the
 * effect cleanup. Subscribes to the exact slices that are the *drawing* — the
 * sketch version counter, the feature list, the program text — so a playback
 * tick or a view toggle never reschedules a write.
 */
export function startAutosave() {
  const onUnload = () => writeDraftNow(); // a pending debounce would not survive it
  stopFns = [
    useSketchStore.subscribe((s, p) => { if (s.version !== p.version) schedule(); }),
    useFeatureStore.subscribe((s, p) => { if (s.features !== p.features) schedule(); }),
    useCamStore.subscribe((s, p) => {
      if (s.gcode !== p.gcode || s.fileName !== p.fileName) schedule();
    }),
  ];
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', onUnload);
  return () => {
    clearTimeout(timer);
    stopFns.forEach((f) => f());
    stopFns = [];
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', onUnload);
  };
}
