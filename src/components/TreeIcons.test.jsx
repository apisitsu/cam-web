/**
 * @vitest-environment jsdom
 *
 * What the feature tree's icons promise: every row says what kind of thing it is,
 * and a sketch that follows a face says so — the one fact the icon carries that
 * the row's text does not.
 */
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import FeatureTree from './FeatureTree.jsx';
import { useFeatureStore } from '../stores/featureStore.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { createSketch, addPoint, addLine } from '../engine/sketch/model.js';

let container;
let root;

function rectSketch() {
  const sk = createSketch();
  const p = [addPoint(sk, 0, 0), addPoint(sk, 40, 0), addPoint(sk, 40, 40), addPoint(sk, 0, 40)];
  for (let i = 0; i < 4; i++) addLine(sk, p[i], p[(i + 1) % 4]);
  return sk;
}

// eslint-disable-next-line testing-library/no-unnecessary-act
const render = async () => act(async () => { root.render(React.createElement(FeatureTree)); });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useFeatureStore.getState().clear();
  const a = rectSketch();
  const b = rectSketch();
  useSketchStore.setState({
    sk: a,
    sketches: [
      { id: 1, name: 'Base', plane: { preset: 'XY', offset: 0 }, doc: a, past: [], future: [] },
      {
        id: 2,
        name: 'On top',
        plane: { preset: 'XY', offset: 10, ref: { featureId: 1, axis: 'z', side: 'max' } },
        doc: b, past: [], future: [],
      },
    ],
    activeId: 1,
    nextSketchId: 3,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('feature tree icons', () => {
  it('puts an icon, not a text glyph, in front of each sketch row', async () => {
    await render();
    const rows = [...document.querySelectorAll('[data-tree-sketch]')];
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.querySelector('svg')).toBeTruthy();
      expect(r.textContent).not.toContain('✎');
    }
  });

  it('marks only the sketch that follows a face with the link icon, and says what it means', async () => {
    await render();
    const [base, onTop] = ['1', '2'].map((id) => document.querySelector(`[data-tree-sketch="${id}"]`));
    expect(base.querySelector('[data-tree-link]')).toBeNull();
    const link = onTop.querySelector('[data-tree-link]');
    expect(link).toBeTruthy();
    expect(link.getAttribute('aria-label')).toMatch(/follows the face/i);
  });

  it('gives a built feature an icon of its own beside its name', async () => {
    useFeatureStore.getState().addFeature('extrude', { sketchId: 1, name: 'Extrude1' });
    await render();
    const item = document.querySelector('[data-feature-item]');
    expect(item.querySelector('svg')).toBeTruthy();
    expect(item.textContent).toContain('Extrude1');
  });

  it('draws a revolve with a different icon from an extrude', async () => {
    useFeatureStore.getState().addFeature('extrude', { sketchId: 1, name: 'A' });
    useFeatureStore.getState().addFeature('revolve', { sketchId: 1, name: 'B' });
    await render();
    const [a, b] = [...document.querySelectorAll('[data-feature-item]')].map((e) => e.querySelector('svg').innerHTML);
    expect(a).not.toBe(b);
  });
});
