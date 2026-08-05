/**
 * Browser side of saving and opening work: gathers state from the stores, writes
 * a file, and applies a file back. Kept out of the stores so neither has to know
 * about the other (a project spans both camStore and sketchStore) and out of the
 * engine so the format layer stays DOM-free.
 */
import { useCamStore } from '../stores/camStore.js';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { serialize as serializeSketch } from '../engine/sketch/model.js';
import { sketchToDxf, sketchHasGeometry } from '../engine/sketch/dxf.js';
import {
  buildProject, serializeProject, parseProject, projectFileName, programFileName,
} from '../engine/projectFile.js';

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
  const sk = useSketchStore.getState().sk;
  return buildProject({
    gcode: cam.gcode || '',
    fileName: cam.fileName || null,
    // An untouched sketch (origin only) is not worth saving as content, but it
    // costs nothing and keeps "open" symmetric, so it goes in as-is.
    sketch: sk ? serializeSketch(sk) : null,
    settings: cam,
    // The whole STL→plan setup: part, machine, material, origin, operations.
    // Null when nothing is imported, so a bare sketch/program stays a v1-shaped
    // project with no `cam` block.
    cam: useCamPlanStore.getState().serializeSetup(),
  });
}

/** Save the whole project (program + setup + sketch). Returns the file name. */
export async function saveProject() {
  const cam = useCamStore.getState();
  return saveTextFile(
    projectFileName(cam.fileName),
    serializeProject(currentProject()),
    { description: 'cam-web project', accept: { 'application/json': ['.json'] } },
  );
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
  if (project.sketch) useSketchStore.getState().loadSerialized(project.sketch);
  await cam.parse(project.gcode, project.fileName ?? 'project');
  // Land on the machine page that actually shows the restored part.
  if (camMode) await useCamStore.getState().setPage(camMode);
  return project;
}

/**
 * Apply a project file to the app. Throws with a user-facing message if the file
 * isn't one of ours (see `parseProject`).
 */
export async function openProjectFile(file) {
  return applyProject(parseProject(await file.text()));
}
