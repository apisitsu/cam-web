// @vitest-environment jsdom
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import PartMesh, {
  FeatureHighlight, DatumPickHighlight, OriginMarker, RotaryAxisLine,
} from './PartMesh.jsx';
import { useCamPlanStore, getMesh } from '../stores/camPlanStore.js';
import { box, cylinder, turnedShaft, tube } from '../engine/mesh/fixtures.js';
import { CAD } from '../theme.js';

/** A binary-STL File-alike, the way the store receives one from a drop. */
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

const store = () => useCamPlanStore.getState();

describe('PartMesh', () => {
  beforeEach(() => { store().clear(); });

  it('renders nothing before an STL is imported', async () => {
    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={0} />);
    // eslint-disable-next-line testing-library/await-async-query
    expect(r.scene.findAllByType('Mesh')).toHaveLength(0);
  });

  it('renders the imported model', async () => {
    // The regression this file exists for: the STL loaded, the filename showed
    // in the header, and the viewport stayed empty because nothing ever built
    // geometry from it.
    await store().loadStl(stlFile(box(20, 30, 10)));
    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    const meshes = r.scene.findAllByType('Mesh');
    expect(meshes).toHaveLength(1);
    const geo = meshes[0].instance.geometry;
    // 12 triangles × 3 corners × 3 floats, straight from the soup.
    expect(geo.getAttribute('position').count).toBe(36);
  });

  it('builds normals so the part is shaded, not a silhouette', async () => {
    await store().loadStl(stlFile(box(20, 20, 20)));
    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    const geo = r.scene.findAllByType('Mesh')[0].instance.geometry;
    expect(geo.getAttribute('normal')).toBeTruthy();
    expect(geo.boundingSphere.radius).toBeGreaterThan(0);
  });

  it('spans the model bounds, so the camera fit has something real to frame', async () => {
    await store().loadStl(stlFile(cylinder(10, 40, 32)));
    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    const pos = r.scene.findAllByType('Mesh')[0].instance.geometry.getAttribute('position');
    let maxZ = -Infinity, maxX = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      maxZ = Math.max(maxZ, pos.getZ(i));
      maxX = Math.max(maxX, pos.getX(i));
    }
    expect(maxZ).toBeCloseTo(40, 1);
    expect(maxX).toBeCloseTo(10, 1);
  });

  it('hides on request without unloading the mesh', async () => {
    await store().loadStl(stlFile(box()));
    const r = await ReactThreeTestRenderer.create(
      <PartMesh meshVer={store().meshVer} visible={false} />,
    );
    // eslint-disable-next-line testing-library/await-async-query
    expect(r.scene.findAllByType('Mesh')).toHaveLength(0);
    expect(getMesh().soup).toBeTruthy(); // still loaded, just not drawn
  });

  it('draws both sides, so an inside-out STL is not full of holes', async () => {
    await store().loadStl(stlFile(box()));
    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    const mat = r.scene.findAllByType('Mesh')[0].instance.material;
    expect(mat.side).toBe(2); // THREE.DoubleSide
  });

  it('swaps geometry when a different model is imported', async () => {
    await store().loadStl(stlFile(box(10, 10, 10)));
    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    const first = r.scene.findAllByType('Mesh')[0].instance.geometry.getAttribute('position').count;

    await store().loadStl(stlFile(cylinder(10, 20, 32)));
    await ReactThreeTestRenderer.act(async () => {
      r.update(<PartMesh meshVer={store().meshVer} />);
    });
    // eslint-disable-next-line testing-library/await-async-query
    const second = r.scene.findAllByType('Mesh')[0].instance.geometry.getAttribute('position').count;
    expect(second).not.toBe(first);
  });
});

