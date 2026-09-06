// @vitest-environment jsdom
/**
 * Auto-save draft: what counts as "worth keeping", the localStorage round-trip,
 * and the rules that stop it from eating a real draft (nothing worth saving
 * leaves an existing one alone; suspend holds writes off during a restore).
 */
import {
  describe, it, expect, beforeEach,
} from 'vitest';
import {
  draftProject, worthSaving, writeDraftNow, readDraft, clearDraft, suspendAutosave,
} from './autosave.js';
import { useCamStore } from '../stores/camStore.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import {
  createSketch, addPoint, addLine,
} from '../engine/sketch/model.js';

const KEY = 'cam.autosave';

/** Put a sketch with real geometry into the sketch store. */
function drawSomething() {
  const sk = createSketch();
  const a = addPoint(sk, 0, 0);
  const b = addPoint(sk, 10, 0);
  addLine(sk, a, b);
  useSketchStore.setState({
    sk,
    sketches: [{ id: 1, name: 'S1', plane: { preset: 'XY', offset: 0 }, doc: sk }],
    activeId: 1,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useSketchStore.setState({ sk: createSketch(), sketches: [], activeId: null });
  useCamStore.setState({ gcode: '', fileName: null });
  useFeatureStore.setState({ features: [] });
});

describe('worthSaving', () => {
  it('is false for an empty session', () => {
    expect(worthSaving(draftProject())).toBe(false);
  });

  it('is true once there is a program', () => {
    useCamStore.setState({ gcode: 'G0 X0 Y0' });
    expect(worthSaving(draftProject())).toBe(true);
  });

  it('is true once a feature has been built', () => {
    useFeatureStore.setState({ features: [{ id: 'f1', kind: 'extrude' }] });
    expect(worthSaving(draftProject())).toBe(true);
  });

  it('is true once a sketch holds more than the origin', () => {
    drawSomething();
    expect(worthSaving(draftProject())).toBe(true);
  });
});

describe('draftProject', () => {
  it('is a project document that drops the imported STL', () => {
    drawSomething();
    const p = draftProject();
    expect(p.kind).toBeTruthy();
    expect(p.cam).toBeNull();
    expect(p.sketches.items[0].doc.entities.length).toBe(3);
  });
});

describe('the localStorage round-trip', () => {
  it('writes a draft that reads back', () => {
    drawSomething();
    writeDraftNow();
    const back = readDraft();
    expect(back).not.toBeNull();
    expect(typeof back.at).toBe('number');
    expect(back.project.sketches.items[0].doc.entities.length).toBe(3);
  });

  it('leaves an existing draft alone when there is nothing worth saving', () => {
    drawSomething();
    writeDraftNow();
    const saved = window.localStorage.getItem(KEY);

    useSketchStore.setState({ sk: createSketch(), sketches: [], activeId: null });
    writeDraftNow(); // empty session — must not overwrite or clear

    expect(window.localStorage.getItem(KEY)).toBe(saved);
  });

  it('clearDraft removes it', () => {
    drawSomething();
    writeDraftNow();
    clearDraft();
    expect(readDraft()).toBeNull();
  });

  it('reads back null for a corrupt draft', () => {
    window.localStorage.setItem(KEY, '{ not json');
    expect(readDraft()).toBeNull();
  });
});

describe('suspendAutosave', () => {
  it('holds writes off while a restore runs', async () => {
    drawSomething();
    await suspendAutosave(() => {
      writeDraftNow(); // would normally persist
    });
    expect(window.localStorage.getItem(KEY)).toBeNull();
    // ...and writes work again afterwards.
    writeDraftNow();
    expect(readDraft()).not.toBeNull();
  });
});
