import { describe, it, expect } from 'vitest';
import {
  STANDARD_TURN_TOOLS, effectiveTurnTool, turningCutMode, turningCutModeResolver,
  turningCutRadiusResolver, turningGrooveWidthResolver,
  createTurningStock, carveTurningMove, carveTurning, turningMesh, detectFaceZ,
} from './turning.js';

describe('effectiveTurnTool — the toolholder the marker should draw', () => {
  it('draws the holder the program\'s own comment implies, not the global default', () => {
    // The bug this exists for: T0909(INTERNAL THREAD BAR ..) still drew
    // whatever the global picker held, because only the operator's override
    // and that default were ever read. Every tool in the spindle looked like
    // the same one holder.
    const t = effectiveTurnTool({
      detected: { type: 'bore' }, overrideId: null, fallbackId: 'mvjnr',
    });
    expect(t.id).toBe('boring');
  });

  it('lets the operator override what the comment implies', () => {
    const t = effectiveTurnTool({
      detected: { type: 'bore' }, overrideId: 'threadbar', fallbackId: 'mvjnr',
    });
    expect(t.id).toBe('threadbar');
  });

  it('falls back to the global default for an OD turning comment', () => {
    // 'od' is deliberately not in the type->holder map: an "OD ROUGH" comment
    // needs no special case to land on an OD holder, because that is already
    // what the global default is for.
    const t = effectiveTurnTool({
      detected: { type: 'endmill', unclassified: true }, overrideId: null, fallbackId: 'dclnr',
    });
    expect(t.id).toBe('dclnr');
  });

  it('maps parting and thread the same way as bore', () => {
    expect(effectiveTurnTool({ detected: { type: 'parting' }, fallbackId: 'mvjnr' }).id)
      .toBe('parting');
    expect(effectiveTurnTool({ detected: { type: 'thread' }, fallbackId: 'mvjnr' }).id)
      .toBe('threadtool');
  });

  it('draws a thread whose comment says INTERNAL / ID with the threading bar', () => {
    // T0404 (INTERNAL THREAD .375-24 UNJF-3B-LH) drew the external threading tool.
    const d = (desc) => effectiveTurnTool({ detected: { type: 'thread', desc }, fallbackId: 'mvjnr' }).id;
    expect(d('INTERNAL THREAD .375-24 UNJF-3B-LH')).toBe('threadbar');
    expect(d('ID THREAD M10x1')).toBe('threadbar');
    expect(d('EXTERNAL THREAD TOOL')).toBe('threadtool');
    expect(d('THREAD M10')).toBe('threadtool');
    // The operator's own pick still wins.
    expect(effectiveTurnTool({
      detected: { type: 'thread', desc: 'INTERNAL THREAD' }, overrideId: 'threadtool', fallbackId: 'mvjnr',
    }).id).toBe('threadtool');
  });

  it('maps the axial tool types to their own markers, not the OD default', () => {
    expect(effectiveTurnTool({ detected: { type: 'drill' }, fallbackId: 'mvjnr' }).id)
      .toBe('drillbit');
    expect(effectiveTurnTool({ detected: { type: 'reamer' }, fallbackId: 'mvjnr' }).id)
      .toBe('reamerbit');
    expect(effectiveTurnTool({ detected: { type: 'tap' }, fallbackId: 'mvjnr' }).id)
      .toBe('tapbit');
    // T0303(CENTER DRILL) is detected as 'chamfer' — the category it shares
    // with an actual chamfer mill — and on a lathe that means a centre drill.
    expect(effectiveTurnTool({ detected: { type: 'chamfer' }, fallbackId: 'mvjnr' }).id)
      .toBe('centerdrill');
  });

  it('finds an operator-defined holder alongside the built-in catalogue', () => {
    const custom = [{ id: 'custom-1', label: 'My 107.5°', kind: 'od', lead: 107.5, sides: 4, angle: 55, flip: true }];
    const t = effectiveTurnTool({ overrideId: 'custom-1', fallbackId: 'mvjnr', custom });
    expect(t.id).toBe('custom-1');
    expect(t.lead).toBe(107.5);
  });

  it('a custom id still wins as the global default (fallbackId), not just an override', () => {
    const custom = [{ id: 'custom-1', label: 'My holder', kind: 'od', lead: 90, sides: 4, angle: 80, flip: true }];
    const t = effectiveTurnTool({ fallbackId: 'custom-1', custom });
    expect(t.id).toBe('custom-1');
  });

  it('a dangling custom id (deleted) falls back to the first catalogue entry, same as any unknown id', () => {
    const t = effectiveTurnTool({ overrideId: 'custom-deleted', fallbackId: 'mvjnr', custom: [] });
    expect(t.id).toBe(STANDARD_TURN_TOOLS[0].id);
  });

  it('falls back to the catalogue\'s first entry if the resolved id is unknown', () => {
    const t = effectiveTurnTool({ detected: null, overrideId: 'not-a-real-id', fallbackId: null });
    expect(t).toBe(STANDARD_TURN_TOOLS[0]);
  });
});

