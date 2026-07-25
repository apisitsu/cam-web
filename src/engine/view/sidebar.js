/**
 * What the sidebar shows — setup vs. run.
 *
 * The sidebar carries everything needed to *prepare* a job: the file buttons, the
 * CAM planner, the machine settings, the tool table, the stock definition. All of
 * it is dead weight the moment the program is actually running, and it pushes the
 * one panel that IS live — the program listing, which scrolls to the executing
 * line — down the page and out of sight.
 *
 * So pressing Play collapses the sidebar to the program alone, and pausing brings
 * the setup back. Nothing is destroyed; a section that is hidden is only hidden.
 *
 * The one exception is the parse error. A failure must never be suppressed by a
 * mode change — if the program cannot be read, that is the most important thing
 * on screen whatever the machine is doing.
 *
 * Pure. No React, no store.
 */

/** Every collapsible block in the sidebar, top to bottom. */
export const SECTIONS = [
  'files',     // Parse / Open file / Sample
  'project',   // Save & open project, save G-code, the drag-and-drop hint
  'cam',       // the CAM-from-a-model panel
  'program',   // the program listing — the live one
  'errors',    // parse failure
  'machine',   // rapid rate, lathe diameter switch
  'stats',     // cycle time and lengths
  'warnings',  // interpreter warnings
  'tools',     // the tool table
  'removal',   // material-removal / simulate controls
];

/** What survives while the program runs. */
export const RUN_SECTIONS = ['program', 'errors'];

/**
 * Which sidebar sections are on screen.
 *
 * @param {{playing?: boolean}} state
 * @returns {Record<string, boolean>} keyed by the names in `SECTIONS`
 */
export function sidebarSections({ playing = false } = {}) {
  const out = {};
  for (const name of SECTIONS) {
    out[name] = playing ? RUN_SECTIONS.includes(name) : true;
  }
  return out;
}

/**
 * Is the sidebar in its stripped-down running state?
 *
 * Exposed separately so the view can say so — a panel that silently loses most of
 * its contents reads as a bug, and the operator should be told it comes back.
 */
export function isRunMode({ playing = false } = {}) {
  return playing;
}
