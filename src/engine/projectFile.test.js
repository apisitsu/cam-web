import { describe, it, expect } from 'vitest';
import {
  buildProject, serializeProject, parseProject, projectFileName, programFileName,
  encodeFloat32, decodeFloat32,
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

describe('the CAM setup block', () => {
  const cam = {
    settings: { material: 'steel', machineId: 'haas-vf2', forceMode: 'mill', programNumber: 7 },
    datum: { point: [0, 0, 7.5], axesSet: [false, false, true], reverseX: false },
    recipe: [{ key: 'face', kind: 'face', toolId: 'em20', enabled: true }],
    part: { name: 'bracket.stl', format: 'stl', triangleCount: 2 },
  };

  it('carries the whole setup — machine, material, origin, operations, part', () => {
    const back = parseProject(serializeProject(buildProject({ cam })));
    expect(back.cam.settings.machineId).toBe('haas-vf2');
    expect(back.cam.settings.material).toBe('steel');
    expect(back.cam.datum.point).toEqual([0, 0, 7.5]);
    expect(back.cam.datum.axesSet).toEqual([false, false, true]);
    expect(back.cam.recipe).toHaveLength(1);
    expect(back.cam.part.name).toBe('bracket.stl');
  });

  it('is null for a project with no imported part', () => {
    expect(parseProject(serializeProject(buildProject({}))).cam).toBeNull();
  });

  it('still opens a v1 project (no cam block) without complaint', () => {
    // A file saved before the CAM block existed: version 1, no `cam`.
    const v1 = { kind: PROJECT_KIND, version: 1, gcode: 'G0 X0', settings: { mode: 'mill' } };
    const back = parseProject(JSON.stringify(v1));
    expect(back.gcode).toBe('G0 X0');
    expect(back.cam).toBeNull();
  });

  it('ignores a malformed cam field rather than crashing the parse', () => {
    const doc = { kind: PROJECT_KIND, version: PROJECT_VERSION, cam: [1, 2, 3] };
    expect(parseProject(JSON.stringify(doc)).cam).toBeNull();
  });
});

describe('the part vertex codec', () => {
  it('round-trips a Float32Array exactly through base64', () => {
    const arr = new Float32Array([0, 1, -2.5, 33.5, 1e6, -0.0001, 12345.678]);
    const back = decodeFloat32(encodeFloat32(arr));
    expect(Array.from(back)).toEqual(Array.from(arr));
  });

  it('handles a large buffer without overflowing', () => {
    const arr = new Float32Array(200000);
    for (let i = 0; i < arr.length; i += 1) arr[i] = Math.sin(i) * 100;
    const back = decodeFloat32(encodeFloat32(arr));
    expect(back.length).toBe(arr.length);
    expect(back[0]).toBe(arr[0]);
    expect(back[arr.length - 1]).toBe(arr[arr.length - 1]);
  });

  it('survives a full save/parse cycle inside a project', () => {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    const cam = { part: { name: 'p.stl', format: 'stl', triangleCount: 1, positions: encodeFloat32(positions) } };
    const back = parseProject(serializeProject(buildProject({ cam })));
    expect(Array.from(decodeFloat32(back.cam.part.positions))).toEqual(Array.from(positions));
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

describe('programFileName — what the exported .nc is called', () => {
  it('keeps a name that already says it is a program', () => {
    expect(programFileName('OR35128_OP20.NC')).toBe('OR35128_OP20.NC');
    expect(programFileName('shaft.tap')).toBe('shaft.tap');
    expect(programFileName('roughing.ngc')).toBe('roughing.ngc');
  });

  it('puts .nc on anything else — a program exported as .stl is a renaming job', () => {
    // The planner names the session after the model it is cutting, so this is
    // the ordinary case, not the odd one.
    expect(programFileName('bracket.stl')).toBe('bracket.nc');
    expect(programFileName('ring.camweb.json')).toBe('ring.camweb.nc');
    expect(programFileName('untitled')).toBe('untitled.nc');
  });

  it('drops any directory the name came with', () => {
    expect(programFileName('C:\\jobs\\OP10.nc')).toBe('OP10.nc');
    expect(programFileName('/mnt/jobs/OP10.nc')).toBe('OP10.nc');
  });

  it('falls back when nothing is loaded', () => {
    expect(programFileName(null)).toBe('program.nc');
    expect(programFileName('')).toBe('program.nc');
    expect(programFileName('   ')).toBe('program.nc');
  });
});
