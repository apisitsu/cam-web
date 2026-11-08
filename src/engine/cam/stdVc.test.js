import { describe, it, expect } from 'vitest';
import {
  detectMaterial, scanProgram, proposeStd, applyStd, maskComments, operationOf, rowTimes,
} from './stdVc.js';

const MATERIALS = [
  { key: '7075-T73511', label: '7075-T73511', status: 'draft', aliases: ['7075', 'AL7075'],
    vc: { turning: [300, 800], milling: [300, 1000], drilling: [150, 300], reaming: [50, 100], tap: [15, 30] } },
  { key: '17-4PH', label: '17-4PH H1025', status: 'draft', aliases: ['17-4PH', '17-4'],
    vc: { turning: [70, 120], milling: [60, 100], drilling: [40, 70], reaming: [30, 50], tap: [5, 12] } },
  { key: 'Ti-6Al-4V', label: 'Ti-6Al-4V', status: 'approved', aliases: ['Ti-6Al-4V', 'Ti64'],
    vc: { turning: [40, 80], milling: [35, 70], drilling: [25, 50], reaming: [20, 40], tap: [4, 8] } },
];
const M17 = MATERIALS[1];
const M7075 = MATERIALS[0];

// A cut-down of the Fork mill program: two uses of T1, a drill with a G73 cycle
// written on one line with its retract mode, a reamer, and a comment that
// mentions a speed that must never be edited.
const MILL = [
  '%',
  'O0015(FORK END 17-4PH)',
  '(MATERIAL: 17-4PH stainless -- S9999 F9999 are only in this comment)',
  'T1(ENDMILL D8 - Z-SIDE FLAT)',
  'M6',
  'G43Z100.H1',
  'S2400M3',
  'G1Y-5.F600.',
  'G00Z100.',
  'T2(DRILL 9 CB - PRE-DRILL)',
  'M6',
  'S1400M3',
  'G99G73Z-14.R14.Q1.F100.',
  'G80Z100.',
  'T5(ENDMILL D8 L48-54 - ROUGH B2)',
  'S1700M3',
  'G1X10.Y5.F400.',
  'G3X5.Y2.R4.F200.',
  'T9(REAMER D13H7)',
  'S300M3',
  'G99G85Z-14.R14.F50.',
  'M30',
  '%',
].join('\n');

const TURN = [
  '%',
  'O0001',
  'T0606',
  'G50 S2200',
  'G96 S1800 M3',
  'G0 X32.0 Z2.0',
  'G1 X-1.0 F0.2',
  'G71 U1.0 R0.5',
  'G71 P10 Q20 U0.1 W0.1 F0.2',
  '(--- T0202: DRILL DIA 8.5 MM ---)',
  'T0202',
  'G97 S600 M3',
  'G74 R1.0',
  'G74 Z-35.0 Q2000 F0.05',
  '(--- T0505: PARTING ---)',
  'T0505',
  'G50 S2200',
  'G96 S50 M3',
  'G1 X7.0 F0.06',
  'M30',
  '%',
].join('\n');

describe('maskComments', () => {
  it('blanks comments but keeps every index', () => {
    const l = 'S1400M3 (SPEED S9999) ; F5';
    const m = maskComments(l);
    expect(m.length).toBe(l.length);
    expect(m.slice(0, 7)).toBe('S1400M3');
    expect(m).not.toMatch(/9999|F5/);
  });
});

describe('detectMaterial', () => {
  it('reads the file name first, as a whole token', () => {
    const d = detectMaterial({ fileName: '7075_1F-B-00180-004_FORK_END_OP10_MILL.nc', text: '' }, MATERIALS);
    expect(d).toMatchObject({ key: '7075-T73511', source: 'file name' });
  });

  it('falls back to a MATERIAL comment in the header', () => {
    const d = detectMaterial({ fileName: '1F-B-00180-000_FORK_END.nc', text: MILL }, MATERIALS);
    expect(d).toMatchObject({ key: '17-4PH', source: 'program comment' });
  });

  it('does not find an alias inside a longer number', () => {
    expect(detectMaterial({ fileName: 'PART_170750.nc', text: '' }, MATERIALS)).toBeNull();
  });

  it('prefers the longest alias and reports a disagreeing comment', () => {
    const d = detectMaterial({
      fileName: '17-4PH_FORK.NC',
      text: '(MATERIAL: Ti64)\nT1',
    }, MATERIALS);
    expect(d.key).toBe('17-4PH');
    expect(d.conflict).toBe('Ti-6Al-4V');
  });

  it('says nothing when nothing is named', () => {
    expect(detectMaterial({ fileName: 'program.nc', text: 'T1\nG1 X1' }, MATERIALS)).toBeNull();
  });
});

