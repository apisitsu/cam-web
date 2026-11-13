/**
 * Loads the manifold-3d solid boolean (wasm), once.
 *
 * This file differs between cam-web and EngineerSystem, like `stdApi.js`: here
 * vite emits the wasm as an asset and `?url` gives its address; under CRA there
 * is no `?url` and the glue cannot be bundled, so EngineerSystem serves both from
 * `public/wasm/` (see `scripts/copy-cam-wasm.js`). Under Node — the tests — the
 * package finds its own wasm next to itself.
 */
import wasmUrl from 'manifold-3d/manifold.wasm?url';

let ready = null;

/** The initialised module: `{ Manifold, Mesh, ... }`. */
export function loadManifold() {
  ready ??= (async () => {
    const { default: Module } = await import('manifold-3d');
    const node = typeof process !== 'undefined' && Boolean(process.versions?.node);
    const wasm = await Module(node ? {} : { locateFile: () => wasmUrl });
    wasm.setup();
    return wasm;
  })();
  return ready;
}
