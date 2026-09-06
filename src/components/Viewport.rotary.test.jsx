/**
 * @vitest-environment jsdom
 *
 * The 4th axis in the real scene graph: does the work actually turn, and does
 * the spindle actually stay upright?
 *
 * `engine/view/rotaryFrame.test.js` proves the maths — that the machine frame is
 * Rx(+A) of the part frame, that it pivots on the touched-off centre, that the
 * tool tilt goes to zero. None of that proves the *scene* uses it. The failure
 * this file exists to catch is the one a green engine suite cannot see: a
 * transform computed correctly and then wired to the wrong group, or a tool
 * still tilting because `rotaryFrame` never reached `Tool`.
 *
 * `@react-three/test-renderer` builds the graph without WebGL.
 */
import { describe, it, expect } from 'vitest';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import { SceneContents } from './Viewport.jsx';

function mount(extra = {}) {
  return ReactThreeTestRenderer.create(
    <SceneContents
      bounds={null}
      turnChuck={null}
      showStock
      toolPos={[10, 20, 5]}
      toolRotary={{ a: 90, b: 0 }}
      toolRadius={4}
      toolType="flat"
      toolLength={60}
      turnInsert={null}
      bufVer={0}
      drawVer="0:0"
      partVer={0}
      showPart
      mode="mill"
      sketching={false}
      {...extra}
    />,
  );
}

// eslint-disable-next-line testing-library/await-async-query
const group = (r, name) => r.scene.findAllByType('Group')
  .find((g) => g.instance.name === name)?.instance;
// eslint-disable-next-line testing-library/await-async-query
const flutes = (r) => r.scene.findAllByType('Mesh')
  .find((m) => m.instance.name === 'tool-flutes')?.instance;

const HALF_PI = Math.PI / 2;

describe('part frame — the workpiece stands still and the tool tilts', () => {
  it('leaves the work groups unrotated at any A', async () => {
    const r = await mount({ rotaryFrame: 'part' });
    expect(group(r, 'part-work').rotation.x).toBe(0);
    expect(group(r, 'stock-work').rotation.x).toBe(0);
  });

  it('tilts the cutter onto the indexed face', async () => {
    const r = await mount({ rotaryFrame: 'part' });
    expect(flutes(r).parent.rotation.x).toBeCloseTo(-HALF_PI);
  });
});

describe('machine frame — the table turns the work under an upright spindle', () => {
  it('turns the part group by +A about X', async () => {
    const r = await mount({ rotaryFrame: 'machine' });
    // +A, not -A: the part goes the way the table goes. The opposite sign draws
    // the part rolling away from the cut and looks entirely plausible.
    expect(group(r, 'part-work').rotation.x).toBeCloseTo(HALF_PI);
  });

  it('never tilts the cutter — a real spindle does not swivel', async () => {
    const r = await mount({ rotaryFrame: 'machine' });
    expect(flutes(r).parent.rotation.x).toBe(0);
  });

  it('still draws the cutter, at the programmed tip', async () => {
    const r = await mount({ rotaryFrame: 'machine' });
    expect(flutes(r)).toBeTruthy();
    // The tool group is outside the work group, so the trail it rides is the
    // stationary machine-frame path.
    expect(flutes(r).parent.parent.position.toArray()).toEqual([10, 20, 5]);
  });

  it('pivots on the touched-off A centre, not the part origin', async () => {
    const r = await mount({ rotaryFrame: 'machine', rotaryCenter: [3, 7] });
    const outer = group(r, 'part-work');
    expect(outer.position.toArray()).toEqual([0, 3, 7]);
    expect(outer.children[0].position.toArray()).toEqual([0, -3, -7]);
  });

  it('turns carved stock only the rest of the way from the index it was cut at', async () => {
    // The height field carves one index in the machine frame, so its block is
    // already at `simFrameA`. Turning it the full A would double-rotate it off
    // the model it was cut from.
    const r = await mount({ rotaryFrame: 'machine', simFrameA: 90 });
    expect(group(r, 'stock-work').rotation.x).toBeCloseTo(0);
    expect(group(r, 'part-work').rotation.x).toBeCloseTo(HALF_PI);
  });

  it('turns a part-frame voxel block the whole way', async () => {
    const r = await mount({ rotaryFrame: 'machine', simFrameA: 0 });
    expect(group(r, 'stock-work').rotation.x).toBeCloseTo(HALF_PI);
  });

  it('is identity before the playhead moves, so a datum pick reads part coordinates', async () => {
    const r = await mount({ rotaryFrame: 'machine', toolRotary: null });
    expect(group(r, 'part-work').rotation.x).toBe(0);
  });
});
