// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import PartMesh, { FeatureHighlight } from './PartMesh.jsx';
import { useCamPlanStore, getMesh } from '../stores/camPlanStore.js';
import { box, cylinder } from '../engine/mesh/fixtures.js';

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
    expect(r.scene.findAllByType('Mesh')).toHaveLength(0);
  });

  it('renders the imported model', async () => {
    // The regression this file exists for: the STL loaded, the filename showed
    // in the header, and the viewport stayed empty because nothing ever built
    // geometry from it.
    await store().loadStl(stlFile(box(20, 30, 10)));
    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    const meshes = r.scene.findAllByType('Mesh');
    expect(meshes).toHaveLength(1);
    const geo = meshes[0].instance.geometry;
    // 12 triangles × 3 corners × 3 floats, straight from the soup.
    expect(geo.getAttribute('position').count).toBe(36);
  });

  it('builds normals so the part is shaded, not a silhouette', async () => {
    await store().loadStl(stlFile(box(20, 20, 20)));
    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    const geo = r.scene.findAllByType('Mesh')[0].instance.geometry;
    expect(geo.getAttribute('normal')).toBeTruthy();
    expect(geo.boundingSphere.radius).toBeGreaterThan(0);
  });

  it('spans the model bounds, so the camera fit has something real to frame', async () => {
    await store().loadStl(stlFile(cylinder(10, 40, 32)));
    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
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
    expect(r.scene.findAllByType('Mesh')).toHaveLength(0);
    expect(getMesh().soup).toBeTruthy(); // still loaded, just not drawn
  });

  it('draws both sides, so an inside-out STL is not full of holes', async () => {
    await store().loadStl(stlFile(box()));
    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    const mat = r.scene.findAllByType('Mesh')[0].instance.material;
    expect(mat.side).toBe(2); // THREE.DoubleSide
  });

  it('swaps geometry when a different model is imported', async () => {
    await store().loadStl(stlFile(box(10, 10, 10)));
    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    const first = r.scene.findAllByType('Mesh')[0].instance.geometry.getAttribute('position').count;

    await store().loadStl(stlFile(cylinder(10, 20, 32)));
    await ReactThreeTestRenderer.act(async () => {
      r.update(<PartMesh meshVer={store().meshVer} />);
    });
    const second = r.scene.findAllByType('Mesh')[0].instance.geometry.getAttribute('position').count;
    expect(second).not.toBe(first);
  });
});

describe('picking a face off the model', () => {
  it('draws nothing when nothing is selected', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    const r = await ReactThreeTestRenderer.create(<FeatureHighlight meshVer={store().meshVer} />);
    expect(r.scene.findAllByType('Mesh')).toHaveLength(0);
  });

  it('draws the selected face over the part', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    const top = store().features().faces.find((f) => f.facing === 'up');
    store().selectFeature(top);

    const r = await ReactThreeTestRenderer.create(<FeatureHighlight meshVer={store().meshVer} />);
    const meshes = r.scene.findAllByType('Mesh');
    expect(meshes).toHaveLength(1);
    // One highlight triangle per triangle of the merged face.
    expect(meshes[0].instance.geometry.attributes.position.count).toBe(top.triangles.length * 3);
    expect(meshes[0].instance.material.color.getHexString()).toBe('fbbf24');
  });

  it('draws a selected edge as a line, not a surface', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    store().selectFeature(store().features().edges[0]);

    const r = await ReactThreeTestRenderer.create(<FeatureHighlight meshVer={store().meshVer} />);
    expect(r.scene.findAllByType('Mesh')).toHaveLength(0);
    expect(r.scene.findAllByType('Line')).toHaveLength(1);
  });

  it('maps a clicked triangle to the whole face it belongs to', async () => {
    // What a raycast actually hands over is one triangle out of hundreds.
    // Nobody ever means "that triangle".
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    const r = await ReactThreeTestRenderer.create(<PartMesh meshVer={store().meshVer} />);
    const part = r.scene.findAllByType('Mesh')[0];

    await ReactThreeTestRenderer.act(async () => {
      part.props.onClick({ faceIndex: 0, stopPropagation() {} });
    });
    expect(store().selectedFeature).toBeTruthy();
    expect(store().selectedFeature.triangles).toContain(0);
  });
});