describe('scanProgram', () => {
  it('splits tool blocks and numbers repeated tools', () => {
    const s = scanProgram('T1(ENDMILL D8)\nS2400M3\nG1X1F600.\nT1(ENDMILL D8)\nS2400M3\nG1X2F600.', { mode: 'mill' });
    expect(s.blocks.map((b) => b.id)).toEqual(['T1#1', 'T1#2']);
  });

  it('keeps the program\'s own spelling of a lathe tool', () => {
    const s = scanProgram(TURN, { mode: 'turn' });
    expect(s.blocks.map((b) => b.label)).toEqual(['T0606', 'T0202', 'T0505']);
  });

  it('does not take a G50 clamp for a spindle speed, or a comment for a word', () => {
    const b = scanProgram(TURN, { mode: 'turn' }).blocks[0];
    expect(b.sWords.map((w) => w.value)).toEqual([1800]);
    expect(b.g50).toBe(2200);
    const m = scanProgram(MILL, { mode: 'mill' }).blocks;
    expect(m.flatMap((x) => x.sWords.map((w) => w.value))).not.toContain(9999);
  });

  it('sees a cutting G-word glued to its axis word, and G73 glued to G99', () => {
    const m = scanProgram(MILL, { mode: 'mill' }).blocks;
    expect(m[0].cut).toBe(true);   // G1Y-5.
    expect(m[1].cut).toBe(true);   // G99G73
  });
});

describe('operationOf', () => {
  it('classifies by tool, and refuses what the table does not cover', () => {
    const t = scanProgram(TURN, { mode: 'turn' }).blocks;
    expect(operationOf(t[0], 'turn')).toBe('turning');
    expect(operationOf(t[1], 'turn')).toBe('drilling');
    expect(operationOf(t[2], 'turn')).toBe('parting');
    const m = scanProgram(MILL, { mode: 'mill' }).blocks;
    expect(m.map((b) => operationOf(b, 'mill'))).toEqual(['milling', 'drilling', 'milling', 'reaming']);
  });
});

describe('proposeStd — milling', () => {
  const p = proposeStd(scanProgram(MILL, { mode: 'mill' }), M17, { maxRpm: 8000 });
  const by = (id) => p.rows.find((r) => r.id === id);

  it('leaves a tool that is already inside the range', () => {
    expect(by('T1#1')).toMatchObject({ status: 'ok' });   // 60.3 m/min on D8
    expect(by('T1#1').edits).toHaveLength(0);
  });

  it('raises a slow endmill to the lower bound and scales every feed with it', () => {
    const r = by('T5#1');
    expect(r.status).toBe('change');
    expect(r.sNew).toBe(2390);                 // ceil(1000*60 / (pi*8) / 10) * 10
    expect(r.vcNew).toBeGreaterThanOrEqual(60);
    const feeds = r.edits.filter((e) => e.kind === 'F').map((e) => e.next);
    expect(feeds).toEqual(['F560.', 'F280.']); // 400 and 200 x 2390/1700, decimal point kept
  });

  it('moves a drill a hair under the range, and finds the reamer far under it', () => {
    expect(by('T2#1')).toMatchObject({ status: 'change', sNew: 1420 }); // 39.6 m/min on D9
    expect(by('T2#1').edits.filter((e) => e.kind === 'F')).toHaveLength(0); // 100 x 1.01 rounds back to 100
    expect(by('T9#1')).toMatchObject({ status: 'change', sNew: 740 });    // D13 at S300 is 12 m/min
  });

  it('never proposes more rpm than the spindle has', () => {
    // Already running the spindle's best: 8000 rpm on D8 is 201 m/min, and 300 would need ~11900.
    const q = proposeStd(scanProgram('T1(ENDMILL D8)\nS8000M3\nG1X1F1600.', { mode: 'mill' }), M7075, { maxRpm: 8000 });
    const t1 = q.rows.find((r) => r.id === 'T1#1');
    expect(t1.status).toBe('limit');           // 8000 rpm on D8 is 201 m/min; 300 needs ~11900
    expect(t1.sNew).toBeNull();
    expect(t1.edits).toHaveLength(0);
  });

  it('reports a speed that gets closer but still falls short as capped', () => {
    const q = proposeStd(scanProgram('T1(ENDMILL D8)\nS5000M3\nG1X1F800.', { mode: 'mill' }), M7075, { maxRpm: 8000 });
    const r = q.rows[0];
    expect(r.status).toBe('change');
    expect(r.sNew).toBe(8000);
    expect(r.warnings.join(' ')).toMatch(/8000 rpm/);
  });
});

