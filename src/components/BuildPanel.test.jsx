/**
 * @vitest-environment jsdom
 *
 * The 2D→3D panels, in the DOM.
 *
 * These are render-gate tests in the same spirit as `SketchToolbar.test.jsx`: the
 * geometry is proved elsewhere, and what cannot be seen from there is a panel
 * that offers Build on a sketch that cannot build, or one that refuses a sketch
 * that can. Both read as the feature being broken.
 */
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import BuildPanel from './BuildPanel.jsx';
import SketchesPanel from './SketchesPanel.jsx';
import { useSketchStore } from '../stores/sketchStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { createSketch, addPoint, addLine, addCircle } from '../engine/sketch/model.js';

let container;
let root;

/** A closed rectangle, as a fresh sketch document. */
function rectSketch() {
  const sk = createSketch();
  const p1 = addPoint(sk, 0, 0);
  const p2 = addPoint(sk, 40, 0);
  const p3 = addPoint(sk, 40, 20);
  const p4 = addPoint(sk, 0, 20);
  addLine(sk, p1, p2);
  addLine(sk, p2, p3);
  addLine(sk, p3, p4);
  addLine(sk, p4, p1);
  return sk;
}

/** An L of two lines that never closes. */
function openSketch() {
  const sk = createSketch();
  const p1 = addPoint(sk, 0, 0);
  const p2 = addPoint(sk, 40, 0);
  const p3 = addPoint(sk, 40, 20);
  addLine(sk, p1, p2);
  addLine(sk, p2, p3);
  return sk;
}

function setSketch(sk, plane = { preset: 'XY', offset: 0 }) {
  useSketchStore.setState({
    sk,
    sketches: [{ id: 1, name: 'Sketch1', plane, doc: sk }],
    activeId: 1,
    nextSketchId: 2,
    past: [], future: [], error: null,
    version: (useSketchStore.getState().version ?? 0) + 1,
  });
}

/** Render `el` and open its popover by clicking the trigger. */
async function open(el) {
  // eslint-disable-next-line testing-library/no-unnecessary-act
  await act(async () => { root.render(el); });
  const trigger = container.querySelector('button');
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // Popover content is portalled to the body, not into `container`.
  return document.body.textContent;
}

