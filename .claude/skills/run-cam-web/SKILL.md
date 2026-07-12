---
name: run-cam-web
description: Run, build, test, and drive the cam-web browser CAD/CAM app. Use to launch the Vite dev server, run the G-code engine, render a toolpath backplot to SVG, or take a "screenshot" of the geometry when asked to run/start/build/test/screenshot cam-web.
---

# Run cam-web

cam-web is a browser CAD/CAM app: a Vite + React 19 + R3F viewport over a
**pure-JS G-code engine** (tokenize → interpret → tessellate → dexel/voxel
material-removal sim). The engine has **zero dependencies** and runs under plain
Node — that is the surface you actually drive here.

**This environment has no browser/WebGL render** (no chromium-cli, no
Playwright), so the R3F viewport cannot be screenshotted. The agent path is
therefore: drive the engine directly with **`driver.mjs`**, which parses G-code
through the real engine and renders the resulting toolpath to an **SVG on disk**
you can look at. For geometry/3D-marker changes specifically, see the
`svg-preview-loop-for-3d-marker` memory (same idea, silhouette maths).

All commands below were run from the repo root (`D:\Projects\cam-web`) on
Windows (Git Bash / PowerShell). Paths are relative to that root.

## Prerequisites

- **Node.js 18+** (verified on v22.22.0). No `apt-get` — this is a Windows host.
- Dependencies installed (`node_modules/` present). A fresh clone needs
  `npm install`, which per the README **requires corporate-proxy network
  access** to resolve vite/react/three/antd. The engine + `driver.mjs` need
  none of that — they are dependency-free and run immediately.

## Run (agent path) — drive the engine + render a backplot

```bash
node .claude/skills/run-cam-web/driver.mjs
```

Drives the real engine on a built-in sample program and writes
`image_tool/driver-backplot.svg`. Verified output:

```
rapid segs : 4
feed segs  : 53
bounds     : X[0.0,50.0] Y[0.0,40.0] Z[-2.0,5.0]
stats      : {"mode":"mill",...,"cycleTime":38.1,...}
svg        : D:\Projects\cam-web\image_tool\driver-backplot.svg
OK
```

Point it at a real program, or choose the output path:

```bash
node .claude/skills/run-cam-web/driver.mjs path/to/program.nc --out image_tool/mine.svg
```

Inspect the SVG: feeds are cyan, rapids dashed grey, XY top view. To *view* it,
send it to the user to render (this host cannot rasterize SVG→PNG) or trace the
path coordinates against the program. To confirm success programmatically,
check the printed segment counts/bounds and the `OK` line (exit 0; exit 1 if the
engine emitted no motion).

## Test

```bash
node --test src/engine/gcode/_node_check.mjs src/engine/sim/_node_check.mjs src/engine/sim/turning_check.mjs src/engine/sim/voxel_check.mjs src/engine/playback_check.mjs
```

Dependency-free engine checks — verified **47 pass**. This is the fast inner
loop; it needs no `node_modules`.

```bash
npx vitest run
```

Full vitest suite — verified **59 pass** (needs `node_modules`).

```bash
npx vite build
```

Production bundle — verified green (workers split into own chunks;
`index.js` ~1.74 MB).

## Run (human path) — the actual web UI

```bash
npm run dev
```

Starts Vite on **http://localhost:3100** (port set in `vite.config.js`).
Verified serving HTTP 200 — `curl http://localhost:3100/` returns the app
shell and `src/main.jsx` resolves. **Useless headless**: the R3F viewport is
WebGL and renders nothing without a real browser + GPU. Open the URL in a
desktop browser to see the backplot, playback slider, and drag-and-drop
G-code loading. Ctrl-C to stop.

## Gotchas

- **No screenshot of the viewport is possible here.** WebGL needs a real
  browser; none is available. Verify visual/geometry work through the
  `driver.mjs` SVG backplot or the `svg-preview-loop-for-3d-marker` pattern,
  not a browser capture.
- **Port 3100 may already be in use** by a running dev server; `vite` silently
  falls back to 3101 and prints the real port. Check the startup log, don't
  assume 3100.
- **`npm install` needs the corporate proxy.** If deps are missing and the
  network can't resolve, you can still run `driver.mjs` and the
  `node --test` engine checks — they are pure JS.
- **Engine output is millimetres, always.** G20 (inch) input is normalised to
  mm internally, so `bounds`/`stats` from the driver are in mm regardless of
  the program's units.
- **Large typed arrays must not cross into React/R3F props** (documented
  invariant in `docs/ARCHITECTURE.md` — the `DataCloneError` fix). The engine
  returns `Float32Array`s; the driver reads them directly in Node, which is
  fine, but UI code passes them via workers, not props.

## The driver

`.claude/skills/run-cam-web/driver.mjs` — imports the real
`src/engine/gcode/index.js`, calls `parseGcode()`, prints segment
counts/bounds/stats, and renders an XY-top-view SVG backplot. Extend it (side
view, sim height field, a specific program) rather than writing ad-hoc scripts.