describe('proposeStd — turning', () => {
  const p = proposeStd(scanProgram(TURN, { mode: 'turn' }), M17, {});
  const by = (id) => p.rows.find((r) => r.id === id);

  it('replaces a G96 surface speed and leaves feed per revolution alone', () => {
    const r = by('T0606#1');
    expect(r.status).toBe('change');
    expect(r).toMatchObject({ css: true, sOld: 1800, sNew: 70, vcNew: 70 });
    expect(r.edits.map((e) => e.kind)).toEqual(['S']);
  });

  it('works a G97 drill\'s Vc from the diameter in its header', () => {
    const r = by('T0202#1');
    expect(r.diameter).toBe(8.5);
    expect(r.vcOld).toBeCloseTo(16.0, 0);
    expect(r.status).toBe('change');
    expect(r.sNew).toBe(1500);                 // 40 m/min on 8.5 mm
  });

  it('says so when the material has no range for the operation (parting here)', () => {
    expect(by('T0505#1')).toMatchObject({ status: 'no-standard', operation: 'parting' });
  });

  it('classifies parting, grooving and centre drills, and still leaves threading alone', () => {
    const MAT = { ...M17, vc: { ...M17.vc, parting: [61, 140], grooving: [61, 101], centre: [10, 13] } };
    const prog = [
      'T0505 (PARTING / GROOVING)', 'G96 S30 M3', 'G1 X-1. F0.05',
      'T0606 (GROOVING OD)', 'G96 S200 M3', 'G1 X10. F0.05',
      'T0707 (THREADING 1.5P)', 'G97 S400 M3', 'G92 X10. Z-20. F1.5',
    ].join('\n');
    const rows = proposeStd(scanProgram(prog, { mode: 'turn' }), MAT, {}).rows;
    const by = (id) => rows.find((r) => r.id === id);
    expect(by('T0505#1')).toMatchObject({ operation: 'parting', status: 'change', vcNew: 61 });
    expect(by('T0606#1')).toMatchObject({ operation: 'grooving', status: 'change', vcNew: 61 }); // above the range too: the lower bound, as everywhere
    expect(by('T0707#1')).toMatchObject({ operation: null, status: 'no-standard' });
  });

  it('treats a centre drill as its own operation in either mode', () => {
    const blocks = scanProgram('T1 (CENTER DRILL D3)\nM6\nS2000M3\nG81 Z-3. F100', { mode: 'mill' }).blocks;
    expect(operationOf(blocks[0], 'mill')).toBe('centre');
    expect(operationOf(blocks[0], 'turn')).toBe('centre');
  });

  it('does not call a mill tool "parting" or "grooving"', () => {
    const blocks = scanProgram('T2 (GROOVE CUTTER D6)\nM6\nS3000M3\nG1 X5. F200', { mode: 'mill' }).blocks;
    expect(operationOf(blocks[0], 'mill')).not.toBe('grooving');
  });

  it('needs a diameter for an rpm speed', () => {
    const q = proposeStd(scanProgram('T0303\nG97 S800 M3\nG1 X1 F0.1', { mode: 'turn' }), M17, {});
    // no descriptor, so this is not classified as a tool the table covers
    expect(q.rows[0].status).toBe('no-standard');
  });
});

describe('a diameter typed by the operator', () => {
  const MAT = { ...M17, vc: { ...M17.vc, centre: [10, 13] } };
  const PROG = 'T1 (CENTER DRILL)\nM6\nS2000M3\nG81 Z-3. F100\n';
  const scan = () => scanProgram(PROG, { mode: 'mill' });

  it('fills the gap and lets the row be worked out', () => {
    const none = proposeStd(scan(), MAT, { maxRpm: 8000 }).rows[0];
    expect(none.status).toBe('no-diameter');
    expect(none.diameterEditable).toBe(true);
    const id = none.id;
    const r = proposeStd(scan(), MAT, { maxRpm: 8000, diameters: { [id]: 3 } }).rows[0];
    expect(r.diameter).toBe(3);
    expect(r.diameterGiven).toBe(true);
    expect(r.status).toBe('change');
    expect(r.sNew).toBe(1070);
    // The Ø is for the sum only: the only edits are S and F.
    expect(r.edits.every((e) => e.kind === 'S' || e.kind === 'F')).toBe(true);
  });

  it('never overrides a diameter the program states', () => {
    const prog = 'T1 (DRILL 9)\nM6\nS1400M3\nG81 Z-3. F100\n';
    const s = scanProgram(prog, { mode: 'mill' });
    const id = s.blocks[0].id;
    const r = proposeStd(s, M17, { maxRpm: 8000, diameters: { [id]: 20 } }).rows[0];
    expect(r.diameter).toBe(9);
    expect(r.diameterEditable).toBe(false);
  });

  it('ignores zero or junk', () => {
    const id = scan().blocks[0].id;
    for (const v of [0, -2, 'x']) {
      expect(proposeStd(scan(), MAT, { diameters: { [id]: v } }).rows[0].status).toBe('no-diameter');
    }
  });
});

