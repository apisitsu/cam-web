/**
 * @vitest-environment jsdom
 *
 * The status bar answers three questions from values the app already holds: what
 * am I editing, what is selected, is the model current. These pin the wording of
 * each, and that it reads the real stores rather than printing placeholders.
 */
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import StatusBar, { modeText, selectionText, treeText } from './StatusBar.jsx';
import { useCamStore } from '../stores/camStore.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { createSketch } from '../engine/sketch/model.js';

describe('modeText', () => {
  it('names the sketch and its plane while sketching', () => {
    expect(modeText({ page: 'sketch', sketchName: 'Sketch2', plane: 'Top (XY) +10' }))
      .toBe('Editing Sketch2 · Top (XY) +10');
  });
  it('names the page, and the file when one is open, otherwise', () => {
    expect(modeText({ page: 'mill' })).toBe('Milling');
    expect(modeText({ page: 'turn', fileName: 'OP10.nc' })).toBe('Turning · OP10.nc');
  });
  it('still says something for a page it does not know', () => {
    expect(modeText({ page: 'weird' })).toBe('Ready');
    expect(modeText({ page: 'sketch' })).toBe('Sketch');
  });
});

describe('selectionText', () => {
  it('prefers a picked face, with its facing and area', () => {
    expect(selectionText({ face: { facing: 'up', area: 123.456 }, featureName: 'Extrude1' }))
      .toBe('Face · up · 123.5 mm²');
  });
  it('falls back to the tree selection, then to saying nothing is selected', () => {
    expect(selectionText({ featureName: 'Extrude1' })).toBe('Extrude1');
    expect(selectionText({})).toBe('Nothing selected');
  });
});

describe('treeText', () => {
  it('says so when nothing is built', () => {
    expect(treeText({ count: 0, dirty: false, errors: 0 })).toBe('No features yet');
  });
  it('says out of date in words, and what to do about it', () => {
    expect(treeText({ count: 2, dirty: true, errors: 0 })).toBe('2 features · out of date — Rebuild');
  });
  it('says up to date, singular for one, and failures before staleness', () => {
    expect(treeText({ count: 1, dirty: false, errors: 0 })).toBe('1 feature · up to date');
    expect(treeText({ count: 3, dirty: true, errors: 1 })).toBe('3 features · 1 failed');
  });
});

describe('StatusBar reads the stores', () => {
  let container;
  let root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useFeatureStore.getState().clear();
    const doc = createSketch();
    useSketchStore.setState({
      sk: doc,
      sketches: [{ id: 1, name: 'Sketch1', plane: { preset: 'XY', offset: 10 }, doc, past: [], future: [] }],
      activeId: 1,
      nextSketchId: 2,
    });
    useCamPlanStore.setState({ selectedFeature: null });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const text = (k) => document.querySelector(`[data-status="${k}"]`).textContent;

  it('does not claim a sketch is being edited with none open', async () => {
    useCamStore.setState({ page: 'sketch' });
    useSketchStore.setState({ sketchOpen: false });
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => { root.render(React.createElement(StatusBar)); });
    expect(text('mode')).toBe('Sketch');
  });

  it('shows the sketch being edited, and that nothing is built yet', async () => {
    useCamStore.setState({ page: 'sketch' });
    useSketchStore.setState({ sketchOpen: true });
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => { root.render(React.createElement(StatusBar)); });
    expect(text('mode')).toBe('Editing Sketch1 · Top (XY) +10');
    expect(text('selection')).toMatch(/Nothing selected/);
    expect(text('tree')).toBe('No features yet');
  });

  it('follows a picked face and a stale tree', async () => {
    useCamStore.setState({ page: 'mill' });
    useFeatureStore.getState().addFeature('extrude', { sketchId: 1, name: 'Extrude1' });
    useCamPlanStore.setState({ selectedFeature: { facing: 'up', area: 50, normal: [0, 0, 1], centroid: [0, 0, 0] } });
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => { root.render(React.createElement(StatusBar)); });
    expect(text('mode')).toBe('Milling');
    expect(text('selection')).toMatch(/Face · up · 50 mm²/);
    expect(text('tree')).toBe('1 feature · out of date — Rebuild');
  });
});
