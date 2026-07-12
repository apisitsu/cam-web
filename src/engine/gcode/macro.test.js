import { describe, it, expect } from 'vitest';
import { expandProgram } from './macro.js';
import { interpret } from './interpreter.js';

const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const texts = (blocks) => blocks.map((b) => b.text);

describe('macro — pass-through', () => {
  it('leaves a program with no macros byte-for-byte alone', () => {
    const prog = 'G21 G90\nG0 X10 Y-2.5\n( note )\nG1 Z-1 F100';
    expect(texts(expandProgram(prog))).toEqual(prog.split('\n'));
  });
});

describe('macro — variables and expressions', () => {
  it('substitutes variables into address words', () => {
    const out = expandProgram('#1=10.\n#2=[#1*2]\nG1X#1Y#2');
    expect(texts(out)).toContain('G1X10Y20');
  });

  it('evaluates nested brackets, precedence and unary minus', () => {
    const out = expandProgram('#1=2\n#2=3\n#3=[#1+[#2*4]]\n#4=-[#3/7]\nG1X#3Y#4');
    expect(texts(out)).toContain('G1X14Y-2');
  });

  it('handles a negated variable directly after an address letter', () => {
    const out = expandProgram('#25=4.5\nG3Y-#25');
    expect(texts(out)).toContain('G3Y-4.5');
  });

  it('FUP rounds away from zero, FIX truncates toward it', () => {
    const out = expandProgram('#1=FUP[7.95]\n#2=FIX[7.95]\n#3=FUP[-1.2]\nG1X#1Y#2Z#3');
    expect(texts(out)).toContain('G1X8Y7Z-2');
  });

  it('ABS inside FUP, the shape real programs use for pass counts', () => {
    const out = expandProgram('#21=14.4\n#22=8.2\n#9=0.5\n#6=FUP[ABS[#21-#22]/#9]\nG1X#6');
    expect(texts(out)).toContain('G1X13');
  });

  it('warns when a variable is read before it is written', () => {
    const seen = [];
    expandProgram('G1X#77', (w) => seen.push(w));
    expect(seen.some((w) => w.includes('#77'))).toBe(true);
  });

  it('reports the source line of a malformed expression', () => {
    expect(() => expandProgram('#1=1\nG1X[#1+]')).toThrow(/Line 2/);
  });
});

describe('macro — control flow', () => {
  it('unrolls a WHILE loop, counting down', () => {
    const out = texts(expandProgram('#1=3\nWHILE[#1GT0]DO1\nG1X#1\n#1=#1-1\nEND1'));
    expect(out).toEqual(['G1X3', 'G1X2', 'G1X1']);
  });

  it('skips the body entirely when the condition starts false', () => {
    const out = texts(expandProgram('#1=0\nWHILE[#1GT0]DO1\nG1X#1\nEND1\nG0Z5'));
    expect(out).toEqual(['G0Z5']);
  });

  it('nests DO2 inside DO1', () => {
    const prog = [
      '#1=2', 'WHILE[#1GT0]DO1',
      '#2=2', 'WHILE[#2GT0]DO2',
      'G1X#1Y#2', '#2=#2-1', 'END2',
      '#1=#1-1', 'END1',
    ].join('\n');
    expect(texts(expandProgram(prog)))
      .toEqual(['G1X2Y2', 'G1X2Y1', 'G1X1Y2', 'G1X1Y1']);
  });

  it('runs IF/GOTO and IF/THEN', () => {
    const out = texts(expandProgram('#1=5\nIF[#1EQ5]GOTO100\nG1X999\nN100 G1X#1'));
    expect(out).toEqual(['N100 G1X5']);
    const then = texts(expandProgram('#1=1\nIF[#1EQ1]THEN#2=7\nG1X#2'));
    expect(then).toEqual(['G1X7']);
  });

  it('rejects an unbalanced DO/END', () => {
    expect(() => expandProgram('WHILE[1EQ1]DO1\nG1X1')).toThrow(/never closed/);
    expect(() => expandProgram('END1')).toThrow(/does not close/);
  });

  it('stops a runaway loop instead of exhausting memory', () => {
    expect(() => expandProgram('#1=1\nWHILE[#1EQ1]DO1\nG1X1\nEND1')).toThrow(/ran away|too large/);
  });
});

describe('macro — source line mapping', () => {
  it('every emitted block points at the line it came from', () => {
    const out = expandProgram('#1=2\nWHILE[#1GT0]DO1\nG1X#1\n#1=#1-1\nEND1');
    expect(out.map((b) => b.line)).toEqual([3, 3]);
  });

  it('a toolpath segment reports the source line, not the unrolled block', () => {
    const { segments } = interpret('#1=2\nWHILE[#1GT0]DO1\nG1X#1F100\n#1=#1-1\nEND1');
    expect(segments.every((s) => s.line === 3)).toBe(true);
  });
});

describe('interpreter — 4th axis and reference return', () => {
  it('rotates each A index onto the part frame', () => {
    // At A90 the table has turned the part 90° about X, so a tool 10 mm up the
    // machine Z axis is 10 mm along the part's +Y.
    const { segments } = interpret('G90 G0 A90.\nG1 X0 Y0 Z10 F100');
    const s = segments[segments.length - 1];
    expect(near(s.b[1], 10)).toBe(true);
    expect(near(s.b[2], 0)).toBe(true);
  });

  it('A180 puts the two faces of a part on opposite sides', () => {
    const at = (deg) => {
      const { segments } = interpret(`G90 G0 A${deg}.\nG1 X0 Y0 Z5 F100`);
      return segments[segments.length - 1].b;
    };
    expect(near(at(0)[2], 5)).toBe(true);
    expect(near(at(180)[2], -5)).toBe(true);
  });

  it('rotaryFrame machine leaves coordinates as programmed', () => {
    const { segments } = interpret('G90 G0 A90.\nG1 X0 Y0 Z10 F100', { rotaryFrame: 'machine' });
    const s = segments[segments.length - 1];
    expect(near(s.b[2], 10)).toBe(true);
    expect(s.a4).toBe(90);
  });

  it('collects the distinct rotary indices', () => {
    const { stats } = interpret('G90 G0 A90.\nG1 X1 F100\nG0 A270.\nG1 X2');
    expect(stats.aIndices).toEqual([0, 90, 270]);
  });

  it('G28 draws only its intermediate point and warns', () => {
    const { segments, stats } = interpret('G90 G0 X10 Y10 Z10\nG91 G28 Z0.\nG90');
    expect(segments[segments.length - 1].b).toEqual([10, 10, 10]); // Z0 incremental = no move
    expect(stats.warnings.some((w) => w.includes('G28'))).toBe(true);
  });

  it('G80 with coordinates still retracts', () => {
    const prog = 'G90 G0 Z5\nG81 X10 Y10 Z-6 R2 F100\nG80 Z100.';
    const { segments } = interpret(prog);
    const last = segments[segments.length - 1];
    expect(last.type).toBe('rapid');
    expect(near(last.b[2], 100)).toBe(true);
  });

  it('a modal arc block carrying only centre offsets is a full circle', () => {
    const { segments } = interpret('G21 G90 G17\nG1 X12 Y0 F100\nG3 X12 Y0 I-12 J0\nJ-12');
    // The bare `J-12` block repeats G3 and sweeps another full circle.
    const arcs = segments.filter((s) => s.line === 4);
    expect(arcs.length).toBeGreaterThan(16);
  });
});
