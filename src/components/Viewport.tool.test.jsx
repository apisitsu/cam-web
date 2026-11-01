/**
 * @vitest-environment jsdom
 *
 * The show/hide-tool toggle, in the real scene graph — turning's counterpart
 * to `Viewport.arbor.test.jsx`.
 *
 * `engine/view/latheTool.test.js` proves `offerToolToggle` only fires for
 * turning. That is not the same as proving the *scene* drops the marker when
 * asked: the flag still has to survive App's prop, `Viewport`, `SceneContents`
 * and `Tool` before it reaches `LatheTool` — a gap anywhere in that chain gives
 * a switch that flips and changes nothing, the failure this file exists to
 * catch.
 *
 * `@react-three/test-renderer` builds the graph without WebGL.
 */
import { describe, it, expect } from 'vitest';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import { SceneContents } from './Viewport.jsx';

/** The viewport's scene with the props App feeds it while turning a program. */
function mount(extra = {}) {
  return ReactThreeTestRenderer.create(
    <SceneContents
      bounds={null}
      turnChuck={null}
      showStock={false}
      toolPos={[10, 0, 5]}
      toolRotary={null}
      toolRadius={1.6}
      toolType="flat"
      turnInsert={{ kind: 'od', angle: 35, lead: 93 }}
      bufVer={0}
      drawVer="0:0"
      partVer={0}
      showPart={false}
      mode="turn"
      sketching={false}
      {...extra}
    />,
  );
}

// eslint-disable-next-line testing-library/await-async-query
const latheTool = (r) => r.scene.findAllByType('Group').filter((g) => g.instance.name === 'lathe-tool');

describe('the tool toggle reaches the scene', () => {
  it('draws the lathe tool by default', async () => {
    const r = await mount();
    expect(latheTool(r)).toHaveLength(1);
  });

  it('drops the whole marker when switched off', async () => {
    const r = await mount({ showTool: false });
    expect(latheTool(r)).toHaveLength(0);
  });

  it('draws no lathe tool at all before the playhead moves', async () => {
    const r = await mount({ toolPos: null });
    expect(latheTool(r)).toHaveLength(0);
  });

  it('has no effect on milling, whatever the flag says', async () => {
    // Milling draws a holder above the cutter instead; the flag is inert there
    // — that case belongs to `showArbor`, not this one.
    const r = await mount({
      mode: 'mill', showTool: false, toolRadius: 4, toolLength: 60, turnInsert: null,
    });
    expect(latheTool(r)).toHaveLength(0);
    expect(r.scene.findAllByType('Mesh').length).toBeGreaterThan(0); // the mill tool still drew
  });
});

describe('a drill marker is drawn true to scale, not the OD holders\' decorated size', () => {
  // The bug: `toolRadius` is the Tool table's real ⌀/2 for a drill
  // (`turningCutRadiusResolver` carves the same number), but the marker was
  // capped at 1.6 — a ⌀8.5 drill carved a real 4.25 mm bore and drew a bit
  // less than half as wide. Only the OD/boring/parting markers are meant to
  // be a decorated, proportional drawing; a drill's radius IS the hole.
  // eslint-disable-next-line testing-library/await-async-query
  const shaftMesh = (r) => r.scene.findAllByType('Mesh').find((m) => {
    const p = m.instance.geometry.parameters;
    return p && p.radiusTop === p.radiusBottom;
  });

  it('is not clamped to the OD-holder cap', async () => {
    const r = await mount({ turnInsert: { kind: 'drill', angle: 118 }, toolRadius: 4.25 });
    expect(shaftMesh(r).instance.geometry.parameters.radiusTop).toBeCloseTo(4.25, 5);
  });

  it('still clamps an OD holder — it has no real diameter of its own to match', async () => {
    // odHolderGeometry scales its whole outline off the marker radius
    // (toolScale), so an unclamped 10 would draw a visibly bigger holder than
    // a clamped 1.6. Drawing the same size at both proves the cap is still
    // there for everything that isn't a drill.
    const atCap = await mount({ turnInsert: { kind: 'od', angle: 35, lead: 93 }, toolRadius: 1.6 });
    const overCap = await mount({ turnInsert: { kind: 'od', angle: 35, lead: 93 }, toolRadius: 10 });
    const size = (rr) => {
      const geo = rr.scene.findAllByType('Mesh')[0].instance.geometry;
      geo.computeBoundingBox();
      const b = geo.boundingBox;
      return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
    };
    expect(size(overCap)).toEqual(size(atCap));
  });
});

describe('a parting-blade marker is drawn true to scale with the groove it cuts', () => {
  // The bug: `grooveW` is now a real, measured dimension — `width` fixed to
  // match it exactly — but the cutting tip was still drawn 15% *proud* of the
  // blade on every side, a stylisation left over from when `width` was a
  // decorated, non-measured number. A 3mm groove then showed a ~3.45mm gold
  // tip, visibly wider than the cut it was making.
  //
  // Box geometry args are [width, height, depth]; `PartingBlade` passes the
  // kerf dimension (`g.width`) as the THIRD arg, so it lands in Three's own
  // `parameters.depth` on both meshes.
  const kerfOf = (m) => m.instance.geometry.parameters.depth;

  it('gives the tip and the blade body the exact same kerf width', async () => {
    const r = await mount({ turnInsert: { kind: 'parting', grooveW: 3 }, toolRadius: 1.6 });
    const meshes = r.scene.findAllByType('Mesh');
    expect(meshes).toHaveLength(2);
    expect(kerfOf(meshes[0])).toBeCloseTo(3, 6);
    expect(kerfOf(meshes[1])).toBeCloseTo(3, 6);
  });

  it('follows an overridden groove width, not just the 3mm default', async () => {
    const r = await mount({ turnInsert: { kind: 'parting', grooveW: 4.5 }, toolRadius: 1.6 });
    for (const m of r.scene.findAllByType('Mesh')) expect(kerfOf(m)).toBeCloseTo(4.5, 6);
  });

  it('is edge-referenced in Z, not centred — matches carveTurningMove\'s matching fix', async () => {
    // The programmed Z (the tool's local Z=0, since `Tool` places the whole
    // marker group at `pos`) is the edge kept, not the middle of the blade —
    // see `carveTurningMove`'s identical comment. A box of width w centred
    // at z=-w/2 spans [-w, 0]: flush against the tool position on one side,
    // reaching back toward the chuck on the other.
    const r = await mount({ turnInsert: { kind: 'parting', grooveW: 3 }, toolRadius: 1.6 });
    for (const m of r.scene.findAllByType('Mesh')) {
      expect(m.instance.position.z).toBeCloseTo(-1.5, 6); // -grooveW/2
    }
  });
});