describe('BuildPanel — one named feature from the Ribbon', () => {
  const panel = (preset) => React.createElement(BuildPanel, {
    trigger: React.createElement('button', { type: 'button' }, 'Open'),
    preset,
  });
  const pressBuild = () => act(async () => {
    document.querySelector('[data-sketch-build]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  const realBuild = useFeatureStore.getState().buildFromSketch;
  let build;

  const withPart = (yes) => {
    useFeatureStore.setState({ features: yes ? [{ id: 'f1', name: 'Extrude1' }] : [], buildFromSketch: build });
    useCamPlanStore.setState({ status: yes ? 'ready' : 'idle', stlName: yes ? 'part.stl' : null });
  };

  beforeEach(() => {
    build = vi.fn(async () => {});
    setSketch(rectSketch());
  });

  afterEach(() => {
    useCamPlanStore.setState({ status: 'idle', stlName: null });
    useFeatureStore.setState({ features: [], buildFromSketch: realBuild });
  });

  it('asks only for sizes, having been told the rest by the button', async () => {
    withPart(true);
    const text = await open(panel({ name: 'Extruded Boss/Base', op: 'extrude', cut: false }));
    expect(text).toContain('Extruded Boss/Base from');
    expect(text).toContain('Depth');
    expect(text).not.toContain('Against what the tree has built');
  });

  it('joins a boss to the part', async () => {
    withPart(true);
    await open(panel({ name: 'Extruded Boss/Base', op: 'extrude', cut: false }));
    await pressBuild();
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ op: 'extrude', merge: 'add' }));
  });

  it('closes once the build has worked, and stays open when it has not', async () => {
    withPart(true);
    const pop = () => [...document.querySelectorAll('.ant-popover')].at(-1);
    build.mockResolvedValueOnce(null);
    await open(panel({ name: 'Extruded Boss/Base', op: 'extrude', cut: false }));
    await pressBuild();
    expect(pop().className).not.toMatch(/ant-popover-hidden|-leave/);
    build.mockResolvedValueOnce({ ok: true });
    await pressBuild();
    // Closing: hidden, or still on its way out (jsdom never ends the animation).
    expect(pop().className).toMatch(/ant-popover-hidden|-leave/);
  });

  it('makes a boss the first body when the tree is empty', async () => {
    withPart(false);
    await open(panel({ name: 'Extruded Boss/Base', op: 'extrude', cut: false }));
    await pressBuild();
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ merge: 'new' }));
  });

  it('cuts from the part, and says which way a cut runs', async () => {
    withPart(true);
    const text = await open(panel({ name: 'Extruded Cut', op: 'extrude', cut: true }));
    expect(text).toContain('into the part');
    await pressBuild();
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ op: 'extrude', merge: 'cut', end: 'blind' }));
  });

  it('cuts through all without asking for a depth, and turns round on Reverse', async () => {
    withPart(true);
    await open(panel({ name: 'Extruded Cut', op: 'extrude', cut: true }));
    // The panel just opened; earlier tests' popovers may linger in the body.
    const pop = () => [...document.querySelectorAll('.ant-popover')].at(-1);
    const through = [...pop().querySelectorAll('[data-extrude-end] label')].find((l) => l.textContent === 'Through All');
    await act(async () => { through.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pop().textContent).not.toContain('Depth');
    await act(async () => {
      pop().querySelector('[data-extrude-reverse]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await pressBuild();
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ end: 'through', reverse: true }));
  });

  it('revolves when the button says so', async () => {
    withPart(true);
    const text = await open(panel({ name: 'Revolved Cut', op: 'revolve', cut: true }));
    expect(text).toContain('Angle');
    await pressBuild();
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ op: 'revolve', merge: 'cut' }));
  });

  it('turns about the sketch’s X axis when it has no centerline', async () => {
    withPart(false);
    await open(panel({ name: 'Revolved Boss/Base', op: 'revolve', cut: false }));
    await pressBuild();
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ axis: 'x', axisLine: null }));
  });

  it('takes the centerline as the axis, as SolidWorks does, once one is drawn', async () => {
    const sk = rectSketch();
    const line = addLine(sk, addPoint(sk, 0, -5), addPoint(sk, 40, -5));
    sk.entities.get(line).construction = true;
    setSketch(sk);
    withPart(false);
    const text = await open(panel({ name: 'Revolved Boss/Base', op: 'revolve', cut: false }));
    expect(text).toContain('Centerline');
    await pressBuild();
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ op: 'revolve', axisLine: line }));
  });
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('BuildPanel — says what the sketch can build before you press it', () => {
  it('offers Build and counts the profiles when the sketch is closed', async () => {
    setSketch(rectSketch());
    const text = await open(React.createElement(BuildPanel, {
      trigger: React.createElement('button', null, 'build'),
    }));
    expect(text).toMatch(/1 closed profile/i);
    const btn = document.querySelector('[data-sketch-build]');
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
  });

  it('counts the holes as well as the boundary', async () => {
    const sk = rectSketch();
    const c = addPoint(sk, 20, 10);
    addCircle(sk, c, 4);
    setSketch(sk);
    const text = await open(React.createElement(BuildPanel, {
      trigger: React.createElement('button', null, 'build'),
    }));
    expect(text).toMatch(/1 closed profile/i);
    expect(text).toMatch(/1 hole/i);
  });

  it('refuses an open profile and says that is why', async () => {
    setSketch(openSketch());
    const text = await open(React.createElement(BuildPanel, {
      trigger: React.createElement('button', null, 'build'),
    }));
    expect(text).toMatch(/not closed/i);
    expect(document.querySelector('[data-sketch-build]').disabled).toBe(true);
  });

  it('asks for a profile when the sketch is empty', async () => {
    setSketch(createSketch());
    const text = await open(React.createElement(BuildPanel, {
      trigger: React.createElement('button', null, 'build'),
    }));
    expect(text).toMatch(/Draw a closed profile first/i);
    expect(document.querySelector('[data-sketch-build]').disabled).toBe(true);
  });

  it('names the plane the solid will be built on', async () => {
    setSketch(rectSketch(), { preset: 'XZ', offset: 12 });
    const text = await open(React.createElement(BuildPanel, {
      trigger: React.createElement('button', null, 'build'),
    }));
    expect(text).toMatch(/Front \(XZ\) \+12/);
  });
});

describe('SketchesPanel — picking the sketch and its plane', () => {
  it('lists each sketch with the plane it sits on', async () => {
    const sk = rectSketch();
    useSketchStore.setState({
      sk,
      sketches: [
        { id: 1, name: 'Base', plane: { preset: 'XY', offset: 0 }, doc: sk },
        { id: 2, name: 'Front face', plane: { preset: 'XZ', offset: 5 }, doc: createSketch() },
      ],
      activeId: 1,
      nextSketchId: 3,
    });
    const text = await open(React.createElement(SketchesPanel, {
      trigger: React.createElement('button', null, 'sketches'),
    }));
    expect(text).toMatch(/Base/);
    expect(text).toMatch(/Top \(XY\)/);
    expect(text).toMatch(/Front face/);
    expect(text).toMatch(/Front \(XZ\) \+5/);
  });

  it('adds a sketch through the store when the button is pressed', async () => {
    setSketch(rectSketch());
    await open(React.createElement(SketchesPanel, {
      trigger: React.createElement('button', null, 'sketches'),
    }));
    const add = document.querySelector('[data-sketch-add]');
    await act(async () => {
      add.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useSketchStore.getState().sketches).toHaveLength(2);
  });

  it('will not offer to delete the only sketch there is', async () => {
    setSketch(rectSketch());
    await open(React.createElement(SketchesPanel, {
      trigger: React.createElement('button', null, 'sketches'),
    }));
    const deletes = [...document.querySelectorAll('button')]
      .filter((b) => b.className.includes('ant-btn-dangerous'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0].disabled).toBe(true);
  });
});
