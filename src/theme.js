/**
 * CAD — the one palette this module paints with.
 *
 * The colours are a **light mechanical-CAD** scheme, the tone SolidWorks and
 * CATIA V5 have used for twenty years: silver-gray chrome, white paper for
 * anything you read, one blue accent, and a viewport that fades from a slate
 * blue at the horizon to near-white at the floor. That gradient is the single
 * most recognisable thing about either package, and it is also the reason the
 * scheme is light rather than dark — a part lit from above reads its own shape
 * against a light ground, where on the old near-black one every unlit face went
 * to the same flat void.
 *
 * Everything that was a hard-coded slate hex now comes from here. Two rules keep
 * it that way:
 *
 *  1. **Chrome imports these tokens; the scene does not.** Panels, rails, text
 *     and overlays are UI and must move together, so they name a token. The
 *     `meshStandardMaterial` colours in `Viewport.jsx` / `PartMesh.jsx` are
 *     *materials* — steel, brass, carbide — lit by real lights, and a theme
 *     token would say nothing true about them. They stay literal.
 *  2. **A colour that carries meaning keeps its meaning.** `feed`/`rapid` are the
 *     backplot's green/red and the legend in the header reads from the same two
 *     tokens, so the two can never drift. Same for the sketch states below.
 *
 * The sketch colours follow SolidWorks' own convention rather than being picked
 * to look nice, because an operator who knows SolidWorks already reads them:
 * blue is under-defined, black is fully defined, red is over-defined, and the
 * pre-select highlight is orange.
 */
export const CAD = {
  // ---- chrome -------------------------------------------------------------
  appBg: '#dce1e7',        // the window behind the panels
  headerBg: '#eceff3',     // command bar
  panelBg: '#f4f6f8',      // sidebar / feature tree
  surface: '#ffffff',      // paper: the program listing, cards
  raised: '#e6eaef',       // input addons, inert fills
  selected: '#cde2f7',     // a picked row (SolidWorks' selection blue)
  border: '#b7c0ca',
  borderSoft: '#d5dbe1',

  // ---- type ---------------------------------------------------------------
  text: '#16202b',         // what you are meant to read
  icon: '#3c4753',         // idle glyph on a toolbar button
  label: '#47535f',        // the name of a field
  muted: '#69737e',        // secondary
  dim: '#75808b',          // hints and footnotes

  // ---- accent -------------------------------------------------------------
  accent: '#1668c4',
  accentSoft: '#dbeafe',   // the executing line, a drop target

  // ---- floating over the viewport ----------------------------------------
  // Translucent so the model still shows through the readout, opaque where a
  // panel is being typed into and the text has to stay legible.
  glass: 'rgba(247,249,251,0.90)',
  glassSolid: 'rgba(247,249,251,0.97)',

  // ---- the scene's own two signals ---------------------------------------
  feed: '#15803d',         // cutting moves
  rapid: '#c81e1e',        // traverses

  // ---- viewport -----------------------------------------------------------
  // A CSS gradient, applied to the <Canvas> element itself rather than to a
  // three.js scene background: it costs no draw call and keeps the WebGL clear
  // colour transparent.
  viewport: 'linear-gradient(180deg,#8aa6c4 0%,#b7c9da 45%,#dfe7ee 78%,#f2f5f8 100%)',
  sceneLine: '#5b6b7b',    // spindle centreline, origin axes

  // ---- sketcher (SolidWorks' state colours) -------------------------------
  skUnder: '#1849c9',      // under-defined geometry
  skFull: '#101418',       // fully defined
  skOver: '#d02020',       // over-defined
  skSelected: '#0f9d0f',   // selected
  skHover: '#e07000',      // pre-select highlight
  skConstruction: '#6b7684',
  skDim: '#1f2937',        // placed dimensions
  skDriven: '#6d28d9',     // a driven (reference) dimension
  skAxis: '#0e7490',       // angle-lock guide axis / angle base line
  skTangent: '#0f9d58',
  skSnap: '#c026d3',
  skIntersect: '#ca8a04',  // snap to where two curves cross
  skQuadrant: '#7c3aed',   // snap to a circle/arc quadrant (top/bottom/left/right)
  skMidpoint: '#0284c7',   // snap to a line-segment midpoint
  skPreview: '#c2410c',    // rubber band while drawing
};

/**
 * Shading for the machine's own metal — the tool, the holder, the chuck.
 *
 * `meshStandardMaterial` is physically based, and a physically based metal has
 * **no diffuse colour**: it is entirely reflection. This scene has no
 * environment map (drei's `<Environment>` fetches an HDR from a CDN, which the
 * hosts this runs on cannot reach), so a mesh at metalness 0.6–0.75 has almost
 * nothing to reflect and renders near-black whatever colour it was given. That
 * went unnoticed against the old near-black viewport — a dark tool on a dark
 * ground still read as a tool. On the light one the same mesh is a brown smudge.
 *
 * So the metals here are *shaded*, not simulated: mostly diffuse, with enough
 * metalness left for a highlight to travel along the shank as the view orbits.
 * That is what SolidWorks and CATIA draw by default too.
 *
 * @param {string} color the metal's own colour — steel, brass, carbide
 * @param {number} [roughness] lower is glossier; the default suits a ground shank
 */
export const metal = (color, roughness = 0.42) => ({
  color, metalness: 0.2, roughness,
});

export default CAD;
