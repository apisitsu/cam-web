import { describe, it, expect } from 'vitest';
import {
  buildProject, serializeProject, parseProject, projectFileName,
  PROJECT_KIND, PROJECT_VERSION,
} from './projectFile.js';

describe('project file — build and parse round trip', () => {
  const sample = {
    gcode: 'G21 G90\nG0 X10 Z0\n',
    fileName: 'part.nc',
    sketch: { entities: [{ id: 1, type: 'point', x: 0, y: 0 }], constraints: [] },
    settings: { mode: 'turn', toolRadius: 3, playhead: 42 },
  };

  it('round-trips the program, name and sketch', () => {
    const back = parseProject(serializeProject(buildProject(sample)));
    expect(back.gcode).toBe(sample.gcode);
    expect(back.fileName).toBe('part.nc');
    expect(back.sketch).toEqual(sample.sketch);
  });

  it('keeps known settings and drops transient ones', () => {
    const back = parseProject(serializeProject(buildProject(sample)));
    expect(back.settings.mode).toBe('turn');
    expect(back.settings.toolRadius).toBe(3);
    // `playhead` is UI state, not part of the saved setup.
    expect(back.settings.playhead).toBeUndefined();
  });

  it('stamps the kind and version, and a savedAt timestamp', () => {
    const doc = buildProject(sample);
    expect(doc.kind).toBe(PROJECT_KIND);
    expect(doc.version).toBe(PROJECT_VERSION);
    expect(Number.isNaN(Date.parse(doc.savedAt))).toBe(false);
  });

  it('handles an empty project', () => {
    const back = parseProject(serializeProject(buildProject()));
    expect(back.gcode).toBe('');
    expect(back.sketch).toBeNull();
    expect(back.fileName).toBeNull();
  });
});

describe('project file — rejecting bad input', () => {
  it('explains when the file is not JSON', () => {
    expect(() => parseProject('G21 G90\nG0 X1')).toThrow(/not valid JSON/i);
  });

  it('explains when the JSON is not a project', () => {
    expect(() => parseProject('{"hello":"world"}')).toThrow(/not a cam-web project/i);
    expect(() => parseProject('[1,2,3]')).toThrow(/not a cam-web project/i);
  });

  it('points a stray G-code file at the right button', () => {
    expect(() => parseProject('{"kind":"something-else"}')).toThrow(/Open file/);
  });

  it('refuses a project from a newer build rather than half-loading it', () => {
    const doc = { ...buildProject({}), version: PROJECT_VERSION + 1 };
    expect(() => parseProject(JSON.stringify(doc))).toThrow(/newer version/i);
  });

  it('rejects a missing or nonsense version', () => {
    expect(() => parseProject(JSON.stringify({ kind: PROJECT_KIND }))).toThrow(/version/i);
    expect(() => parseProject(JSON.stringify({ kind: PROJECT_KIND, version: 'x' }))).toThrow(/version/i);
  });
});

describe('projectFileName', () => {
  it('sits next to the program it came from', () => {
    expect(projectFileName('bracket.nc')).toBe('bracket.camweb.json');
    expect(projectFileName('shaft.v2.gcode')).toBe('shaft.v2.camweb.json');
  });

  it('falls back when nothing is loaded', () => {
    expect(projectFileName(null)).toBe('untitled.camweb.json');
    expect(projectFileName('')).toBe('untitled.camweb.json');
  });
});

describe('project file — a real sketch survives the round trip', () => {
  it('restores the same geometry and constraints', async () => {
    const { createSketch, addPoint, addLine, addCircle, addConstraint, serialize, deserialize } =
      await import('./sketch/model.js');
    const sk = createSketch();
    const o = addPoint(sk, 0, 0, true);
    sk.entities.get(o).origin = true;
    const p = addPoint(sk, 30, 40);
    const line = addLine(sk, o, p);
    const circle = addCircle(sk, addPoint(sk, 60, 10), 12);
    addConstraint(sk, 'distanceX', [o, p], 30);
    addConstraint(sk, 'diameter', [circle], 24);
    sk.entities.get(line).construction = true;

    const doc = serializeProject(buildProject({ sketch: serialize(sk) }));
    const back = deserialize(parseProject(doc).sketch);

    expect(back.entities.size).toBe(sk.entities.size);
    expect(back.constraints.length).toBe(2);
    const pt = back.entities.get(p);
    expect(pt.x).toBe(30);
    expect(pt.y).toBe(40);
    expect(back.entities.get(line).construction).toBe(true);
    expect(back.entities.get(circle).r).toBe(12);
    expect(back.constraints.find((c) => c.kind === 'distanceX').value).toBe(30);
    // The origin flag must survive, or the restored sketch loses its datum.
    expect(back.entities.get(o).origin).toBe(true);
  });
});
