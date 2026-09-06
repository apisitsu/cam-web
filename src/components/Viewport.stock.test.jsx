/**
 * @vitest-environment jsdom
 *
 * The live stock preview, in the real scene graph.
 *
 * `engine/sim/billet.test.js` proves `billetSolid` turns a box into a centre
 * and a size. That is not the same as proving the viewport *draws* it, and the
 * whole feature is the difference: the point of the preview is that it appears
 * and moves without a simulation running, so a broken prop chain gives back
 * exactly the behaviour it replaced — nothing on screen until Simulate.
 *
 * `@react-three/test-renderer` builds the graph without WebGL.
 */
import { describe, it, expect } from 'vitest';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import { SceneContents } from './Viewport.jsx';
import { billetBox, billetSolid } from '../engine/sim/billet.js';

const BOUNDS = { min: [0, 0, -8], max: [60, 40, 5] };
const solidFor = (size, origin) =>
  billetSolid(billetBox(BOUNDS, size, { origin: origin ?? {} }));

function mount(extra = {}) {
  return ReactThreeTestRenderer.create(
    <SceneContents
      bounds={BOUNDS}
      turnChuck={null}
      showStock
      toolPos={null}
      toolRotary={null}
      toolRadius={3}
      toolType="flat"
      toolLength={0}
      turnInsert={null}
      bufVer={0}
      drawVer="0:0"
      partVer={0}
      showPart={false}
      mode="mill"
      sketching={false}
      {...extra}
    />,
  );
}

// eslint-disable-next-line testing-library/await-async-query
const preview = (r) => r.scene.findAllByType('Group')
  .find((g) => g.instance.name === 'stock-preview')?.instance;

describe('the blank is drawn before anything is carved', () => {
  it('draws nothing without a stock solid', async () => {
    const r = await mount({ stockSolid: null });
    expect(preview(r)).toBeUndefined();
  });

  it('draws the box for a stated billet', async () => {
    const r = await mount({ stockSolid: solidFor({ x: 50, y: 50, z: 28 }, { x: -25, y: -25, z: 0 }) });
    expect(preview(r)).toBeTruthy();
    expect(preview(r).position.toArray()).toEqual([0, 0, 14]);
  });

  it('sizes the box to the stated dimensions, not the toolpath', async () => {
    const r = await mount({ stockSolid: solidFor({ x: 50, y: 50, z: 28 }, { x: -25, y: -25, z: 0 }) });
    // eslint-disable-next-line testing-library/await-async-query
    const mesh = r.scene.findAllByType('Mesh')
      .find((m) => m.instance.name === 'stock-preview-solid');
    const p = mesh.instance.geometry.parameters;
    expect([p.width, p.height, p.depth]).toEqual([50, 50, 28]);
  });

  it('MOVES when the origin moves, with no simulation in between', async () => {
    // The behaviour asked for: type a number, see the block move. If the prop
    // chain breaks, this is the test that says so rather than the screen.
    const size = { x: 50, y: 50, z: 28 };
    const here = await mount({ stockSolid: solidFor(size, { x: -25, y: -25, z: 0 }) });
    const there = await mount({ stockSolid: solidFor(size, { x: 15, y: -25, z: 0 }) });
    // eslint-disable-next-line testing-library/await-async-query
    expect(there.scene.findAllByType('Group')
      .find((g) => g.instance.name === 'stock-preview').instance.position.x
      - preview(here).position.x).toBeCloseTo(40);
  });

  it('resizes when the size changes', async () => {
    const box = async (x) => {
      const r = await mount({ stockSolid: solidFor({ x, y: 50, z: 28 }, { x: 0, y: 0, z: 0 }) });
      // eslint-disable-next-line testing-library/await-async-query
      return r.scene.findAllByType('Mesh')
        .find((m) => m.instance.name === 'stock-preview-solid').instance.geometry.parameters.width;
    };
    expect(await box(50)).toBe(50);
    expect(await box(90)).toBe(90);
  });

  it('picks out the edges as well as the faces', async () => {
    // Faces alone vanish against the backplot running through them.
    const r = await mount({ stockSolid: solidFor({ x: 50, y: 50, z: 28 }) });
    // eslint-disable-next-line testing-library/await-async-query
    const edges = r.scene.findAllByType('LineSegments')
      .find((l) => l.instance.name === 'stock-preview-edges');
    expect(edges).toBeTruthy();
  });

  it('sees through itself — it is measured against what it covers', async () => {
    const r = await mount({ stockSolid: solidFor({ x: 50, y: 50, z: 28 }) });
    // eslint-disable-next-line testing-library/await-async-query
    const mat = r.scene.findAllByType('Mesh')
      .find((m) => m.instance.name === 'stock-preview-solid').instance.material;
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeLessThan(0.5);
    expect(mat.depthWrite).toBe(false);
  });

  it('goes away with the stock switched off in the viewport', async () => {
    const r = await mount({
      stockSolid: solidFor({ x: 50, y: 50, z: 28 }), showStock: false,
    });
    expect(preview(r)).toBeUndefined();
  });

  it('rides the rotary table with the rest of the work', async () => {
    // It is stock on the table, not scenery: in the machine frame it has to
    // turn with everything else the table carries.
    const r = await mount({
      stockSolid: solidFor({ x: 50, y: 50, z: 28 }),
      rotaryFrame: 'machine',
      toolRotary: { a: 90, b: 0 },
    });
    // eslint-disable-next-line testing-library/await-async-query
    const work = r.scene.findAllByType('Group')
      .find((g) => g.instance.name === 'stock-work').instance;
    expect(work.rotation.x).toBeCloseTo(Math.PI / 2);
    expect(preview(r)).toBeTruthy();
  });
});