describe('turningCutMode — which boundary a tool\'s cuts carve', () => {
  it('reads bore, drill, reamer, tap and chamfer as id', () => {
    for (const type of ['bore', 'drill', 'reamer', 'tap', 'chamfer']) {
      expect(turningCutMode({ type })).toBe('id');
    }
  });

  it('reads everything else, including an unclassified comment, as od', () => {
    expect(turningCutMode({ type: 'parting' })).toBe('od');
    expect(turningCutMode({ type: 'endmill', unclassified: true })).toBe('od');
    expect(turningCutMode(null)).toBe('od');
  });

  it('reads thread off the tool\'s own description, the one type bore/drill/etc cannot settle', () => {
    expect(turningCutMode({ type: 'thread', desc: 'INTERNAL THREAD BAR -- 60deg' })).toBe('id');
    expect(turningCutMode({ type: 'thread', desc: 'EXTERNAL THREAD TOOL -- 60deg' })).toBe('od');
    // No word either way: defaults to 'od', the behaviour every thread tool
    // had before this distinction existed — never a new, silent behaviour.
    expect(turningCutMode({ type: 'thread', desc: 'THREAD TOOL' })).toBe('od');
  });

  it('builds a per-tool-number resolver from a stats.tools-shaped list', () => {
    const resolve = turningCutModeResolver([
      { n: 606, type: 'endmill' },
      { n: 505, type: 'drill' },
      { n: 707, type: 'bore' },
    ]);
    expect(resolve({ tool: 606 })).toBe('od');
    expect(resolve({ tool: 505 })).toBe('id');
    expect(resolve({ tool: 707 })).toBe('id');
    expect(resolve({ tool: 9999 })).toBe('od'); // tool never detected
  });
});

describe('turningCutRadiusResolver — the fixed bore a centreline tool cuts', () => {
  it('reads the tool\'s own diameter for drill, reamer, tap and chamfer', () => {
    const resolve = turningCutRadiusResolver([
      { n: 202, type: 'drill', diameter: 8.5 },
      { n: 303, type: 'reamer', diameter: 6 },
      { n: 404, type: 'tap', diameter: 5 },
      { n: 101, type: 'chamfer', diameter: 2 },
    ]);
    expect(resolve({ tool: 202 })).toBeCloseTo(4.25);
    expect(resolve({ tool: 303 })).toBe(3);
    expect(resolve({ tool: 404 })).toBe(2.5);
    expect(resolve({ tool: 101 })).toBe(1);
  });

  it('never overrides a boring bar — it is fed along the real bore profile', () => {
    const resolve = turningCutRadiusResolver([{ n: 707, type: 'bore', diameter: 18 }]);
    expect(resolve({ tool: 707 })).toBe(0);
  });

  it('is 0 (no override) for an od tool, an undetected tool, or a tool with no diameter word', () => {
    const resolve = turningCutRadiusResolver([
      { n: 606, type: 'endmill' },
      { n: 202, type: 'drill', diameter: null },
    ]);
    expect(resolve({ tool: 606 })).toBe(0);
    expect(resolve({ tool: 202 })).toBe(0);
    expect(resolve({ tool: 9999 })).toBe(0);
  });

  it('lets the operator\'s own ⌀ override the comment\'s — same precedence as the marker', () => {
    // T0202's comment never gave a size, or got it wrong; the Tool table's own
    // ⌀ (Setup's `setToolOverride`) wins, same as `effectiveTool` does for the
    // marker — the hole on screen and the hole actually cut must agree.
    const resolve = turningCutRadiusResolver(
      [{ n: 202, type: 'drill', diameter: 8.5 }],
      { 202: { diameter: 10 } },
    );
    expect(resolve({ tool: 202 })).toBe(5);
  });

  it('states a radius from the override alone, for a tool whose comment named none', () => {
    const resolve = turningCutRadiusResolver(
      [{ n: 303, type: 'chamfer', diameter: null }],
      { 303: { diameter: 3 } },
    );
    expect(resolve({ tool: 303 })).toBe(1.5);
  });

  it('still refuses a boring bar, even with an override on its number', () => {
    const resolve = turningCutRadiusResolver(
      [{ n: 707, type: 'bore', diameter: 18 }],
      { 707: { diameter: 20 } },
    );
    expect(resolve({ tool: 707 })).toBe(0);
  });
});

