/**
 * @vitest-environment jsdom
 *
 * End-to-end check that an imported STL actually reaches the screen.
 *
 * `PartMesh.test.jsx` proves the component builds geometry when handed a loaded
 * mesh. That is not the same as proving the app *shows* it: the part still has
 * to survive the page gate, the props App passes, and the camera framing. The
 * original bug was precisely a wiring gap — the store held the mesh, the
 * filename appeared in the header, and nothing was ever mounted to draw it — so
 * these tests mount `Viewport` the way `App` mounts it and look for the mesh in
 * the real scene graph.
 *
 * `@react-three/test-renderer` builds that graph without WebGL, which is as
 * close to a browser as this environment gets.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import { SceneContents } from './Viewport.jsx';
import { useCamPlanStore, getMesh } from '../stores/camPlanStore.js';
import { useCamStore } from '../stores/camStore.js';
import { boundsOf } from '../engine/mesh/analyze.js';
import { fitBoundsForPart } from '../engine/view/setup.js';
import { framing } from '../engine/view/camera.js';
import { box } from '../engine/mesh/fixtures.js';

const store = () => useCamPlanStore.getState();

/** A binary-STL File-alike, as a drop would deliver it. */
function stlFile(soup, name = 'part.stl') {
  const buf = new ArrayBuffer(84 + soup.triangleCount * 50);
  const view = new DataView(buf);
  view.setUint32(80, soup.triangleCount, true);
  let o = 84;
  for (let t = 0; t < soup.triangleCount; t++) {
    o += 12;
    for (let v = 0; v < 9; v++) { view.setFloat32(o, soup.positions[t * 9 + v], true); o += 4; }
    o += 2;
  }
  return { name, arrayBuffer: async () => buf };
}

/** The user's real fork model, when it is present in the working tree. */
const FORK = 'image_tool/FORK_DRAFT_4.stl';
function forkFile() {
  if (!existsSync(FORK)) return null;
  const b = readFileSync(FORK);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return { name: 'FORK_DRAFT_4.stl', arrayBuffer: async () => ab };
}

/** Mount the viewport's scene with the props App feeds it on the Milling page. */
function mount(extra = {}) {
  const { partBounds, ...props } = extra;
  return ReactThreeTestRenderer.create(
    <SceneContents
      bounds={null}
      turnChuck={null}
      showStock
      toolPos={null}
      bufVer={0}
      drawVer="0:0"
      partVer={store().meshVer}
      showPart
      mode="mill"
      sketching={false}
      {...props}
    />,
  );
}

/**
 * The imported model in the scene, found by name.
 *
 * Matching on "a mesh with lots of vertices" is not enough — the sketch layer's
 * own markers are meshes too, and that made the sketch-page test pass a part
 * that was not there.
 */
function partMeshes(renderer) {
  // eslint-disable-next-line testing-library/await-async-query
  return renderer.scene.findAllByType('Mesh').filter((m) => m.instance.name === 'imported-part');
}

describe('Viewport — imported part is on screen', () => {
  beforeEach(() => { store().clear(); });

  it('shows nothing before an import', async () => {
    const r = await mount();
    expect(partMeshes(r)).toHaveLength(0);
  });

  it('draws the model once an STL is imported', async () => {
    await store().loadStl(stlFile(box(20, 30, 10)));
    const r = await mount();
    expect(partMeshes(r).length).toBeGreaterThan(0);
  });

  it('does not draw it on the Sketch page', async () => {
    // The sketch page is a design surface, not a machining view.
    await store().loadStl(stlFile(box(20, 30, 10)));
    const r = await mount({ sketching: true });
    expect(partMeshes(r)).toHaveLength(0);
  });

  it('draws it on the Turning page too', async () => {
    await store().loadStl(stlFile(box(20, 30, 10)));
    const r = await mount({ mode: 'turn' });
    expect(partMeshes(r).length).toBeGreaterThan(0);
  });

  it('honours the Part toggle', async () => {
    await store().loadStl(stlFile(box(20, 30, 10)));
    const r = await mount({ showPart: false });
    expect(partMeshes(r)).toHaveLength(0);
  });
});

