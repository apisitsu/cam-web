/**
 * @vitest-environment jsdom
 *
 * The show/hide-toolpath toggle, in the real scene graph.
 *
 * Same reason `Viewport.arbor.test.jsx` exists: a flag that flips the store and
 * the button's pressed look, and changes nothing on screen, is the failure mode
 * here — and it cannot be caught anywhere above the scene, because everything
 * above it looks right. The backplot has to survive App's prop, `Viewport` and
 * `SceneContents` before it reaches the two `LineSegments` it draws.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import { SceneContents } from './Viewport.jsx';
import { setView } from '../engine/bufferCache.js';

beforeAll(() => {
  // A backplot to draw: two line segments' worth of feeds and of rapids. The
  // component reads them from the buffer cache, never from props.
  setView({
    feeds: new Float32Array([0, 0, 0, 10, 0, 0]),
    rapids: new Float32Array([10, 0, 0, 10, 10, 0]),
  });
});

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
      drawVer="1:1"
      partVer={0}
      showPart={false}
      mode="mill"
      sketching={false}
      {...extra}
    />,
  );
}

/** Every LineSegments in the graph — the backplot is the only thing that makes them. */
const lines = (r) => r.scene.findAllByType('LineSegments');

/**
 * Whether an object would actually be drawn: itself visible, and every ancestor
 * too. The backplot is **hidden, not unmounted** — each line is a `<primitive>`,
 * and R3F does not own an object it was handed, so unmounting the component did
 * not reliably take the object out of the scene. `visible` is what three reads
 * at draw time, so it is what this has to check.
 */
function drawn(o) {
  let p = o;
  while (p) {
    if (!p.visible) return false;
    p = p.parent;
  }
  return true;
}

describe('the toolpath toggle reaches the scene', () => {
  it('draws the backplot by default', async () => {
    const r = await mount();
    // eslint-disable-next-line testing-library/await-async-query
    const ls = lines(r);
    expect(ls.length).toBeGreaterThan(0);
    expect(ls.every((l) => drawn(l.instance))).toBe(true);
  });

  it('stops drawing it when switched off — hidden, not unmounted', async () => {
    const r = await mount({ showToolpath: false });
    // eslint-disable-next-line testing-library/await-async-query
    const ls = lines(r);
    // Still in the graph on purpose: the geometry stays ready for the next
    // toggle, and removal is what did not work.
    expect(ls.length).toBeGreaterThan(0);
    expect(ls.some((l) => drawn(l.instance))).toBe(false);
  });

  it('leaves the tool marker alone — only the path goes', async () => {
    const r = await mount({ showToolpath: false });
    // eslint-disable-next-line testing-library/await-async-query
    const named = r.scene.findAllByType('Mesh').filter((m) => m.instance.name === 'tool-flutes');
    expect(named).toHaveLength(1);
  });
});