describe('turningGrooveWidthResolver — how wide a parting blade cuts', () => {
  it('gives a detected parting tool the catalogue default of 3mm', () => {
    const resolve = turningGrooveWidthResolver([{ n: 505, type: 'parting' }]);
    expect(resolve({ tool: 505 })).toBe(3);
  });

  it('lets the operator\'s own "w" override the default', () => {
    const resolve = turningGrooveWidthResolver(
      [{ n: 505, type: 'parting' }],
      { 505: { grooveW: 4.5 } },
    );
    expect(resolve({ tool: 505 })).toBe(4.5);
  });

  it('also recognises a tool the operator picked as parting by hand, undetected by the comment', () => {
    // A bare `T6` with no comment at all: `t.type` never resolves to
    // 'parting', but the operator chose that holder in the Tool table.
    const resolve = turningGrooveWidthResolver(
      [{ n: 6, type: 'endmill', unclassified: true }],
      { 6: { insert: 'parting' } },
    );
    expect(resolve({ tool: 6 })).toBe(3);
  });

  it('is 0 for anything that is not a parting tool, so other zero-dz moves keep their old single-cell carve', () => {
    const resolve = turningGrooveWidthResolver([
      { n: 606, type: 'endmill' },       // a facing pass with an OD tool
      { n: 707, type: 'bore' },
    ]);
    expect(resolve({ tool: 606 })).toBe(0);
    expect(resolve({ tool: 707 })).toBe(0);
    expect(resolve({ tool: 9999 })).toBe(0);
  });
});

