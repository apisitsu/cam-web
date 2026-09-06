/**
 * @vitest-environment jsdom
 *
 * Does the chosen cutter type reach the marker?
 *
 * `engine/view/millTool.test.js` proves the geometry; this proves the scene
 * uses it. The failure it guards is quiet: a picker that changes the store and
 * the carve while the tool on screen goes on being the same stick, so the one
 * cue that says "you picked a face mill" never appears.
 */
import { describe, it, expect } from 'vitest';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import { SceneContents } from './Viewport.jsx';

function mount(extra = {}) {
  return ReactThreeTestRenderer.create(
    <SceneContents
      bounds={null} turnChuck={null} showStock={false}
      toolPos={[0, 0, 0]} toolRotary={null}
      toolRadius={3} toolType="flat" toolLength={0}
      turnInsert={null} bufVer={0} drawVer="0:0" partVer={0}
      showPart={false} mode="mill" sketching={false}
      {...extra}
    />,
  );
}

// eslint-disable-next-line testing-library/await-async-query
const named = (r, name) => r.scene.findAllByType('Mesh')
  .filter((m) => m.instance.name === name);
const fluteLength = (r) => named(r, 'tool-flutes')[0].instance.geometry.parameters.height;

describe('the marker takes the shape of the cutter type', () => {
  it('draws no nose on a square-ended cutter', async () => {
    for (const cutter of ['endmill', 'shoulder', 'face', 'slot']) {
      const r = await mount({ toolCutter: cutter });
      // eslint-disable-next-line jest/valid-expect
      expect(named(r, 'tool-nose'), cutter).toHaveLength(0);
    }
  });

  it('draws a sphere for a ball nose', async () => {
    const r = await mount({ toolCutter: 'ball' });
    const nose = named(r, 'tool-nose')[0];
    expect(nose).toBeTruthy();
    expect(nose.instance.geometry.type).toBe('SphereGeometry');
  });

  it('draws a cone for a chamfer mill, not a sphere', async () => {
    // A chamfer mill leaves a cone in the stock; drawing a ball there says the
    // wrong thing about the edge it is breaking.
    const r = await mount({ toolCutter: 'chamfer', toolAngle: 90 });
    const nose = named(r, 'tool-nose')[0];
    expect(nose).toBeTruthy();
    expect(nose.instance.geometry.type).toBe('CylinderGeometry');
    const p = nose.instance.geometry.parameters;
    expect(p.radiusBottom).toBe(0);           // it is a point
    expect(p.radiusTop).toBeCloseTo(3);        // full radius where the flutes start
  });

  it('makes a sharper chamfer mill a longer point', async () => {
    const height = async (angle) => {
      const r = await mount({ toolCutter: 'chamfer', toolAngle: angle });
      return named(r, 'tool-nose')[0].instance.geometry.parameters.height;
    };
    expect(await height(60)).toBeGreaterThan(await height(90));
  });

  it('draws a face mill as a disc and an endmill as a stick', async () => {
    // Same radius, very different tool. A marker that draws them alike says
    // nothing about whether the holder clears the fixture.
    const face = await mount({ toolCutter: 'face', toolRadius: 25 });
    const endmill = await mount({ toolCutter: 'endmill', toolRadius: 25 });
    expect(fluteLength(face)).toBeLessThan(fluteLength(endmill) / 2);
  });

  it('keeps every part of the tool whatever the type', async () => {
    for (const cutter of ['endmill', 'shoulder', 'face', 'slot', 'ball', 'chamfer']) {
      const r = await mount({ toolCutter: cutter });
      // eslint-disable-next-line jest/valid-expect
      expect(named(r, 'tool-flutes'), cutter).toHaveLength(1);
      // eslint-disable-next-line jest/valid-expect
      expect(named(r, 'tool-shank'), cutter).toHaveLength(1);
      // eslint-disable-next-line jest/valid-expect
      expect(named(r, 'tool-arbor'), cutter).toHaveLength(1);
    }
  });

  it('cuts the slot mill to the body length it was given', async () => {
    // The one dimension a slot cutter's diameter cannot imply.
    const short = await mount({ toolCutter: 'slot', toolRadius: 6, toolThickness: 8 });
    const long = await mount({ toolCutter: 'slot', toolRadius: 6, toolThickness: 25 });
    expect(fluteLength(short)).toBeCloseTo(8, 6);
    expect(fluteLength(long)).toBeCloseTo(25, 6);
    // It still stands along the tool axis, like every other milling cutter.
    expect(named(short, 'tool-flutes')[0].instance.rotation.x).toBeCloseTo(Math.PI / 2, 6);
  });

  it("falls back to the type's own body when none is given", async () => {
    const implied = await mount({ toolCutter: 'slot', toolRadius: 5 });
    expect(fluteLength(implied)).toBeCloseTo(30, 6);   // Ø10 x bodyRatio 3
  });

  it('necks the slot mill down to the shank it was given', async () => {
    // Ø20 where it cuts, Ø8 where it is held — and the holder comes down with
    // the shank, because that is what a collet grips.
    const necked = await mount({ toolCutter: 'slot', toolRadius: 10, toolShank: 8 });
    const plain = await mount({ toolCutter: 'slot', toolRadius: 10 });
    const rOf = (r, name) => named(r, name)[0].instance.geometry.parameters.radiusTop;
    expect(rOf(necked, 'tool-shank')).toBeCloseTo(4, 6);
    expect(rOf(necked, 'tool-flutes')).toBeCloseTo(10, 6);
    expect(rOf(necked, 'tool-arbor')).toBeLessThan(rOf(plain, 'tool-arbor'));
  });

  it('falls back to the plain flat/ball when no type is given', async () => {
    // A tool detected from the program keeps its own simType — the fallback
    // picker must not redraw a detected Ø50 face mill as whatever it last showed.
    expect(named(await mount({ toolType: 'ball' }), 'tool-nose')).toHaveLength(1);
    expect(named(await mount({ toolType: 'flat' }), 'tool-nose')).toHaveLength(0);
  });
});