describe('picking a face off the model', () => {
  it('draws nothing when nothing is selected', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    const r = await ReactThreeTestRenderer.create(<FeatureHighlight meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    expect(r.scene.findAllByType('Mesh')).toHaveLength(0);
  });

  it('draws the selected face over the part', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    const top = store().features().faces.find((f) => f.facing === 'up');
    store().selectFeature(top);

    const r = await ReactThreeTestRenderer.create(<FeatureHighlight meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    const meshes = r.scene.findAllByType('Mesh');
    expect(meshes).toHaveLength(1);
    // One highlight triangle per triangle of the merged face.
    expect(meshes[0].instance.geometry.attributes.position.count).toBe(top.triangles.length * 3);
    // The highlight colour comes from the palette, not from a hex frozen here:
    // what matters is that the picked face is drawn in the pre-select colour.
    expect(meshes[0].instance.material.color.getHexString())
      .toBe(CAD.skHover.replace('#', '').toLowerCase());
  });

  it('draws a selected edge as a line, not a surface', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    store().selectFeature(store().features().edges[0]);

    const r = await ReactThreeTestRenderer.create(<FeatureHighlight meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    expect(r.scene.findAllByType('Mesh')).toHaveLength(0);
    // eslint-disable-next-line testing-library/await-async-query
    expect(r.scene.findAllByType('Line')).toHaveLength(1);
  });

  it('maps a clicked triangle to the whole face it belongs to', async () => {
    // What a raycast actually hands over is one triangle out of hundreds.
    // Nobody ever means "that triangle".
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    const part = r.scene.findAllByType('Mesh')[0];

    await ReactThreeTestRenderer.act(async () => {
      part.props.onClick({ faceIndex: 0, stopPropagation() {} });
    });
    expect(store().selectedFeature).toBeTruthy();
    expect(store().selectedFeature.triangles).toContain(0);
  });
});

describe('picking the datum off the model', () => {
  // A real R3F event: `point` is a THREE.Vector3 (clone + toArray) and `object`
  // is the mesh, whose `worldToLocal` undoes the `part-work` group's transform.
  // The default stand-in mesh is untransformed; a test can pass its own to model
  // the "Work rotates" frame mid-index.
  const fakePoint = (arr) => ({ toArray: () => arr.slice(), clone: () => fakePoint(arr) });
  const identityMesh = { worldToLocal: (v) => fakePoint(v.toArray()) };
  const evt = (point, over = {}) => ({
    faceIndex: 0,
    point: fakePoint(point),
    face: { normal: fakePoint([0, 0, 1]) },
    object: identityMesh,
    stopPropagation() {},
    ...over,
  });

  it('a click while picking one axis sets only that axis, and does not select a feature', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    store().startPickAxis(2); // arm Z

    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    const part = r.scene.findAllByType('Mesh')[0];
    await ReactThreeTestRenderer.act(async () => {
      part.props.onClick(evt([7, 3, 10])); // only the Z (10) should be taken
    });

    expect(store().datumPickMode).toBeNull();
    expect(store().selectedFeature).toBeNull();
    // X and Y untouched (0), only Z zeroed at the clicked point.
    expect(store().displayedDatumPoint()).toEqual([0, 0, 10]);
    expect(store().datum.axesSet).toEqual([false, false, true]);
  });

  it('converts the pick out of world space, so a rotated part-work group cannot skew the origin', async () => {
    // In the machine ("Work rotates") frame the mesh hangs under a group turned
    // by the playhead's A index. `event.point` is world space; without
    // `worldToLocal` the stored origin would be rotated by that angle.
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    store().startPickAxis(2); // arm Z

    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    const part = r.scene.findAllByType('Mesh')[0];
    // Stand-in for a group rotated about X: worldToLocal maps (x,y,z) → (x,z,−y).
    const rotatedMesh = {
      worldToLocal: (v) => { const [x, y, z] = v.toArray(); return fakePoint([x, z, -y]); },
    };
    await ReactThreeTestRenderer.act(async () => {
      part.props.onClick(evt([7, 10, 3], { object: rotatedMesh }));
    });

    // World Z was 3; in the model's own frame the point is [7, 3, −10], so Z0
    // lands at −10 — not the 3 the un-converted world point would have given.
    expect(store().displayedDatumPoint()).toEqual([0, 0, -10]);
  });

  it('checks datum-pick mode before the turn-mode "no faces" bail-out', async () => {
    // `features()` returns no faces at all for a lathe part — a datum pick
    // must not be swallowed by the same early return that guards feature
    // selection, or a turned part could never get an origin set on it.
    await store().loadStl(stlFile(turnedShaft(), 'shaft.stl'));
    await store().makePlan();
    store().startPickAxis(2); // arm Z (the spindle axis)

    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    const part = r.scene.findAllByType('Mesh')[0];
    await ReactThreeTestRenderer.act(async () => {
      part.props.onClick(evt([0, 0, 5], { face: { normal: fakePoint([1, 0, 0]) } }));
    });

    expect(store().displayedDatumPoint()).toEqual([0, 0, 5]);
  });

  it('a click while picking the rotary centre sets it, without touching the plane/point', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    store().startPickRotaryCenter();

    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    const part = r.scene.findAllByType('Mesh')[0];
    await ReactThreeTestRenderer.act(async () => {
      part.props.onClick(evt([0, 5, 10]));
    });

    expect(store().datumPickMode).toBeNull();
    expect(store().selectedFeature).toBeNull();
    expect(store().displayedRotaryCenter()).toEqual([5, 10]);
    expect(store().displayedDatumPoint()).toBeNull();
  });

  it('a click while picking A0 rotates that face onto +Z, without touching the origin', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    store().startPickRotaryZero();

    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    const part = r.scene.findAllByType('Mesh')[0];
    await ReactThreeTestRenderer.act(async () => {
      // the +Y side, not the current top
      part.props.onClick(evt([0, 15, 0], { face: { normal: fakePoint([0, 1, 0]) } }));
    });

    expect(store().datumPickMode).toBeNull();
    expect(store().selectedFeature).toBeNull();
    expect(store().rotaryZeroAngle()).toBeCloseTo(270, 3);
    expect(store().displayedDatumPoint()).toBeNull();
  });
});