describe('carveTurningMove — od vs id carving', () => {
  // ⌀20 bar (radius 10), 30mm long.
  const freshStock = () => createTurningStock(
    { min: [0, 0, -30], max: [10, 0, 0] }, { cellSize: 1, margin: 0, rStock: 10 },
  );

  it('od (the default) behaves exactly as before: shrinks the outer radius', () => {
    const s = freshStock();
    carveTurningMove(s, [10, 0, 0], [10, 0, -20], 0); // mode omitted
    carveTurningMove(s, [4, 0, 0], [4, 0, -20], 0, 'od'); // constant radius, no taper
    expect(Math.min(...s.radius)).toBeCloseTo(4, 3);
    expect(Math.max(...s.bore)).toBe(0); // od never touches the bore
  });

  it('id grows the bore instead of shrinking the OD — the bug this exists for', () => {
    const s = freshStock();
    // A drill plunging straight down the centreline, as T0505's G74 peck
    // cycle does: constant small X, moving in Z.
    carveTurningMove(s, [0, 0, 0], [0, 0, -20], 0, 'id');
    // The OD must still be the full, untouched bar — this is exactly the
    // "material disappears along the drilled length" symptom.
    expect(Math.min(...s.radius)).toBeCloseTo(10, 3);
    // A Ø0 drill removes nothing; use a Ø3 (radius 1.5) drill to see growth.
    // The stock spans Z −30..0 at 1mm cells (index 0 = deepest, into the
    // chuck); a move from Z0 to Z−20 lands on cell indices 10..29.
    const s2 = freshStock();
    carveTurningMove(s2, [1.5, 0, 0], [1.5, 0, -20], 0, 'id');
    expect(Math.min(...s2.radius)).toBeCloseTo(10, 3); // OD still untouched
    const cut = s2.bore.slice(10, 30); // the drilled 20mm
    expect(Math.min(...cut)).toBeCloseTo(1.5, 3);
    expect(Math.max(...s2.bore.slice(0, 10))).toBe(0); // nothing past the drilled depth
  });

  it('minRadius bores a drill fed down the centreline (X0) to the tool\'s own diameter', () => {
    // The real bug: a drill is programmed at X0 for its whole stroke — the
    // path carries no diameter at all — so without a floor this is the exact
    // "Ø0 drill removes nothing" case above, and worse, if 'od' mode were
    // ever picked for it by mistake the OD would collapse to 0 along the
    // whole drilled length (TestSleeve02's "เนื้อหายไปทั้ง plan").
    const s = freshStock();
    carveTurningMove(s, [0, 0, 0], [0, 0, -20], 0, 'id', 4.25); // ⌀8.5 drill, X0 throughout
    expect(Math.min(...s.radius)).toBeCloseTo(10, 3); // OD untouched
    const cut = s.bore.slice(10, 30);
    expect(Math.min(...cut)).toBeCloseTo(4.25, 3);
    expect(Math.max(...s.bore.slice(0, 10))).toBe(0); // still blind past the drilled depth
  });

  it('minRadius has no effect in od mode, or when 0/omitted', () => {
    const s = freshStock();
    carveTurningMove(s, [4, 0, 0], [4, 0, -20], 0, 'od', 9); // od ignores the floor
    expect(Math.min(...s.radius)).toBeCloseTo(4, 3);
    const s2 = freshStock();
    carveTurningMove(s2, [1.5, 0, 0], [1.5, 0, -20], 0, 'id'); // omitted == old behaviour
    expect(Math.min(...s2.bore.slice(10, 30))).toBeCloseTo(1.5, 3);
  });

  it('clamps the bore to never exceed the OD still standing there', () => {
    const s = freshStock();
    // Stock spans Z −30..0 at 1mm cells; both moves (Z0 to Z−10) land on 20..29.
    carveTurningMove(s, [6, 0, 0], [6, 0, -10], 0, 'od'); // OD turned to 6 for 10mm, no taper
    carveTurningMove(s, [20, 0, 0], [20, 0, -10], 0, 'id'); // an oversized bore attempt
    expect(Math.max(...s.bore.slice(20, 30))).toBeLessThanOrEqual(6 + 1e-6);
  });

  it('od never cuts below the bore already there (no negative wall thickness)', () => {
    const s = freshStock();
    carveTurningMove(s, [3, 0, 0], [3, 0, -10], 0, 'id'); // bore to 3
    carveTurningMove(s, [10, 0, 0], [1, 0, -10], 0, 'od'); // OD pass tries to go below 3
    expect(Math.min(...s.radius.slice(20, 30))).toBeGreaterThanOrEqual(3 - 1e-6);
  });

  it('a pure radial move — no Z word at all — still cuts, the bug this exists for', () => {
    // A cut-off pass: `G0 Z-15` then `G1 X2 F0.06`, no Z on the second block —
    // za and zb are the same stored number, bit for bit. zLo/zHi used to be a
    // zero-width range no slice centre could ever fall inside, so the groove
    // never appeared and the part read as never parted at all.
    const s = freshStock();
    carveTurningMove(s, [10, 0, -15], [2, 0, -15], 0, 'od');
    // Z −30..0 at 1mm cells; the one slice nearest Z−15 is index 14 or 15.
    const k = s.radius.findIndex((r) => r <= 2 + 1e-6);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(s.radius[k]).toBeCloseTo(2, 6);
    // Nothing either side of that one slice moved.
    expect(s.radius[k - 1]).toBeCloseTo(10, 6);
    expect(s.radius[k + 1]).toBeCloseTo(10, 6);
  });

  it('a pure radial move in id mode grows the bore to its largest reach, not its smallest', () => {
    const s = freshStock();
    carveTurningMove(s, [0, 0, -15], [6, 0, -15], 0, 'id'); // a face groove on a bore, sweeping outward
    const k = s.bore.findIndex((r) => r >= 6 - 1e-6);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(s.bore[k]).toBeCloseTo(6, 6);
    expect(s.bore[k - 1]).toBe(0);
    expect(s.bore[k + 1]).toBe(0);
  });

  it('a groove width widens the cut to the blade\'s real width, not one cell', () => {
    // The follow-on bug: the fix above cut exactly one cell, which is the
    // grid's resolution, not the blade's — a 3mm-wide parting tool read as a
    // sliver next to the marker drawn at its real width.
    const s = freshStock();
    carveTurningMove(s, [10, 0, -15], [2, 0, -15], 0, 'od', 0, 3); // 3mm-wide blade
    const cut = [];
    for (let k = 0; k < s.radius.length; k++) if (s.radius[k] <= 2 + 1e-6) cut.push(k);
    // 3mm of 1mm cells is 3 cells (give or take grid alignment) — certainly
    // more than the single cell the un-widened move left.
    expect(cut.length).toBeGreaterThanOrEqual(2);
    expect(cut.length).toBeLessThanOrEqual(4);
    // Every cell the groove touches reaches the same depth — a blade's edge
    // is flat, not angled.
    for (const k of cut) expect(s.radius[k]).toBeCloseTo(2, 6);
    // Still nothing beyond the groove's own span.
    expect(s.radius[cut[0] - 1]).toBeCloseTo(10, 6);
    expect(s.radius[cut[cut.length - 1] + 1]).toBeCloseTo(10, 6);
  });

  it('0/omitted groove width keeps the old single-cell carve', () => {
    const s = freshStock();
    carveTurningMove(s, [10, 0, -15], [2, 0, -15], 0, 'od'); // grooveWidth omitted
    const cut = [];
    for (let k = 0; k < s.radius.length; k++) if (s.radius[k] <= 2 + 1e-6) cut.push(k);
    expect(cut.length).toBe(1);
  });

  it('is edge-referenced, not centred — the programmed Z is the edge kept, not the middle of the kerf', () => {
    // A real tool offset is touched off to ONE point on the insert, so the
    // kept material sits flush against the programmed Z and the kerf lands
    // entirely on the far side. The bug: centring a 2mm blade on Z-15 ate 1mm
    // into material a prior OD pass had already turned to its final length —
    // "programmed Z-30.5 for a 30.5mm part" read as 29.5mm.
    const s = freshStock();
    carveTurningMove(s, [8, 0, 0], [8, 0, -15], 0, 'od');       // OD pass: Z0 to Z-15 turned to radius 8
    carveTurningMove(s, [8, 0, -15], [2, 0, -15], 0, 'od', 0, 2); // parts off AT Z-15, a 2mm blade

    const cut = [];
    for (let k = 0; k < s.radius.length; k++) if (s.radius[k] <= 2 + 1e-6) cut.push(k);
    expect(cut.length).toBeGreaterThanOrEqual(1);
    const hi = Math.max(...cut); // the cell nearest Z-15, the kept side
    const lo = Math.min(...cut); // the cell nearest the chuck side

    // Every cell from the groove up to Z0 — the already-turned length — is
    // untouched: still radius 8, not eaten into by the kerf.
    for (let k = hi + 1; k < s.radius.length; k++) expect(s.radius[k]).toBeCloseTo(8, 6);
    // Past the kerf (toward the chuck), the raw bar is untouched too.
    expect(s.radius[lo - 1]).toBeCloseTo(10, 6);
  });

  it('still leaves the true faced end alone — the billet truncation makes that face, not this move', () => {
    // Regression: the fix above first carved the end slice to the facing
    // move's own smallest radius (effectively 0), turning a flat end into a
    // cone — the exact fault the pre-existing `stampTurning` guard already
    // avoided for the round-nose branch.
    const s = createTurningStock(
      { min: [0, 0, -30.3], max: [12, 0, 0] }, { cellSize: 0.5, margin: 1, rStock: 12, faceZ: 0, chuckClear: 20 },
    );
    carveTurningMove(s, [12, 0, 0], [0, 0, 0], 0, 'od'); // facing pass, exactly at the faced Z
    expect(s.radius[s.nz - 1]).toBeCloseTo(12, 6); // untouched — the billet already ends here
  });

  it('does not fire for a real curve\'s short chord — only an exact-zero dz', () => {
    // Guards the distinction the fix relies on: a tessellated arc always has
    // some genuine, if tiny, dz; only a move with literally no Z word (dz
    // bit-identical to 0) takes the new branch. A hair of real dz must still
    // go through the ordinary slice search below, unchanged.
    const s = freshStock();
    carveTurningMove(s, [10, 0, -15], [2, 0, -15.0000001], 0, 'od');
    // With real (if tiny) dz, the ordinary search may legitimately find no
    // slice centre in range and carve nothing — that is the pre-existing,
    // deliberate behaviour for a short curve chord, not a regression.
    expect(Math.min(...s.radius)).toBeGreaterThanOrEqual(2 - 1e-3);
  });
});