describe('applyStd', () => {
  const scan = () => scanProgram(MILL, { mode: 'mill' });

  it('writes only the proposed words, leaves comments and G50 alone', () => {
    const p = proposeStd(scan(), M17, { maxRpm: 8000 });
    const out = applyStd(MILL, p);
    expect(out.applied).toBe(p.changes);
    expect(out.stale).toBe(0);
    const lines = out.text.split('\n');
    expect(lines[2]).toBe('(MATERIAL: 17-4PH stainless -- S9999 F9999 are only in this comment)');
    expect(out.text).toContain('S2390M3\nG1X10.Y5.F560.');
    expect(out.text).toContain('G3X5.Y2.R4.F280.');
  });

  it('is a fixed point: proposing again after applying finds nothing to change', () => {
    const p = proposeStd(scan(), M17, { maxRpm: 8000 });
    const { text } = applyStd(MILL, p);
    const again = proposeStd(scanProgram(text, { mode: 'mill' }), M17, { maxRpm: 8000 });
    expect(again.changes).toBe(0);
  });

  it('skips a row the operator turned off', () => {
    const p = proposeStd(scan(), M17, { maxRpm: 8000 });
    const first = p.rows.find((r) => r.status === 'change');
    const out = applyStd(MILL, p, { skip: new Set([first.id]) });
    expect(out.applied).toBe(p.changes - 1);
  });

  it('refuses a row whose text no longer reads the same, rather than hit the wrong word', () => {
    const p = proposeStd(scan(), M17, { maxRpm: 8000 });
    const edited = MILL.replace('S1700M3', 'S1650M3');
    const out = applyStd(edited, p);
    expect(out.stale).toBeGreaterThan(0);
    expect(out.text).toContain('S1650M3'); // untouched
  });

  it('handles CRLF programs', () => {
    const crlf = TURN.split('\n').join('\r\n');
    const p = proposeStd(scanProgram(crlf, { mode: 'turn' }), M17, {});
    const out = applyStd(crlf, p);
    expect(out.text).toContain('G96 S70 M3\r\n');
    expect(out.stale).toBe(0);
  });
});

describe('a lathe tool has no diameter from its header', () => {
  it('does not read "ROUGHING CYCLE 2" as Ø2', () => {
    const s = scanProgram('G96 S60 M3\nT0808 (ROUGHING CYCLE 2)\nG1 X10. F0.2\n', { mode: 'turn' });
    expect(s.blocks[0].diameter).toBeNull();
  });
  it('still reads a drill on a lathe', () => {
    const s = scanProgram('G96 S60 M3\nT0909 (DRILL 8.5)\nG1 Z-10. F0.1\n', { mode: 'turn' });
    expect(s.blocks[0].diameter).toBe(8.5);
  });
});

describe('rowTimes', () => {
  it('bills each segment to the tool block whose lines it came from', () => {
    const rows = [
      { id: 'T1#1', startLine: 0, endLine: 2 },
      { id: 'T2#1', startLine: 3, endLine: 5 },
    ];
    const segs = [
      { line: 2, t: 1.5 }, { line: 3, t: 2 }, // lines are 1-based: 2 -> index 1 (T1), 3 -> index 2 (T1)
      { line: 4, t: 4 }, { line: 6, t: 0.5 }, // index 3 and 5 (T2)
      { line: 99, t: 7 }, { line: 5, t: 0 },  // outside every block / no time: ignored
    ];
    const t = rowTimes(segs, rows);
    expect(t['T1#1']).toBeCloseTo(3.5);
    expect(t['T2#1']).toBeCloseTo(4.5);
  });

  it('bills a G70 replay to the finishing tool, not to the block whose lines it re-runs', () => {
    const rows = [
      { id: 'T0606#1', tool: 606, startLine: 0, endLine: 9 },
      { id: 'T0404#1', tool: 404, startLine: 10, endLine: 15 },
    ];
    const segs = [
      { tool: 606, line: 5, t: 100 },
      { tool: 404, line: 4, t: 50 },   // replays the profile written at line 4, in T0606's block
      { tool: 404, line: 12, t: 2 },
    ];
    const t = rowTimes(segs, rows);
    expect(t['T0606#1']).toBeCloseTo(100);
    expect(t['T0404#1']).toBeCloseTo(52);
  });

  it('uses the line to choose between two blocks of the same tool', () => {
    const rows = [
      { id: 'T1#1', tool: 1, startLine: 0, endLine: 4 },
      { id: 'T1#2', tool: 1, startLine: 5, endLine: 9 },
    ];
    const t = rowTimes([{ tool: 1, line: 2, t: 3 }, { tool: 1, line: 8, t: 4 }], rows);
    expect(t['T1#1']).toBeCloseTo(3);
    expect(t['T1#2']).toBeCloseTo(4);
  });
});
