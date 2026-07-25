/**
 * @vitest-environment jsdom
 *
 * The show/hide-arbor toggle, in the real scene graph.
 *
 * `engine/view/millTool.test.js` proves the geometry drops the holder and leaves
 * the cutter alone. That is not the same as proving the *scene* does: the flag
 * still has to survive App's prop, `Viewport`, `SceneContents` and `Tool` before
 * it reaches `EndMill`. A gap anywhere in that chain gives a switch that flips
 * and changes nothing — the failure this file exists to catch.
 *
 * `@react-three/test-renderer` builds the graph without WebGL.
 */
import { describe, it, expect } from 'vitest';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import { SceneContents } from './Viewport.jsx';

/** The viewport's scene with the props App feeds it while a program runs. */
function mount(extra = {}) {
  return ReactThreeTestRenderer.create(
    <SceneContents
      bounds={null}
      turnChuck={null}
      showStock={false}
      toolPos={[10, 20, 5]}
      toolRotary={null}
      toolRadius={4}
      toolType="flat"
      toolLength={60}
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

const named = (r, name) => r.scene.findAllByType('Mesh').filter((m) => m.instance.name === name);

describe('the arbor toggle reaches the scene', () => {
  it('draws the arbor by default', async () => {
    const r = await mount();
    expect(named(r, 'tool-arbor')).toHaveLength(1);
  });

  it('drops the arbor when switched off', async () => {
    const r = await mount({ showArbor: false });
    expect(named(r, 'tool-arbor')).toHaveLength(0);
  });

  it('keeps the cutter when the arbor is hidden — only the holder goes', async () => {
    // The bug worth guarding: hiding the holder must not take the tool with it.
    const r = await mount({ showArbor: false });
    expect(named(r, 'tool-flutes')).toHaveLength(1);
    expect(named(r, 'tool-shank')).toHaveLength(1);
  });

  it('leaves the cutter in exactly the same place either way', async () => {
    // The tip is what the position readout reports; toggling a holder must not
    // move it.
    const on = await mount({ showArbor: true });
    const off = await mount({ showArbor: false });
    const z = (r, n) => named(r, n)[0].instance.position.z;
    expect(z(off, 'tool-flutes')).toBeCloseTo(z(on, 'tool-flutes'), 9);
    expect(z(off, 'tool-shank')).toBeCloseTo(z(on, 'tool-shank'), 9);
  });

  it('still draws a ball nose with the arbor hidden', async () => {
    const r = await mount({ showArbor: false, toolType: 'ball' });
    expect(named(r, 'tool-nose')).toHaveLength(1);
  });

  it('draws no mill tool at all before the playhead moves', async () => {
    const r = await mount({ toolPos: null });
    expect(named(r, 'tool-arbor')).toHaveLength(0);
    expect(named(r, 'tool-flutes')).toHaveLength(0);
  });

  it('has no mill arbor on the lathe, whatever the flag says', async () => {
    // Turning draws a holder in the cutting plane instead; the flag is inert.
    const r = await mount({ mode: 'turn', showArbor: true, turnInsert: { kind: 'od', angle: 35, lead: 93 } });
    expect(named(r, 'tool-arbor')).toHaveLength(0);
  });
});
