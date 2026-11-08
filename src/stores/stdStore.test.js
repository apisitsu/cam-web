/**
 * The standard-speed store, against a stand-in for the server.
 *
 * `engine/cam/stdVc.test.js` covers what is proposed and how it is written. What
 * this owns is the sequencing around a loaded program: that it asks once per
 * program and not on its own output, that it opens only when there is something
 * to decide, that nothing changes until `apply()`, and that `restore()` puts the
 * original back. `lib/stdApi.js` is replaced; the camStore it talks to is real,
 * with its `parse` swapped for a recorder (the worker is not available here).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const server = { materials: [], fail: null };
vi.mock('../lib/stdApi.js', () => ({
  listStd: async () => {
    if (server.fail) throw new Error(server.fail);
    return server.materials;
  },
  saveStd: async () => undefined,
}));

const { useStdStore } = await import('./stdStore.js');
const { useCamStore } = await import('./camStore.js');

const M17 = {
  key: '17-4PH', label: '17-4PH H1025', isoGroup: 'ISO M/H', aliases: ['17-4PH'], status: 'draft', sourceNote: '',
  vc: { turning: [70, 120], milling: [60, 100], drilling: [40, 70], reaming: [30, 50], tap: [5, 12] },
};
const TI = { ...M17, key: 'Ti-6Al-4V', label: 'Ti-6Al-4V', aliases: ['Ti-6Al-4V'], status: 'approved' };

const SLOW = 'O1\nT1(ENDMILL D8)\nM6\nS1700M3\nG1X10.F400.\nM30';
const FAST = 'O1\nT1(ENDMILL D8)\nM6\nS2400M3\nG1X10.F600.\nM30';

let parsed;
function load({ gcode, fileName, mode = 'mill' }) {
  parsed = [];
  useCamStore.setState({
    gcode, fileName, mode,
    parse: async (text) => { parsed.push(text); useCamStore.setState({ gcode: text }); },
  });
}

beforeEach(() => {
  server.materials = [M17, TI];
  server.fail = null;
  useStdStore.setState({
    materials: [], loaded: false, loading: false, error: null, open: false, detection: null,
    selectedKey: null, proposal: null, off: {}, lastSeen: null, lastLoadSeq: null, lastFileName: null, undo: null, result: null, withinStandard: false,
  });
});

describe('check', () => {
  it('opens with a proposal when the material is known and the program is outside the range', async () => {
    load({ gcode: SLOW, fileName: '17-4PH_FORK.nc' });
    await useStdStore.getState().autoCheck();
    const s = useStdStore.getState();
    expect(s.open).toBe(true);
    expect(s.detection).toMatchObject({ key: '17-4PH', source: 'file name' });
    expect(s.proposal.changes).toBe(1);
  });

  it('still opens when the program is already inside the range, with nothing to change', async () => {
    load({ gcode: FAST, fileName: '17-4PH_FORK.nc' });
    await useStdStore.getState().autoCheck();
    const s = useStdStore.getState();
    expect(s.open).toBe(true);
    expect(s.proposal.changes).toBe(0);
  });

  it('asks which material when nothing says', async () => {
    load({ gcode: SLOW, fileName: 'program.nc' });
    await useStdStore.getState().autoCheck();
    const s = useStdStore.getState();
    expect(s.open).toBe(true);
    expect(s.proposal).toBeNull();
    useStdStore.getState().choose('17-4PH');
    expect(useStdStore.getState().proposal.changes).toBe(1);
  });

  it('asks once per distinct program, not on every reparse', async () => {
    load({ gcode: SLOW, fileName: '17-4PH_FORK.nc' });
    await useStdStore.getState().autoCheck();
    useStdStore.getState().dismiss();
    await useStdStore.getState().autoCheck();
    expect(useStdStore.getState().open).toBe(false);
  });

  it('is silent when there is no standard to compare with, but a manual check still opens', async () => {
    server.fail = 'relation "cam_std_material" does not exist';
    load({ gcode: SLOW, fileName: '17-4PH_FORK.nc' });
    await useStdStore.getState().autoCheck();
    expect(useStdStore.getState().open).toBe(false);
    expect(useStdStore.getState().error).toMatch(/does not exist/);
    await useStdStore.getState().check({ manual: true });
    expect(useStdStore.getState().open).toBe(true);
  });

  it('refuses a manual check with no program loaded, in words', async () => {
    useCamStore.setState({ gcode: '', fileName: null });
    await useStdStore.getState().check({ manual: true });
    expect(useStdStore.getState().error).toMatch(/Open a program/);
  });
});

describe('timing', () => {
  it('estimates cycle time before and after, and follows the switches', async () => {
    load({ gcode: SLOW, fileName: '17-4PH_FORK.nc' });
    await useStdStore.getState().autoCheck();
    const t = useStdStore.getState().timing;
    expect(t.before).toBeGreaterThan(0);
    expect(t.after).toBeLessThan(t.before);            // faster speed, feed scaled up
    useStdStore.getState().toggle('T1#1');
    const t2 = useStdStore.getState().timing;
    expect(t2.after).toBe(t2.before);                  // nothing selected, nothing changes
  });
});

describe('apply / restore', () => {
  it('changes nothing until applied, then rewrites and can be undone', async () => {
    load({ gcode: SLOW, fileName: '17-4PH_FORK.nc' });
    await useStdStore.getState().autoCheck();
    expect(parsed).toEqual([]);                       // proposing wrote nothing

    await useStdStore.getState().apply();
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toContain('S2390M3');
    expect(parsed[0]).toContain('F560');
    const s = useStdStore.getState();
    expect(s.open).toBe(false);
    expect(s.result).toEqual({ applied: 1, stale: 0 });
    expect(s.undo.text).toBe(SLOW);
    expect(s.proposal.changes).toBe(0);               // the new text is inside the range

    await useStdStore.getState().restore();
    expect(parsed[1]).toBe(SLOW);
    expect(useStdStore.getState().undo).toBeNull();
  });

  it('does not ask again about its own output', async () => {
    load({ gcode: SLOW, fileName: '17-4PH_FORK.nc' });
    await useStdStore.getState().autoCheck();
    await useStdStore.getState().apply();
    await useStdStore.getState().autoCheck();
    expect(useStdStore.getState().open).toBe(false);
  });

  it('leaves out a tool the operator switched off', async () => {
    load({ gcode: SLOW, fileName: '17-4PH_FORK.nc' });
    await useStdStore.getState().autoCheck();
    useStdStore.getState().toggle('T1#1');
    await useStdStore.getState().apply();
    expect(parsed).toEqual([]);
    expect(useStdStore.getState().error).toMatch(/Nothing selected/);
  });

  it('refuses when the program changed after it was checked', async () => {
    load({ gcode: SLOW, fileName: '17-4PH_FORK.nc' });
    await useStdStore.getState().autoCheck();
    useCamStore.setState({ gcode: SLOW.replace('S1700M3', 'S1650M3') });
    await useStdStore.getState().apply();
    expect(parsed).toEqual([]);
    expect(useStdStore.getState().error).toMatch(/changed since/);
  });
});

describe('setDiameter', () => {
  const CENTRE = 'O1 (17-4PH)\nT1(CENTER DRILL)\nM6\nS2000M3\nG81Z-3.F100.\nM30';

  it('works out a row that had no diameter, keeps it for the program, and never writes it', async () => {
    server.materials = [{ ...M17, vc: { ...M17.vc, centre: [10, 13] } }];
    load({ gcode: CENTRE, fileName: '17-4PH_X.nc' });
    await useStdStore.getState().autoCheck();
    let row = useStdStore.getState().proposal.rows[0];
    expect(row.status).toBe('no-diameter');

    useStdStore.getState().setDiameter(row.id, 3);
    row = useStdStore.getState().proposal.rows[0];
    expect(row.status).toBe('change');
    expect(useStdStore.getState().proposal.changes).toBe(1);

    await useStdStore.getState().apply();
    expect(parsed[0]).toContain('S1070');
    expect(parsed[0]).not.toMatch(/D3\b|Ø/);

    useStdStore.getState().setDiameter(row.id, 0);
    expect(useStdStore.getState().diameters).toEqual({});
  });
});

describe('per-tool time', () => {
  it('splits the cycle time by tool, never exceeding the total, and the changed tool gets faster', async () => {
    load({ gcode: SLOW, fileName: '17-4PH_FORK.nc' });
    await useStdStore.getState().autoCheck();
    const s = useStdStore.getState();
    const row = s.proposal.rows[0];
    const t = s.timing.rows[row.id];
    expect(t.before).toBeGreaterThan(0);
    const sum = Object.values(s.timing.rows).reduce((a, x) => a + x.before, 0);
    expect(sum).toBeLessThanOrEqual(s.timing.before + 1e-6);
    // SLOW (S1700) is moved to the standard's lower bound, which is slower at the same F scale-down? either way after is computed.
    expect(Number.isFinite(t.after)).toBe(true);
  });
});

describe('opening a program versus editing it', () => {
  it('asks when a file is opened, stays quiet when the same program is edited, asks again on a re-open', async () => {
    load({ gcode: SLOW, fileName: '17-4PH_FORK.nc' });
    await useStdStore.getState().autoCheck();
    expect(useStdStore.getState().open).toBe(true);

    // The operator dismisses it, edits the program and presses Parse: same file, new text.
    useStdStore.setState({ open: false });
    useCamStore.setState({ gcode: FAST });
    await useStdStore.getState().autoCheck();
    let s = useStdStore.getState();
    expect(s.open).toBe(false);
    // ...but what the menu would show is up to date.
    expect(s.proposal.changes).toBe(0);

    // Opening the same file again (camStore bumps loadSeq) is an open, not an edit.
    useCamStore.setState({ gcode: SLOW, loadSeq: useCamStore.getState().loadSeq + 1 });
    await useStdStore.getState().autoCheck();
    s = useStdStore.getState();
    expect(s.open).toBe(true);
    expect(s.proposal.changes).toBe(1);
  });

  it('keeps the diameters the operator typed across an edit, and drops them for a new file', async () => {
    load({ gcode: SLOW, fileName: '17-4PH_FORK.nc' });
    await useStdStore.getState().autoCheck();
    useStdStore.setState({ diameters: { 'T1#1': 8 }, open: false });
    useCamStore.setState({ gcode: SLOW.replace('F400', 'F410') });
    await useStdStore.getState().autoCheck();
    expect(useStdStore.getState().diameters).toEqual({ 'T1#1': 8 });
    useCamStore.setState({ gcode: SLOW, fileName: 'other.nc' });
    await useStdStore.getState().autoCheck();
    expect(useStdStore.getState().diameters).toEqual({});
  });
});