describe('Viewport — the real FORK_DRAFT_4 model', () => {
  beforeEach(() => { store().clear(); });

  it('loads, and lands in the scene with its true size', async () => {
    const file = forkFile();
    if (!file) return; // the working file is not tracked; skip when absent
    const analysis = await store().loadStl(file);
    expect(analysis).toBeTruthy();
    expect(analysis.triangleCount).toBeGreaterThan(15000);

    const r = await mount({ partBounds: analysis.bounds });
    const meshes = partMeshes(r);
    expect(meshes).toHaveLength(1);

    // The geometry in the scene must span the model the analysis measured — a
    // mesh that renders at the wrong scale is as invisible as one that does not
    // render at all.
    const geo = meshes[0].instance.geometry;
    expect(geo.getAttribute('position').count).toBe(analysis.triangleCount * 3);
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    expect(bb.max.z - bb.min.z).toBeCloseTo(analysis.bounds.size[2], 1);
    expect(bb.max.x - bb.min.x).toBeCloseTo(analysis.bounds.size[0], 1);
  });

  it('is framed by a camera that can actually see it', async () => {
    const file = forkFile();
    if (!file) return;
    const analysis = await store().loadStl(file);
    // The failure this guards against is a part that renders correctly but off
    // screen, which looks exactly like a part that never rendered.
    const fit = fitBoundsForPart('mill', analysis.bounds);
    const f = framing('mill', 'iso', fit, { width: 1200, height: 800 });
    expect(f.zoom).toBeGreaterThan(0);
    expect(Number.isFinite(f.zoom)).toBe(true);
    // At this zoom the part's longest side must fall inside the canvas.
    const longest = Math.max(...analysis.bounds.size);
    expect(longest * f.zoom).toBeLessThanOrEqual(1200);
    expect(longest * f.zoom).toBeGreaterThan(100); // and not a speck
    expect(f.center.every(Number.isFinite)).toBe(true);
  });

  it('stays on screen after planning lays it down', async () => {
    const file = forkFile();
    if (!file) return;
    await store().loadStl(file);
    const plan = await store().makePlan();
    expect(plan.mode).toBe('mill');
    expect(plan.orientation.changed).toBe(true);

    // The cached mesh must have followed the plan, and still render.
    expect(boundsOf(getMesh().soup).size[2]).toBeCloseTo(plan.orientation.depth, 1);
    const r = await mount({ partBounds: store().analysis.bounds });
    expect(partMeshes(r)).toHaveLength(1);
  });
});

describe('the reported journey, end to end', () => {
  beforeEach(() => {
    store().clear();
    useCamStore.setState({ page: 'sketch', mode: 'mill', gcode: '' });
  });

  it('open the app, drop FORK_DRAFT_4.stl, and the part is on screen', async () => {
    const file = forkFile();
    if (!file) return;

    // 1. The app opens on Sketch, where nothing machining-related is shown.
    expect(useCamStore.getState().page).toBe('sketch');

    // 2. The file is dropped. This is what App's onDrop does with a .stl.
    const analysis = await store().loadStl(file);
    expect(store().stlName).toBe('FORK_DRAFT_4.stl');

    // 3. The app has moved to the machine the part suits — previously it stayed
    //    on Sketch, where the import was invisible in every sense.
    expect(useCamStore.getState().page).toBe('mill');

    // 4. The part is in the scene, at full size.
    const r = await mount({
      mode: useCamStore.getState().page,
      sketching: false,
      partVer: store().meshVer,
    });
    const meshes = partMeshes(r);
    expect(meshes).toHaveLength(1);
    meshes[0].instance.geometry.computeBoundingBox();
    const bb = meshes[0].instance.geometry.boundingBox;
    expect(bb.max.z - bb.min.z).toBeCloseTo(66.55, 1);

    // 5. And the camera is pointed at it.
    const f = framing('mill', 'iso', fitBoundsForPart('mill', analysis.bounds), { width: 1200, height: 800 });
    expect(66.55 * f.zoom).toBeGreaterThan(100);
    expect(66.55 * f.zoom).toBeLessThan(1200);
  });
});
