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

const named = (r, name) => r.scene.findAllByType('Mesh')
  .filter((m) => m.instance.name === name);
const fluteLength = (r) => named(r, 'tool-flutes')[0].instance.geometry.parameters.height;

describe('the marker takes the shape of the cutter type', () => {
  it('draws no nose on a square-ended cutter', async () => {
    for (const cutter of ['endmill', 'shoulder', 'face', 'slot']) {
      const r = await mount({ toolCutter: cutter });
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
      expect(named(r, 'tool-flutes'), cutter).toHaveLength(1);
      expect(named(r, 'tool-shank'), cutter).toHaveLength(1);
      expect(named(r, 'tool-arbor'), cutter).toHaveLength(1);
    }
  });

  it('falls back to the plain flat/ball when no type is given', async () => {
    // A tool detected from the program keeps its own simType — the fallback
    // picker must not redraw a detected Ø50 face mill as whatever it last showed.
    expect(named(await mount({ toolType: 'ball' }), 'tool-nose')).toHaveLength(1);
    expect(named(await mount({ toolType: 'flat' }), 'tool-nose')).toHaveLength(0);
  });
});