describe('PartMesh — showing what an armed pick would take', () => {
  const fakeVec = (arr) => ({ clone: () => fakeVec(arr), toArray: () => arr });
  const event = (point, normal, faceIndex = 0) => ({
    point: fakeVec(point),
    face: { normal: fakeVec(normal) },
    faceIndex,
    object: { worldToLocal: (v) => v },
    stopPropagation() {},
  });
  const partOf = async () => {
    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    return r.scene.findAllByType('Mesh')[0];
  };

  beforeEach(() => { useCamPlanStore.setState({ forceMode: 'mill' }); });
  afterEach(() => { useCamPlanStore.setState({ forceMode: 'auto' }); });

  it('offers the whole flat face under the cursor to an armed axis pick', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    store().startPickAxis(2);
    const part = await partOf();
    await ReactThreeTestRenderer.act(async () => {
      part.props.onPointerMove(event([0, 0, 10], [0, 0, 1]));
    });
    const expected = store().features().faces.find((f) => f.triangles.includes(0));
    expect(store().datumHover.face.id).toBe(expected.id);
  });

  it('offers the circle under the cursor to an armed centre pick', async () => {
    await store().loadStl(stlFile(tube(20, 10, 30)));
    await store().makePlan();
    store().startPickCircle();
    const part = await partOf();
    await ReactThreeTestRenderer.act(async () => {
      part.props.onPointerMove(event([10, 0, 15], [-1, 0, 0]));
    });
    expect(store().datumHover.circle.radius).toBeCloseTo(10, 0);
    expect(store().datumHover.circle.axis).toBe(2);
  });

  it('offers nothing when no circle is there', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    store().startPickCircle();
    const part = await partOf();
    await ReactThreeTestRenderer.act(async () => {
      part.props.onPointerMove(event([0, 0, 10], [0, 0, 1]));
    });
    expect(store().datumHover).toBeNull();
  });

  it('keeps the circle on show across a surface with none, and off the part', async () => {
    await store().loadStl(stlFile(tube(20, 10, 30)));
    await store().makePlan();
    store().startPickCircle();
    const part = await partOf();
    await ReactThreeTestRenderer.act(async () => {
      part.props.onPointerMove(event([10, 0, 15], [-1, 0, 0], 0));
    });
    const shown = store().datumHover;
    await ReactThreeTestRenderer.act(async () => {
      // A chamfer: no circle can be read from a facet at this angle.
      part.props.onPointerMove(event([10, 0, 30], [-0.6, 0, 0.8], 1));
      part.props.onPointerOut();
    });
    expect(store().datumHover).toBe(shown);
  });

  it('a click on the part takes the circle on show', async () => {
    await store().loadStl(stlFile(tube(20, 10, 30)));
    await store().makePlan();
    store().startPickCircle();
    const part = await partOf();
    await ReactThreeTestRenderer.act(async () => {
      part.props.onPointerMove(event([10, 0, 15], [-1, 0, 0], 0));
      // Lands on the chamfer beside the ring, where no circle can be read.
      part.props.onClick(event([10, 0, 30], [-0.6, 0, 0.8], 1));
    });
    expect(store().datumPickMode).toBeNull();
    expect(store().datum.axesSet).toEqual([true, true, false]);
  });

  it('clears when the cursor leaves the part', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    store().startPickAxis(2);
    const part = await partOf();
    await ReactThreeTestRenderer.act(async () => {
      part.props.onPointerMove(event([0, 0, 10], [0, 0, 1]));
      part.props.onPointerOut();
    });
    expect(store().datumHover).toBeNull();
  });

  it('does not touch the feature preview, which means something else', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    store().startPickAxis(2);
    const part = await partOf();
    await ReactThreeTestRenderer.act(async () => {
      part.props.onPointerMove(event([0, 0, 10], [0, 0, 1]));
    });
    expect(store().previewFeature).toBeNull();
  });
});

