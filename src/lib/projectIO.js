/**
 * Browser side of saving and opening work: gathers state from the stores, writes
 * a file, and applies a file back. Kept out of the stores so neither has to know
 * about the other (a project spans both camStore and sketchStore) and out of the
 * engine so the format layer stays DOM-free.
 */
import { useCamStore } from '../stores/camStore.js';
import { useCamPlanStore, getMesh } from '../stores/camPlanStore.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { serialize as serializeSketch } from '../engine/sketch/model.js';
import { sketchToDxf, sketchHasGeometry } from '../engine/sketch/dxf.js';
import {
  buildProject, serializeProject, parseProject, projectFileName, programFileName,
} from '../engine/projectFile.js';
import { clearDraft } from './autosave.js';

/**
 * Hand `text` to the browser as a download, named `suggestedName`.
 *
 * No dialog, no picker: it lands in the Downloads folder and the operator knows
 * where that is. This is what "export" should mean on a shop-floor tablet, and
 * it is the only path that exists at all when the page is served over plain HTTP
 * on the LAN — `showSaveFilePicker` requires a secure context, so on
 * `http://10.x.x.x:3100` it is simply not there.
 */
export function downloadTextFile(suggestedName, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has taken the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return suggestedName;
}

/**
 * Write `text` to a file the user picks. Uses the File System Access API where
 * it exists (Chrome/Edge — a real Save-As, and re-saving overwrites in place),
 * and falls back to a download for everything else. Returns the name written, or
 * null if the user cancelled.
 */
export async function saveTextFile(suggestedName, text, { description = 'File', accept } = {}) {
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: accept ? [{ description, accept }] : undefined,
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return handle.name || suggestedName;
    } catch (err) {
      // The picker throws AbortError when the user closes it — not a failure.
      if (err && err.name === 'AbortError') return null;
      throw err;
    }
  }
  return downloadTextFile(suggestedName, text, 'application/octet-stream');
}

/** Everything the app currently holds, as a project document. */
export function currentProject() {
  const cam = useCamStore.getState();
  const sketch = useSketchStore.getState();
  const sk = sketch.sk;
  return buildProject({
    gcode: cam.gcode || '',
    fileName: cam.fileName || null,
    // An untouched sketch (origin only) is not worth saving as content, but it
    // costs nothing and keeps "open" symmetric, so it goes in as-is.
    sketch: sk ? serializeSketch(sk) : null,
    // Every sketch and the plane each sits on (v3). The singular field above is
    // the active one, kept for the reasons in `projectFile.js`.
    sketches: sketch.serializeSketches(),
    settings: cam,
    // The whole STL→plan setup: part, machine, material, origin, operations.
    // Null when nothing is imported, so a bare sketch/program stays a v1-shaped
    // project with no `cam` block.
    cam: useCamPlanStore.getState().serializeSetup(),
    // The feature tree (v4) — the operations that built the part, so reopening
    // the project can change it and not only look at it.
    features: useFeatureStore.getState().serialize(),
  });
}

/** Save the whole project (program + setup + sketch). Returns the file name. */
export async function saveProject() {
  const cam = useCamStore.getState();
  const name = await saveTextFile(
    projectFileName(cam.fileName),
    serializeProject(currentProject()),
    { description: 'cam-web project', accept: { 'application/json': ['.json'] } },
  );
  // Filed to disk → the auto-save draft is now redundant. `null` means the
  // user cancelled the picker, so leave it.
  if (name) clearDraft();
  return name;
}

/**
 * Export the program as a downloaded `.nc` — for handing it to a machine, a
 * USB stick, or another CAM.
 *
 * A **download**, not a save dialog. The picker is nicer on a desktop when it
 * exists, and it does not exist where this app is actually used from: served
 * over the LAN to a tablet at the machine, `window.showSaveFilePicker` is absent
 * (it needs a secure context) and the picker path was already falling through to
 * this one. One behaviour everywhere beats two that differ by browser, and it
 * matches the CAM panel's own Download NC button, which has always worked this
 * way. The project file keeps its Save-As: a project is filed away, a program is
 * handed on.
 */
export async function exportGcode() {
  const cam = useCamStore.getState();
  const text = cam.gcode || '';
  if (!text.trim()) throw new Error('There is no program to export yet.');
  return downloadTextFile(programFileName(cam.fileName), text);
}

