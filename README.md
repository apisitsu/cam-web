# CAM Web — Browser-based CAD/CAM

Standalone implementation of the architecture in `../cam_web.txt`. Developed and
tested **outside** EngineerSystem; the intent is to import it into the
EngineerSystem monorepo (as `apps/ENG-CAM`) once it proves out.

## Status — Phase 0 ✅ + Phase 1 ✅ + Playback ✅ (running)

| Layer | State |
|---|---|
| G-code engine (tokenizer → interpreter → tessellation) | ✅ 13/13 vitest + 12/12 node |
| Ordered path + slicing (playback) | ✅ node tests |
| Dexel material-removal engine + stateful session | ✅ node tests |
| Web Workers (Comlink: gcode + stateful sim, off main thread) | ✅ built & bundled |
| Zustand store (orchestration) | ✅ |
| R3F viewport: backplot + shaded stock + tool marker | ✅ builds & serves (localhost:3100) |

**37 tests pass** (24 node + 13 vitest). `vite build` green (workers split into own chunks), dev server HTTP 200.

### Interaction (added for goal "[2]")
- **Load real G-code**: drag-and-drop a `.nc/.gcode/.tap/.ngc/.mpf` file anywhere, or *Open file*.
- **Playback**: slider + play/pause + 0.5–4× speed scrubs the program in execution
  order; a yellow marker tracks the tool tip; only the executed sub-path is shown.
- **Cut with playback**: toggle to carve the stock progressively as the playhead
  moves (incremental forward, reset-and-recarve backward — verified equal to a
  direct carve).
- **Live G-code line highlight**: the program panel numbers each line and
  highlights + auto-scrolls to the line currently executing (mapped via the
  engine's per-segment source-line index). Edit/View toggle keeps it editable.

## Architecture (maps to cam_web.txt layers)

```
Presentation   src/App.jsx, src/components/Viewport.jsx, Backplot.jsx  (React + AntD + R3F)
App State      src/stores/camStore.js                                  (Zustand)
Engine Layer   src/workers/gcode.worker.js  →  src/engine/gcode/*      (Web Worker + Comlink)
```

> **Deeper docs:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — data flow,
> coordinate system, playback model, and the **critical invariant** (never pass
> large typed arrays as React/R3F props — see the `DataCloneError` fix).
> [`docs/CHANGELOG.md`](docs/CHANGELOG.md) — bug-fix log.

The **engine has zero dependencies** — pure JS — so it runs and tests under plain
Node. Everything heavy (parse/tessellate) lives in the worker to keep the
viewport at 60fps, exactly as prescribed in cam_web.txt §2.

### G-code engine (`src/engine/gcode/`)

- `tokenizer.js` — strips `( )` / `;` comments, drops `N` block numbers, emits address words.
- `arc.js` — G2/G3 tessellation in any plane (G17/18/19), I/J/K **and** R forms, full circles, helical Z. CW/CCW radius-arc centre selection is validated against known quarter arcs.
- `interpreter.js` — modal state machine: G0/G1 linear, G2/G3 arcs, G20/21 units, G90/91 distance, canned drilling cycles (G81/82/83/84/85/86/89, G73 peck). G70–G76 turning cycles are recognised and warned (deferred to a later phase — they need a profile).
- `index.js` — packs segments into transferable `Float32Array`s for `THREE.LineSegments`.

Everything is normalised to **millimetres** internally.

## Run

Dependencies (vite/react/three/antd) must be installed in an environment where
the npm proxy resolves. From `D:\Projects\cam-web`:

```
npm install        # needs corporate-proxy network access
npm run dev         # Vite dev server → http://localhost:3100
```

### Tests

```
node --test src/engine/gcode/_node_check.mjs   # dependency-free, runs today
npm test                                         # vitest (after npm install)
```

## Roadmap (from cam_web.txt §5)

| Phase | Deliverable | Kernel? |
|---|---|---|
| **0** | G-code parser + backplot | no — ✅ done |
| **1** | Material removal sim (dexel height field) | no — ✅ done |
| 2 | 2D Sketcher + constraints (planegcs) | partial ← next |
| 3 | 3D modeling extrude/revolve/boolean (OCCT) | yes |
| 4 | CAM Milling 2.5D | yes |
| 5 | CAM Turning (profile cycles) | yes |
| 6 | Post-processor + export | — |
| 7 | Backend: auth, storage, versioning | — |

## Importing into EngineerSystem (later)

EngineerSystem is an npm-workspace monorepo (`apps/*`) already running React 19 +
AntD v5 + R3F + Zustand — the same stack. Planned integration:

1. Move this project to `apps/ENG-CAM` (auto-picked up by the `apps/*` workspace glob).
2. Keep it a **separate app/bundle** so the ~30MB WASM kernels (Phase 3+) never
   bloat ENG-Frontend; embed or lazy-load it behind a route + `ProtectedRoute`.
3. Reuse ENG-Backend (port 2005) for auth + project persistence — the Vite
   `/api` proxy already points there.

A ready, reversible importer is provided (safe by default — needs `--confirm`):

```
node scripts/import-to-engineersystem.mjs --dry-run   # preview
node scripts/import-to-engineersystem.mjs --confirm   # copy to apps/ENG-CAM
```

It only *creates* `apps/ENG-CAM` (never edits existing files) and renames the
package to `eng-cam`. **Not run yet — deferred pending explicit approval.**