describe('DatumPickHighlight', () => {
  const groups = (r) => r.scene.children.filter((c) => c.instance.name === 'datum-pick-highlight');

  beforeEach(() => { useCamPlanStore.setState({ datumPickMode: null, datumHover: null }); });

  it('draws nothing with no pick armed, even with a hover left over', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    useCamPlanStore.setState({
      datumHover: { id: 'circle:x', circle: { axis: 2, center: [0, 0, 0], radius: 5 } },
    });
    const r = await ReactThreeTestRenderer.create(<DatumPickHighlight meshVer={store().meshVer} />);
    expect(groups(r)).toHaveLength(0);
  });

  it('draws a ring and a centre dot for a circle', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    useCamPlanStore.setState({
      datumPickMode: 'circle',
      datumHover: { id: 'circle:x', circle: { axis: 2, center: [1, 2, 3], radius: 5 } },
    });
    const r = await ReactThreeTestRenderer.create(<DatumPickHighlight meshVer={store().meshVer} />);
    expect(groups(r)).toHaveLength(1);
    // eslint-disable-next-line testing-library/await-async-query
    expect(r.scene.findAllByType('Mesh')).toHaveLength(2);
  });

  it('takes the circle when the ring itself is clicked', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    useCamPlanStore.setState({
      datumPickMode: 'circle',
      datumHover: { id: 'circle:x', circle: { axis: 2, center: [1, 2, 3], radius: 5 } },
    });
    const r = await ReactThreeTestRenderer.create(<DatumPickHighlight meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    const ring = r.scene.findAllByType('Mesh')[0];
    await ReactThreeTestRenderer.act(async () => {
      ring.props.onClick({ stopPropagation() {} });
    });
    expect(store().datumPickMode).toBeNull();
    expect(store().datum.axesSet).toEqual([true, true, false]);
  });

  it('draws the face for an axis pick', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    const face = store().features().faces[0];
    useCamPlanStore.setState({ datumPickMode: 'z', datumHover: { id: `face:${face.id}`, face } });
    const r = await ReactThreeTestRenderer.create(<DatumPickHighlight meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    expect(r.scene.findAllByType('Mesh')).toHaveLength(1);
  });
});

describe('OriginMarker', () => {
  it('draws nothing until a datum is set', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    const r = await ReactThreeTestRenderer.create(<OriginMarker meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    expect(r.scene.findAllByType('Line')).toHaveLength(0);
  });

  it('draws a three-axis triad at the origin once a point is picked', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    store().pickAxisOrigin(2, [0, 0, 10]);

    const r = await ReactThreeTestRenderer.create(<OriginMarker meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    const lines = r.scene.findAllByType('Line');
    expect(lines).toHaveLength(3);
    // Every leg starts at the origin, since the picked point is baked into
    // the mesh's own coordinates rather than tracked separately.
    for (const line of lines) {
      const pos = line.instance.geometry.getAttribute('position');
      expect(pos.getX(0)).toBe(0);
      expect(pos.getY(0)).toBe(0);
      expect(pos.getZ(0)).toBe(0);
    }
  });
});

describe('RotaryAxisLine', () => {
  it('draws nothing until a rotary centre is set', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    const r = await ReactThreeTestRenderer.create(<RotaryAxisLine meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    expect(r.scene.findAllByType('Line')).toHaveLength(0);
  });

  it('draws a line through the picked centre, running along X', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    store().pickRotaryCenter([0, 15, 0]);

    const r = await ReactThreeTestRenderer.create(<RotaryAxisLine meshVer={store().meshVer} />);
    // eslint-disable-next-line testing-library/await-async-query
    const lines = r.scene.findAllByType('Line');
    expect(lines).toHaveLength(1);
    const pos = lines[0].instance.geometry.getAttribute('position');
    // Both endpoints sit at the picked Y/Z; only X differs, and it spans past
    // the 120mm part.
    expect(pos.getY(0)).toBeCloseTo(15, 3);
    expect(pos.getZ(0)).toBeCloseTo(0, 3);
    expect(pos.getY(1)).toBeCloseTo(15, 3);
    expect(pos.getZ(1)).toBeCloseTo(0, 3);
    expect(pos.getX(1) - pos.getX(0)).toBeGreaterThan(120);
  });
});