describe('carveTurning — end to end with a resolver', () => {
  it('a program with an OD rough tool and a drill tool carves an annulus, not a vanished bar', () => {
    const stock = createTurningStock(
      { min: [0, 0, -25], max: [10, 0, 0] }, { cellSize: 1, margin: 0, rStock: 10 },
    );
    const segments = [
      { type: 'feed', a: [8, 0, 0], b: [8, 0, -25], tool: 606 }, // OD rough, constant radius
      { type: 'feed', a: [1, 0, 0], b: [1, 0, -15], tool: 505 },  // drill, Ø2
    ];
    const modeOf = turningCutModeResolver([
      { n: 606, type: 'endmill' },
      { n: 505, type: 'drill' },
    ]);
    const { removedVolume } = carveTurning(stock, segments, { noseR: 0 }, modeOf);
    expect(Math.min(...stock.radius)).toBeCloseTo(8, 3); // OD pass still ran
    // Stock spans Z −25..0 at 1mm cells; the drill (Z0 to Z−15) lands on 10..24.
    expect(Math.max(...stock.bore.slice(10, 25))).toBeCloseTo(1, 3); // hole present
    expect(Math.max(...stock.bore.slice(0, 10))).toBe(0); // blind — stops at 15mm
    expect(removedVolume).toBeGreaterThan(0);
  });

  it('a drill programmed at X0 (the real convention) bores to its own diameter, not the OD', () => {
    // TestSleeve02's actual shape: `G0 X0.0 Z2.0` then a G74 peck cycle, X
    // never leaving the centreline. Without `radiusOf` this drilled the OD
    // straight down to 0 for the whole stroke.
    const stock = createTurningStock(
      { min: [0, 0, -30], max: [10, 0, 0] }, { cellSize: 1, margin: 0, rStock: 10 },
    );
    const segments = [
      { type: 'feed', a: [8, 0, 0], b: [8, 0, -30], tool: 707 }, // OD rough
      { type: 'feed', a: [0, 0, 0], b: [0, 0, -20], tool: 202 },  // drill at X0
    ];
    const modeOf = turningCutModeResolver([
      { n: 707, type: 'endmill' },
      { n: 202, type: 'drill' },
    ]);
    const radiusOf = turningCutRadiusResolver([
      { n: 202, type: 'drill', diameter: 8.5 },
    ]);
    carveTurning(stock, segments, { noseR: 0 }, modeOf, radiusOf);
    expect(Math.min(...stock.radius)).toBeCloseTo(8, 3); // OD pass still ran
    expect(Math.min(...stock.bore.slice(10, 30))).toBeCloseTo(4.25, 3); // a real hole
  });
});

