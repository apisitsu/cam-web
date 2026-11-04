/**
 * A program is milling or turning by what it says, not by which tab the CAM
 * module happens to be on. Reported from the floor: a threaded-sleeve TURN file
 * opened while the tab said Milling listed every tool as "Milling" and priced the
 * cycle at ten hours, because the lathe's per-rev feeds were read as mm/min.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detectProgramMode } from '../engine/cam/stdVc.js';

vi.mock('../lib/stdApi.js', () => ({
  listStd: async () => [{
    key: '7075-T73511', label: '7075-T73511', isoGroup: 'ISO N', aliases: ['7075'], status: 'draft', sourceNote: '',
    vc: { turning: [300, 1000], milling: [300, 1000], drilling: [60, 150], reaming: [20, 40], tap: [10, 30] },
  }],
  saveStd: async () => undefined,
}));

const { useStdStore } = await import('./stdStore.js');
const { useCamStore } = await import('./camStore.js');

const LATHE = [
  'O1', 'G50 S2200', 'T0101 (OD ROUGHING)', 'G96 S120 M3', 'G99 G1 X20. F0.2', 'M30',
].join('\n');
const MILL = ['O1', 'T1(ENDMILL D8)', 'M6', 'G43 H1', 'S4000M3', 'G1X10.F400.', 'M30'].join('\n');

describe('detectProgramMode', () => {
  it('reads a lathe program from G96, the G50 clamp and four-digit tool words', () => {
    expect(detectProgramMode(LATHE)).toBe('turn');
  });
  it('reads a mill program from M6 and G43', () => {
    expect(detectProgramMode(MILL)).toBe('mill');
  });
  it('is not fooled by a comment that mentions the other kind', () => {
    expect(detectProgramMode(`${MILL}\n(G96 S100 T0101 TURN)`)).toBe('mill');
  });
  it('says nothing when the text gives no lead', () => {
    expect(detectProgramMode('O1\nG1 X10 F100\nM30')).toBeNull();
  });
});

describe('the store follows the program, not the tab', () => {
  beforeEach(() => {
    useStdStore.setState({
      materials: [], loaded: false, loading: false, error: null, open: false, detection: null,
      selectedKey: null, proposal: null, timing: null, programMode: null, detectedMode: null, modeOverride: null, off: {}, lastSeen: null,
      undo: null, result: null, withinStandard: false,
    });
  });

  it('a turning file opened on the Milling tab is proposed as turning', async () => {
    useCamStore.setState({ gcode: LATHE, fileName: '7075_SLEEVE_TURN01.nc', mode: 'mill' });
    await useStdStore.getState().check({ manual: true });
    const s = useStdStore.getState();
    expect(s.programMode).toBe('turn');
    expect(s.proposal.rows.length).toBeGreaterThan(0);
    expect(s.proposal.rows.every((r) => r.operation !== 'milling')).toBe(true);
  });

  it('the operator can override the guess, and Auto returns to it', async () => {
    useCamStore.setState({ gcode: LATHE, fileName: '7075_SLEEVE_TURN01.nc', mode: 'mill' });
    await useStdStore.getState().check({ manual: true });
    useStdStore.getState().setProgramType('mill');
    expect(useStdStore.getState().programMode).toBe('mill');
    expect(useStdStore.getState().detectedMode).toBe('turn');
    useStdStore.getState().setProgramType('auto');
    expect(useStdStore.getState().programMode).toBe('turn');
  });
});
