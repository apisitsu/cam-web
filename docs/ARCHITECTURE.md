# CAM Web — Architecture

Companion to the upstream spec `../cam_web.txt`. This document describes the
**actual, current** implementation (Phase 0 + Phase 1 + Playback) and the
non-obvious constraints a contributor must respect. Read alongside `README.md`.

---

## Layers

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Presentation      React 19 + Ant Design v5 + React-Three-Fiber            │
│   App.jsx                 shell: editor/loader, controls, playback UI      │
│   components/Viewport.jsx R3F <Canvas> (Z-up machine coords, demand loop)  │
│   components/Backplot.jsx coloured toolpath line segments                  │
│   components/StockMesh.jsx shaded remaining-stock surface                  │
│   components/GcodePanel.jsx numbered editor w/ live active-line highlight  │
├──────────────────────────────────────────────────────────────────────────┤
│ App State         Zustand — thin orchestration only                        │
│   stores/camStore.js      scalars + actions; NO large buffers (see below)  │
│   engine/bufferCache.js   module-level store for the big typed arrays      │
├──────────────────────────────────────────────────────────────────────────┤
│ Engine            Pure JS, zero-dependency, runs under plain Node          │
│   workers/gcode.worker.js  (Comlink) parse → tessellate → pack buffers     │
│   workers/sim.worker.js    (Comlink) stateful dexel material-removal       │
│   engine/gcode/*           tokenizer, arc, interpreter, index, path        │
│   engine/sim/*             dexel, session, mesh                            │
└──────────────────────────────────────────────────────────────────────────┘
```

The engine has **no dependencies on React, three, or the DOM** — everything heavy
(parse/tessellate/carve) runs in a Web Worker so the viewport stays at 60 fps.

---

## Data flow

```
user edits / drops file
        │
   camStore.parse(text)              ── async, off main thread ──►  gcode.worker
        │                                                               │
        │   { rapids, feeds, bounds, stats, path }  ◄────────────────────┘
        │
   setBuffers(...)  → bufferCache._cache          (big Float32Array / Uint32Array)
   set({ bufVer: bufVer + 1, playhead: path.count, ... })   (Zustand: scalars only)
        │
   React re-renders on `bufVer` / `playhead`
        │
   Viewport: getBuf() → slice per playhead → setView(...) → returns `drawVer` token
        │
   <Backplot drawVer=…/> <StockMesh simVer=…/>  read arrays back from the cache
```

`camStore.simulate()` / `carveToPlayhead()` follow the same pattern through
`sim.worker` and write `sim` geometry into the cache.

---

## ⚠️ Critical invariant — never pass large typed arrays as React props

> **Large buffers live in `bufferCache` (and its `_view` slot). React state and
> React props carry only small scalars/tokens (`bufVer`, `simVer`, `drawVer`,
> `playhead`, a 3-number `toolPos`).**

### Why

React 19.2 ships a dev-only **Performance Tracks** feature. On every commit,
`logComponentRender` (react-dom) serialises each component's **changed** props
into the `detail` of a `performance.measure(...)` call, which the browser then
**structured-clones**. The serialiser (`addObjectDiffToProperties` →
`addValueToProperties` → `addObjectToProperties`) walks objects
**element-by-element** down to depth 3. A `Float32Array` gets fully enumerated,
so a toolpath of hundreds of thousands of floats produces an enormous clone and
throws:

```
DataCloneError: Failed to execute 'measure' on 'Performance':
Data cannot be cloned, out of memory.
    at logComponentRender (react-dom …)
```

**React-Three-Fiber bundles its own copy of `react-reconciler`**, which has the
same tracking. So a `<primitive positions={float32array}>` or a `<LineSet
positions={…}>` triggers the identical crash from the R3F chunk (`po → lh → wr`).

During playback the sliced buffers change identity every 40 ms tick, so this
fires continuously and exhausts memory fast.

### The rule in practice

- ✅ Put buffers in `bufferCache` via `setBuffers` / `setView`; read them with
  `getBuf()` / `getView()` inside `useMemo`, keyed on a **scalar** dep.
- ✅ Pass down only tokens: `drawVer` (string), `simVer`/`bufVer` (number),
  `bufKey` (`'rapids'|'feeds'`), `playhead` (number), small fixed-length arrays.
- ❌ Never make a `Float32Array`/`Uint32Array`, or an object/`args` array that
  contains one, a prop of any React **or** R3F component.
- ⚠️ A three.js object prop (`<mesh geometry={g}>`, `<primitive object={o}>`) is
  tolerated because the serialiser is depth-limited (the buffer sits below
  depth 3) — but keep an eye on it.

### Resource disposal

Because playback rebuilds geometry every tick, `Backplot`/`StockMesh` **dispose**
the superseded `THREE.BufferGeometry`/material in a `useEffect` cleanup. Skipping
this leaks GPU/CPU memory and can itself reach OOM over a long run.

---

## Coordinate system

Machine coordinates, **Z up** (`<Canvas camera={{ up: [0,0,1] }}>`). The R3F
`<Grid>` is XZ by default, so it is rotated `+90°` about X to lie on the machine
XY plane. Cylinders (tool/arbor) model along local Y and are rotated `+90°` about
X to stand up in world Z. Everything is millimetres.

---

## Playback model

- `path` (in `bufferCache`) packs every move **in execution order**: 6 floats per
  segment, a `types` byte (0 rapid / 1 feed), a `feedPrefix` count, and a source
  `lines` index.
- `playhead` (0…`path.count`) is the scrub position. `sliceUpTo(path, k)` returns
  the rapids/feeds visible after `k` segments plus the tool-tip position.
- The animation loop is a `setInterval` in `App.jsx` calling `store.step()` +
  `invalidate()` (the canvas uses `frameloop="demand"`).
- **Cut with playback** carves the stock progressively (incremental forward,
  reset-and-recarve backward).

---

## Testing

```
node --test src/engine/gcode/_node_check.mjs   # dependency-free, engine only
npm test                                         # vitest (needs npm install)
```

The engine's Node-runnable tests are the fast feedback loop and require no
browser or bundler.
