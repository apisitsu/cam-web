# cam-web

Browser-based CAD/CAM. Vite + React 19 + R3F/three, Zustand stores, Comlink
workers, antd UI.

## Engine-first

Build every feature engine-first: **pure logic → test → store → view**. This is
how the gcode parser, the simulator, and the Phase 2 sketcher were all built, and
it is what makes the app verifiable at all — the R3F render and interaction
layers have no automated coverage, so anything that lives only in a component is
effectively untested.

1. **Put the logic in a pure module under `src/engine/`.** Plain functions over
   plain data — no React, no store, no worker, no three.js objects. For the
   sketcher this is `src/engine/sketch/edit.js`: every geometric operation is a
   pure function on a sketch.
2. **Test it before wiring it up.** `npm test` (vitest) alongside the module —
   e.g. `edit.test.js`. WASM/solver-level checks are standalone `*_check.mjs`
   scripts run under node (`planegcs_check.mjs`, `edit_check.mjs`).
3. **Then the store** (`src/stores/`) calls the pure function and owns state,
   history, and worker calls.
4. **Then the view** renders store state and dispatches actions. Keep components
   thin enough that a bug is almost never *in* them.

Corollary: when a change is hard to test, that usually means logic has leaked
upward into the store or a component. Push it back down rather than reaching for
a component test.

### The rule does not stop at the `.jsx` boundary

Most bugs found in the view layer were arithmetic that happened to be sitting in
a component — a camera basis, a marker's Y offset, a chuck size read off the
wrong axis, a playback clock. None of it needed WebGL to catch. If you are about
to verify view-layer behaviour by running a throwaway script, that script is the
test: put the maths in `src/engine/view/` (or `engine/sketch/`) and keep it.

- `engine/view/camera.js` — view directions, screen axes, zoom/standoff framing
- `engine/view/setup.js` — fit box and chuck derived from bounds
- `engine/view/playback.js` — pacing, speeds
- `engine/view/latheTool.js` — tool-marker geometry
- `engine/sketch/annotations.js` — dimension lines and labels

Components then only map that data onto JSX.

## Component tests

What genuinely needs a component is a **render gate** ("does the input appear for
this selection?") or a **render decision** ("is under-defined geometry blue?").
Two harnesses, both in vitest — add `@vitest-environment jsdom` at the top of the
file:

- **`@react-three/test-renderer`** for anything in the R3F scene. It builds the
  real scene graph without WebGL. Assert on materials and counts via
  `node.instance.material.color.getHexString()`. Note drei's `<Html>` labels
  portal out of the scene graph and are **not** visible to it — test their
  content through the pure annotation module instead.
- **`react-dom/client` + `React.act`** for plain DOM components like the toolbar.
  The rail is icon-only, so assert on button counts and rendered glyphs, not
  text. antd `Tooltip` titles only exist on hover — assert the trigger, not the
  message.

## Verifying

`npm test` and `npm run build` are necessary but not sufficient. Draw, select,
constrain, live-solve, and render paths need a real browser — the user verifies
on **localhost:3100**. Say plainly when a change is only test-verified and still
needs a browser look; don't call a UI change confirmed on a green test run.

`/run-cam-web` drives the engine and renders an SVG backplot, which is enough to
confirm geometry without a browser.

## Gotchas

- Subagent git worktrees land in `.claude/worktrees/` (gitignored). **Never
  `git add -A`** while they exist — they get committed as embedded repos. Stage
  explicit paths.
- The browser build must not import `node:*`. Node-only test helpers stay in
  `*_check.mjs`, out of the bundle.