describe('turningMesh — rendering a bore', () => {
  const stockWithBlindHole = () => {
    const s = createTurningStock(
      { min: [0, 0, -20], max: [10, 0, 0] }, { cellSize: 1, margin: 0, rStock: 10, faceZ: 0 },
    );
    carveTurningMove(s, [1.5, 0, 0], [1.5, 0, -12], 0, 'id'); // blind hole, opens at the face
    return s;
  };

  it('produces extra geometry for the bore, all of it finite', () => {
    const plain = createTurningStock(
      { min: [0, 0, -20], max: [10, 0, 0] }, { cellSize: 1, margin: 0, rStock: 10, faceZ: 0 },
    );
    const plainMesh = turningMesh(plain, 16);
    const bored = turningMesh(stockWithBlindHole(), 16);
    expect(bored.positions.length).toBeGreaterThan(plainMesh.positions.length);
    for (let i = 0; i < bored.positions.length; i++) {
      expect(Number.isFinite(bored.positions[i])).toBe(true);
      expect(Number.isFinite(bored.normals[i])).toBe(true);
    }
    // Every index must point at a real vertex.
    const nv = bored.positions.length / 3;
    for (let i = 0; i < bored.indices.length; i++) {
      expect(bored.indices[i]).toBeLessThan(nv);
    }
  });

  it('handles a through-hole reaching both true ends without degenerating', () => {
    const s = createTurningStock(
      { min: [0, 0, -20], max: [10, 0, 0] }, { cellSize: 1, margin: 0, rStock: 10, faceZ: 0, chuckClear: 0 },
    );
    carveTurningMove(s, [1.5, 0, 0], [1.5, 0, -20], 0, 'id'); // the full length
    const m = turningMesh(s, 16);
    expect(m.positions.length).toBeGreaterThan(0);
    for (let i = 0; i < m.positions.length; i++) expect(Number.isFinite(m.positions[i])).toBe(true);
  });

  it('handles an isolated single-cell bore (touching neither end) without degenerating', () => {
    const s = createTurningStock(
      { min: [0, 0, -20], max: [10, 0, 0] }, { cellSize: 1, margin: 0, rStock: 10, faceZ: 0 },
    );
    carveTurningMove(s, [2, 0, -9], [2, 0, -10], 0, 'id'); // one cell, mid-part
    const m = turningMesh(s, 16);
    for (let i = 0; i < m.positions.length; i++) expect(Number.isFinite(m.positions[i])).toBe(true);
  });

  it('a stock with no bore anywhere meshes exactly as it did before (no regression)', () => {
    const s = createTurningStock(
      { min: [0, 0, -20], max: [10, 0, 0] }, { cellSize: 1, margin: 0, rStock: 10, faceZ: 0 },
    );
    carveTurningMove(s, [10, 0, 0], [6, 0, -20], 0, 'od');
    const m = turningMesh(s, 16);
    // Solid part: every vertex at r=0 is only the two end-cap centres.
    let centreCount = 0;
    for (let i = 0; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i]) < 1e-9 && Math.abs(m.positions[i + 1]) < 1e-9) centreCount += 1;
    }
    expect(centreCount).toBe(2);
  });
});

