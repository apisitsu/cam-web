/**
 * Loads OpenCascade's STEP/IGES reader (`occt-import-js`, LGPL-2.1, wasm), once,
 * the first time a STEP or IGES part is opened — it is 7.6 MB and nothing else
 * needs it.
 *
 * This file differs between cam-web and EngineerSystem, like `manifoldLoader.js`:
 * here vite bundles the glue and `?url` gives the wasm's address; EngineerSystem
 * serves both from `public/wasm/`. Under Node — the tests — the package finds its
 * own wasm next to itself.
 */
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';

let ready = null;

/** The initialised reader: `{ ReadStepFile, ReadIgesFile, ... }`. */
export function loadOcct() {
  ready ??= (async () => {
    const mod = await import('occt-import-js');
    const occtimportjs = mod.default ?? mod;
    const node = typeof process !== 'undefined' && Boolean(process.versions?.node);
    return occtimportjs(node ? {} : { locateFile: () => wasmUrl });
  })();
  return ready;
}
