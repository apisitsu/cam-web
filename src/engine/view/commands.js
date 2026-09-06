/**
 * The command catalogue — every toolbar button's name and what it does.
 *
 * The panels used to label their buttons in place: `<Button>Auto-plan</Button>`,
 * `<Button>Verify in viewport</Button>`. That reads fine in a wide sidebar and
 * badly everywhere else — the row wraps, the CAM panel grows a column of
 * sentences, and two buttons that do related things end up described in
 * unrelated words because nobody was looking at them side by side.
 *
 * SolidWorks answers this the way every CAD toolbar does: the button is a
 * **symbol**, and hovering it names it. Nothing on the toolbar is spelled out;
 * everything on it is identified on demand. That is the whole convention being
 * followed here, and it only works if two things are guaranteed for every
 * single button:
 *
 * 1. it has a **name** — otherwise a screen reader, and anyone who does not
 *    recognise the glyph, gets a button that announces itself as nothing;
 * 2. it has a **hint** that says something the name did not — a hint reading
 *    "Auto-plan" for a button whose name is already "Auto-plan" is a hint that
 *    was never written.
 *
 * **The hint is not rendered.** `CommandButton`'s tooltip is the name alone: a
 * rail of a dozen glyphs where every hover opens a paragraph is a rail you read
 * instead of use, and what a hover is for is *which button is this*. The hint
 * stays required because writing one is what forces an author to be able to say
 * what a button is for — it is the catalogue's documentation of intent, and the
 * place to look when a glyph's purpose is genuinely unclear.
 *
 * Neither can be checked by looking at JSX, which is why the catalogue is data
 * and lives here: `commands.test.js` holds every entry to both rules at once.
 * The components map an id to a glyph and render `label` as the `aria-label` and
 * the tooltip's title, so the name a user hears and the name a user reads are
 * the same string by construction.
 *
 * `keepsText` is the deliberate exception, and it is short on purpose. A button
 * keeps its words when it is not really a toolbar button at all — a menu that
 * drops open, or a primary commit at the end of a panel where a bare glyph
 * would read as decoration. Every entry carries the reason, so adding another
 * one is an argument someone has to make rather than a default to drift into.
 *
 * Pure data + pure lookups: no React, no antd, no icons.
 */

/**
 * @typedef {object} Command
 * @property {string} id      stable key; also the `data-cmd` the tests query
 * @property {string} group   which rail/panel it belongs to
 * @property {string} label   the command's name — `aria-label` and tooltip title
 * @property {string} hint    one line of description, shown under the name
 * @property {string} [keepsText] why this one still renders its label
 */