describe('detectFaceZ — finding the face without requiring it near the axis', () => {
  it('finds the face on a bored part, whose OD facing cut never gets near Ø0', () => {
    // A flange-and-bore part: the OD tool faces from radius 5.5 to 6.5 (a
    // bore, cut separately by a different tool, occupies the middle) — the
    // old `minR < 3` requirement made this return null for every part shaped
    // like this, not just an unusual one.
    const segs = [
      { type: 'rapid', a: [8.5, 0, 2], b: [5.5, 0, 2] },
      { type: 'feed', a: [5.5, 0, 2], b: [5.5, 0, 0] }, // approach down to Z0
      { type: 'feed', a: [5.5, 0, 0], b: [6.5, 0, 0] }, // the facing cut itself
      { type: 'feed', a: [6.5, 0, 0], b: [6.5, 0, -40] }, // OD turning
    ];
    expect(detectFaceZ(segs)).toBe(0);
  });

  it('finds the face at exactly a 1mm-radius facing step, the real case that found this', () => {
    // 1F-B-... isn't this one — a flange part whose "turn up to main OD" cut
    // was exactly 1.0mm of radius (a 2mm diameter step). The old `dr > 1`
    // excluded it by the width of a rounding error, and detectFaceZ fell
    // back silently to `bounds.feedMax`, which (for this exact program
    // shape) read a couple of mm past the true face — see interpreter.js's
    // semi-finish-pass comment for where that extra reach came from.
    const segs = [
      { type: 'feed', a: [5.5, 0, 0], b: [6.5, 0, 0] }, // dr === 1.0 exactly
      { type: 'feed', a: [6.5, 0, 0], b: [6.5, 0, -6.3] },
    ];
    expect(detectFaceZ(segs)).toBe(0);
  });

  it('still ignores a chamfer — dz too large relative to dr to be a facing cut', () => {
    const segs = [
      { type: 'feed', a: [7.0, 0, 0], b: [7.5, 0, -5.05] }, // a 45°-ish chamfer
    ];
    expect(detectFaceZ(segs)).toBeNull();
  });
});
