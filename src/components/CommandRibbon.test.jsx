/**
 * @vitest-environment jsdom
 */
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import CommandRibbon from './CommandRibbon.jsx';
import { useCamStore } from '../stores/camStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { useMeasureStore } from '../stores/measureStore.js';

let container;
let root;
let props;

const q = (sel) => container.querySelector(sel);
const button = (label) => q(`[data-ribbon-button="${label}"]`);
const tab = (value) => q(`[data-ribbon-tab="${value}"]`);
const press = async (el) => {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

async function render() {
  // eslint-disable-next-line testing-library/no-unnecessary-act
  await act(async () => { root.render(React.createElement(CommandRibbon, props)); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  props = {
    setRibbonSlot: vi.fn(), onSetup: vi.fn(), onWorkOrigin: vi.fn(), onExportGcode: vi.fn(),
  };
  useCamStore.setState({
    page: 'mill', gcode: '', status: 'idle', simStatus: 'idle',
    setPage: vi.fn(async (page) => { useCamStore.setState({ page }); }),
  });
  useFeatureStore.setState({ features: [], selectedId: null, dirty: false });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('CommandRibbon', () => {
  it('has a tab for each task, and marks the page on screen', async () => {
    await render();
    expect(['features', 'sketch', 'cam'].every((t) => tab(t))).toBe(true);
    expect(tab('mill')).toBeNull();
    expect(tab('cam').getAttribute('aria-selected')).toBe('true');
    expect(tab('sketch').getAttribute('aria-selected')).toBe('false');
  });

  it('switches between Milling and Turning inside CAM', async () => {
    await render();
    const turning = [...q('[data-cam-process]').querySelectorAll('label')]
      .find((l) => l.textContent === 'Turning');
    await press(turning);
    expect(useCamStore.getState().setPage).toHaveBeenCalledWith('turn');
    expect(tab('cam').getAttribute('aria-selected')).toBe('true');
  });

  it('goes back from Sketch to the machine page CAM was last on', async () => {
    useCamStore.setState({ page: 'turn' });
    await render();
    await act(async () => { useCamStore.setState({ page: 'sketch' }); });
    await press(tab('cam'));
    expect(useCamStore.getState().setPage).toHaveBeenCalledWith('turn');
  });

  it('swaps the buttons on Features without leaving the page', async () => {
    await render();
    await press(tab('features'));
    expect(useCamStore.getState().setPage).not.toHaveBeenCalled();
    expect(button('Rebuild')).not.toBeNull();
    expect(button('Setup')).toBeNull();
  });

  it('leaves Features when the page changes from elsewhere, such as opening a project', async () => {
    await render();
    await press(tab('features'));
    await act(async () => { useCamStore.setState({ page: 'turn' }); });
    expect(tab('cam').getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the sketch buttons mounted but hidden on another tab', async () => {
    useCamStore.setState({ page: 'sketch' });
    await render();
    expect(q('[data-ribbon-slot]').style.display).toBe('block');
    await press(tab('features'));
    expect(q('[data-ribbon-slot]').style.display).toBe('none');
    expect(props.setRibbonSlot).toHaveBeenCalled();
  });

  it('comes back to the sketch from Features without asking for a page change', async () => {
    useCamStore.setState({ page: 'sketch' });
    await render();
    await press(tab('features'));
    await press(tab('sketch'));
    expect(useCamStore.getState().setPage).not.toHaveBeenCalled();
    expect(q('[data-ribbon-slot]').style.display).toBe('block');
  });

  it('wires the machine buttons to the app', async () => {
    useCamStore.setState({ gcode: 'G0 X0' });
    await render();
    await press(button('Setup'));
    await press(button('Post G-code'));
    expect(props.onSetup).toHaveBeenCalledTimes(1);
    expect(props.onExportGcode).toHaveBeenCalledTimes(1);
  });

  it('names Simulate after the run it will be', async () => {
    useCamStore.setState({ gcode: 'G0 X0' });
    props.simulateCommand = { id: 'simulateUndercut', icon: null };
    await render();
    const btn = q('button[data-cmd="simulateUndercut"]');
    expect(btn.textContent).toContain('Simulate the undercut');
  });

  it('opens the tool table when the program has tools', async () => {
    props.onToolTable = vi.fn();
    await render();
    expect(button('Tool Table').disabled).toBe(true);
    props.hasTools = true;
    await render();
    await press(button('Tool Table'));
    expect(props.onToolTable).toHaveBeenCalledTimes(1);
  });

  it('offers the four named features, and a cut only once there is a part', async () => {
    await render();
    await press(tab('features'));
    for (const name of ['Extruded Boss/Base', 'Revolved Boss/Base', 'Extruded Cut', 'Revolved Cut']) {
      // eslint-disable-next-line jest/valid-expect
      expect(button(name), name).not.toBeNull();
    }
    expect(button('Extruded Boss/Base').disabled).toBe(false);
    expect(button('Extruded Cut').disabled).toBe(true);
    expect(button('Revolved Cut').disabled).toBe(true);
    expect(button('Hole Wizard').disabled).toBe(true);

    await act(async () => {
      useFeatureStore.setState({ features: [{ id: 'f1', name: 'Extrude1' }] });
      useCamPlanStore.setState({ status: 'ready', stlName: 'part.stl' });
    });
    expect(button('Extruded Cut').disabled).toBe(false);
    expect(button('Hole Wizard').disabled).toBe(false);
    await act(async () => { useCamPlanStore.setState({ status: 'idle', stlName: null }); });
  });

  it('turns off what has nothing to act on', async () => {
    await render();
    expect(button('Simulate').disabled).toBe(true);
    expect(button('Post G-code').disabled).toBe(true);
    expect(button('Standard Vc').disabled).toBe(true);
    await press(tab('features'));
    expect(button('Rebuild').disabled).toBe(true);
    expect(button('Suppress').disabled).toBe(true);
  });

  it('suppresses the feature selected in the tree', async () => {
    const toggleSuppress = vi.fn();
    useFeatureStore.setState({
      features: [{ id: 'f1', name: 'Extrude1', suppressed: false }], selectedId: 'f1', toggleSuppress,
    });
    await render();
    await press(tab('features'));
    await press(button('Suppress'));
    expect(toggleSuppress).toHaveBeenCalledWith('f1');
  });

  it('offers only commands that exist', async () => {
    await render();
    await press(tab('features'));
    expect(container.textContent).toMatch(/Linear Pattern.*Circular Pattern.*Mirror/);
    for (const t of ['features', 'cam']) {
      // eslint-disable-next-line no-await-in-loop
      await press(tab(t));
      expect(container.textContent).not.toMatch(/soon|Section View/);
    }
  });

  it('turns Measure on and off once there is a part, from Features and the machine tabs', async () => {
    useMeasureStore.setState({ active: false, picks: [] });
    await render();
    expect(button('Measure').disabled).toBe(true);
    await act(async () => { useCamPlanStore.setState({ analysis: { bounds: { min: [0, 0, 0], max: [1, 1, 1] } } }); });
    await press(button('Measure'));
    expect(useMeasureStore.getState().active).toBe(true);
    await press(tab('features'));
    await press(button('Measure'));
    expect(useMeasureStore.getState().active).toBe(false);
    await act(async () => { useCamPlanStore.setState({ analysis: null }); });
  });
});