/** @type {Command[]} */
export const COMMANDS = [
  // ---- Program: loading and reading a .nc ---------------------------------
  {
    id: 'parse', group: 'program', label: 'Parse',
    hint: 'Read the program in the editor and rebuild the backplot',
  },
  {
    id: 'openProgram', group: 'program', label: 'Open program',
    hint: 'Load a .nc / .gcode / .tap file from disk',
  },
  {
    id: 'sample', group: 'program', label: 'Load sample',
    hint: 'Replace the editor with a worked example for this machine mode',
  },

  // ---- Keeping and handing on work ---------------------------------------
  //
  // Saving to a FILE is not on this rail. The library keeps the same session on
  // the server under a name, with no dialog and no folder to find again, and a
  // rail carrying both ways to do one job is a rail on which nobody is sure
  // which one they used. A .camweb.json still opens by dropping it on the
  // window, which is how every other file gets in.
  {
    id: 'openLibrary', group: 'project', label: 'Library',
    hint: 'Your own saved work, and the shelf everyone shares. Save, open, share or delete it',
  },
  {
    id: 'exportGcode', group: 'project', label: 'Export G-code',
    hint: 'Download the program on its own as a .nc, to hand on to a machine',
  },

  // ---- Material removal ---------------------------------------------------
  {
    id: 'simulate', group: 'sim', label: 'Simulate',
    hint: 'Carve the Z-up height field — scrub-able with playback',
  },
  {
    id: 'simulateFaces', group: 'sim', label: 'Simulate all faces',
    hint: 'Multi-axis: carve every rotary face and every tool into one voxel block',
  },
  {
    id: 'simulateUndercut', group: 'sim', label: 'Simulate the undercut',
    hint: 'This cutter leaves a roof over its groove — carve it as voxels, which can hold one',
  },
  {
    id: 'simulateTurning', group: 'sim', label: 'Simulate turning',
    hint: 'Turn a raw bar down to the programmed profile, sharp corner, following the tool path',
  },
  {
    id: 'simulateVoxel', group: 'sim', label: 'Voxel simulation',
    hint: 'Force the voxel sim — all faces and undercuts — at the resolution beside it',
  },
  {
    id: 'toolFallback', group: 'sim', label: 'Set the cutter by hand',
    hint: 'Size the sim cutter yourself, for a program that names no tool',
  },
  {
    id: 'fitStock', group: 'sim', label: 'Fit stock to the program',
    hint: 'Fill the billet with a size the whole toolpath sits inside',
  },
  {
    id: 'stockEnabled', group: 'sim', label: 'Use this stock',
    hint: 'Draw and carve the billet stated here, instead of one fitted to the toolpath',
  },

  // ---- CAM: from a model to a program -------------------------------------
  {
    id: 'importPart', group: 'cam', label: 'Import part',
    hint: 'Load an .stl / .obj / .ply model to plan a job from',
  },
  {
    id: 'autoPlan', group: 'cam', label: 'Auto-plan',
    hint: 'Replace everything with an automatic plan for the whole part',
  },
  {
    id: 'exportNc', group: 'cam', label: 'Export NC',
    hint: 'Write the generated program out as a .nc file',
  },
  {
    id: 'verifyInViewport', group: 'cam', label: 'Verify in viewport',
    hint: 'Load the generated program into the backplot and simulator',
  },

  // ---- Recipe: the ordered operations -------------------------------------
  {
    id: 'addOperation', group: 'recipe', label: 'Add operation',
    hint: 'Append an operation to the end of the list',
    // A menu, not a button: it drops open on a list of operation kinds, and a
    // bare glyph gives no clue that anything is behind it.
    keepsText: 'opens a dropdown of operation kinds',
  },
  {
    id: 'resetRecipe', group: 'recipe', label: 'Reset operations',
    hint: "Discard the edits and take the planner's proposal again",
  },
  {
    id: 'moveStepUp', group: 'recipe', label: 'Move up',
    hint: 'Run this operation earlier in the program',
  },
  {
    id: 'moveStepDown', group: 'recipe', label: 'Move down',
    hint: 'Run this operation later in the program',
  },
  {
    id: 'removeStep', group: 'recipe', label: 'Delete operation',
    hint: 'Drop this operation from the program',
  },

  // ---- Picking a feature to machine ---------------------------------------
  {
    id: 'addFaceOp', group: 'pick', label: 'Clear this face',
    hint: 'Add a facing operation that clears the picked face',
  },
  {
    id: 'addEdgeOp', group: 'pick', label: 'Trace this edge',
    hint: 'Add a contour that follows the picked edge at the depth beside it',
  },
  {
    id: 'clearSelection', group: 'pick', label: 'Clear selection',
    hint: 'Deselect the picked face or edge',
  },

  // ---- Origin and the rotary ----------------------------------------------
  {
    id: 'pickA0Face', group: 'datum', label: 'Pick A0 face',
    hint: 'Click the face that should be up, facing the spindle, when the table reads zero',
  },
  {
    id: 'clearA0Face', group: 'datum', label: 'Reset A0',
    hint: 'Go back to the A0 the part was modelled at',
  },
  {
    id: 'pickRotaryCentre', group: 'datum', label: 'Pick A-axis centre',
    hint: "Click a point on the part that sits on the rotary's centreline",
  },
  {
    id: 'clearRotaryCentre', group: 'datum', label: 'Reset A-axis centre',
    hint: "Pivot about the frame's own origin again",
  },
  {
    id: 'clearDatum', group: 'datum', label: 'Reset origin',
    hint: 'Put X0, Y0 and Z0 back on the model as it was imported',
  },

  // ---- The program text ---------------------------------------------------
  {
    id: 'editGcode', group: 'gcode', label: 'Edit program',
    hint: 'Swap the highlighted listing for a text box you can type in',
  },
  {
    id: 'viewGcode', group: 'gcode', label: 'View program',
    hint: 'Go back to the listing that highlights the line running now',
  },
  {
    id: 'resetTool', group: 'gcode', label: 'Reset tool',
    hint: 'Drop the edits and use the size detected from the program again',
  },

  // ---- What the viewport draws --------------------------------------------
  {
    id: 'fitView', group: 'view', label: 'Fit to view',
    hint: 'Frame the part and toolpath in the window',
  },
  {
    id: 'showPart', group: 'view', label: 'Show part',
    hint: 'Draw the imported model — hide it to see a toolpath that runs inside it',
  },
  {
    id: 'showStock', group: 'view', label: 'Show stock',
    hint: 'Draw the billet and the carved block — hide it to watch the toolpath alone',
  },
  {
    id: 'showArbor', group: 'view', label: 'Show holder',
    hint: 'Draw the collet above the cutter — hide it to see the cut it covers',
  },
  {
    id: 'showToolpath', group: 'view', label: 'Show toolpath',
    hint: 'Draw the programmed moves — hide them to see the cut surface alone',
  },
  {
    id: 'rotateWork', group: 'view', label: 'Rotate work',
    hint: 'Turn the workpiece under an upright spindle, the way the rotary table does',
  },

  // ---- Playback -----------------------------------------------------------
  {
    id: 'restart', group: 'playback', label: 'Restart',
    hint: 'Send the playhead back to the first block',
  },
  {
    id: 'stepBack', group: 'playback', label: 'Single block back',
    hint: 'Return to the start of the block that just ran, to watch it again',
  },
  {
    id: 'play', group: 'playback', label: 'Cycle start',
    hint: 'Run the program from the playhead',
  },
  {
    id: 'pause', group: 'playback', label: 'Feed hold',
    hint: 'Stop where it is, leaving the playhead in place',
  },
  {
    id: 'stepForward', group: 'playback', label: 'Single block',
    hint: 'Run one source line and stop, so an arc steps as the one move it was written as',
  },
];

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

/**
 * Look a command up. Throws on an unknown id rather than returning undefined:
 * a typo'd id would otherwise render a button with no name and no tooltip,
 * which is precisely the state this module exists to make impossible.
 */
export function command(id) {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`Unknown command id: ${id}`);
  return c;
}

/** Every command in one rail, in catalogue order. */
export function commandsIn(group) {
  return COMMANDS.filter((c) => c.group === group);
}

/** The ids that still render their label, with the reason each one does. */
export function labelledCommands() {
  return COMMANDS.filter((c) => c.keepsText);
}

/**
 * What a button announces itself as — to a screen reader, and in a test.
 *
 * The same string the tooltip titles, so there is one name per command and no
 * way for the two to drift apart.
 */
export function ariaLabel(id) {
  return command(id).label;
}
