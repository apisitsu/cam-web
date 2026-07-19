/**
 * Browser side of saving and opening work: gathers state from the stores, writes
 * a file, and applies a file back. Kept out of the stores so neither has to know
 * about the other (a project spans both camStore and sketchStore) and out of the
 * engine so the format layer stays DOM-free.
 */
import { useCamStore } from '../stores/camStore.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { serialize as serializeSketch } from '../engine/sketch/model.js';
import { sketchToDxf, sketchHasGeometry } from '../engine/sketch/dxf.js';
import {
  buildProject, serializeProject, parseProject, projectFileName,
} from '../engine/projectFile.js';

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
  const blob = new Blob([text], { type: 'application/octet-stream' });
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

/** Save just the G-code, for handing the program to a machine or another CAM. */
export async function saveGcode() {
  const cam = useCamStore.getState();
  const name = cam.fileName && /\.[^.\\/]+$/.test(cam.fileName) ? cam.fileName : `${cam.fileName || 'program'}.nc`;
  return saveTextFile(name, cam.gcode || '', {
    description: 'G-code program',
    accept: { 'text/plain': ['.nc', '.gcode', '.tap', '.ngc', '.txt'] },
  });
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
 * Apply a project file to the app: program, setup, then sketch. Throws with a
 * user-facing message if the file isn't one of ours (see `parseProject`).
 */
export async function openProjectFile(file) {
  const project = parseProject(await file.text());
  const cam = useCamStore.getState();
  // Settings first, so the parse below runs with the right machine mode.
  if (Object.keys(project.settings).length) cam.setTool(project.settings);
  if (project.sketch) useSketchStore.getState().loadSerialized(project.sketch);
  await cam.parse(project.gcode, project.fileName ?? 'project');
  return project;
}