/**
 * Export the sketch as DXF — the format every CAD reads, and the way a sketch
 * gets into SolidWorks, CATIA, AutoCAD or another CAM. Throws if there is no
 * geometry yet, so the user gets told rather than handed an empty file.
 */
export async function exportSketchDxf() {
  const sk = useSketchStore.getState().sk;
  if (!sketchHasGeometry(sk)) {
    throw new Error('Nothing to export yet — draw some lines, circles or arcs first.');
  }
  const base = (useCamStore.getState().fileName || 'sketch').replace(/\.[^.\\/]*$/, '') || 'sketch';
  return saveTextFile(`${base}.dxf`, sketchToDxf(sk), {
    description: 'DXF drawing',
    accept: { 'application/dxf': ['.dxf'] },
  });
}

/**
 * Start again with nothing loaded.
 *
 * Lives here for the reason `applyProject` does: this is the one place that
 * already knows every store a project spans, so "empty them all" belongs beside
 * "fill them all" rather than being reassembled by whichever panel needs it.
 * A partial new-project — the sketch cleared but the feature tree still holding
 * operations that reference it — is worse than none.
 *
 * The library's record of what is open is **not** cleared here; the caller does
 * that, because `projectIO` is deliberately unaware of the library.
 */
export async function newProject() {
  clearDraft(); // starting over — nothing to recover
  useCamPlanStore.getState().clear();
  useFeatureStore.getState().clear();

  const sketch = useSketchStore.getState();
  sketch.clear();
  // `clear()` blanks the active sketch; the rest have to go too, or a new job
  // starts with the last one's geometry on planes nobody chose.
  for (const entry of [...sketch.sketches]) {
    useSketchStore.getState().removeSketch(entry.id);
  }
  useSketchStore.setState({ nextSketchId: 2, past: [], future: [], error: null });

  // The program last: parsing empties the buffers the viewport reads.
  await useCamStore.getState().parse('', null);
}

/**
 * Apply a project document to the app: settings, setup, sketch, then program.
 *
 * Split out of `openProjectFile` so the library (`stores/libraryStore.js`) opens
 * a saved project through exactly this path. Two doors, one room: a project
 * restored from the database and one restored from a file cannot come back
 * differently, because there is only one piece of code that restores anything.
 *
 * `project` is a **parsed** document — `parseProject`'s output shape, or a raw
 * document from our own database, which is run back through `parseProject` so a
 * record written by an older build is validated the same way a file is.
 */
export async function applyProject(doc) {
  const project = doc && typeof doc.settings === 'object' && !doc.kind
    ? doc                                       // already parsed
    : parseProject(typeof doc === 'string' ? doc : JSON.stringify(doc));
  const cam = useCamStore.getState();
  // Settings first, so the parse below runs with the right machine mode.
  if (Object.keys(project.settings).length) cam.setTool(project.settings);
  // The CAM setup — part, machine, material, origin, operations. Returns the
  // restored process mode when the project carried a part, or null otherwise.
  const camMode = useCamPlanStore.getState().restoreSetup(project.cam);
  // v3 carries every sketch and its plane; a v1/v2 project carries one document
  // and no plane, which `loadSerialized` puts on the table exactly as before.
  // Try the list first and fall back — never both, or the fallback would
  // overwrite the list with just its active member.
  const sketchStore = useSketchStore.getState();
  if (!sketchStore.loadSketches(project.sketches) && project.sketch) {
    sketchStore.loadSerialized(project.sketch);
  }
  // The tree last, so it restores against the sketches and the part it names.
  // `getMesh().soup` is whatever `restoreSetup` just put back, which is the mesh
  // an `import` feature described.
  const featureStore = useFeatureStore.getState();
  featureStore.clear();
  if (project.features) featureStore.load(project.features, getMesh().soup);
  await cam.parse(project.gcode, project.fileName ?? 'project');
  // Land on the machine page that actually shows the restored part.
  if (camMode) await useCamStore.getState().setPage(camMode);
  // Whatever was in the app before is now this project — any earlier draft is
  // stale. (Restoring the draft itself comes through here too, which is fine:
  // it has been consumed.)
  clearDraft();
  return project;
}

/**
 * Apply a project file to the app. Throws with a user-facing message if the file
 * isn't one of ours (see `parseProject`).
 */
export async function openProjectFile(file) {
  return applyProject(parseProject(await file.text()));
}
