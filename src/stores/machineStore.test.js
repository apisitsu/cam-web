import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  allMachines, machineById, machinesFor, machineRow, setShopMachines, builtInMachine,
} from '../engine/cam/machines.js';

// A stand-in for the server (EngineerSystem) / this browser (cam-web).
const rows = new Map();
vi.mock('../lib/machineApi.js', () => ({
  listMachines: async () => [...rows.values()],
  saveMachine: async (id, body) => { rows.set(id, { ...body, id }); return rows.get(id); },
  deleteMachine: async (id) => { if (!rows.delete(id)) throw new Error('no such machine'); },
}));

const { useMachineStore } = await import('./machineStore.js');
const { useCamPlanStore } = await import('./camPlanStore.js');
const { rowProblem } = await import('../components/MachineDialog.jsx');

const store = () => useMachineStore.getState();

const newMill = {
  kind: 'mill', brand: 'Shop', model: 'VMC-9', controller: 'fanuc', note: '', axes: 'mill4',
  maxRpm: 10000, minRpm: 100, maxFeed: 9000, rapidRate: 24000, rigidity: 1, toolStations: 24,
  travel: { X: 650, Y: 420, Z: 460 }, home: { X: 0, Y: 0, Z: 0 },
};

describe('machine list: built-in + the shop’s', () => {
  beforeEach(() => setShopMachines([]));

  it('every built-in machine round-trips through its editor row', () => {
    for (const m of allMachines()) {
      setShopMachines([{ id: m.id, ...machineRow(m) }]);
      const back = machineById(m.id);
      expect(back.source).toBe('changed');
      expect(machineRow(back)).toEqual(machineRow(m));
      expect(back.linear).toEqual(m.linear);
      expect(back.rotary).toEqual(m.rotary);
    }
  });

  it('a changed built-in replaces it in place; the shipped one stays readable', () => {
    setShopMachines([{ id: 'haas-vf2', ...machineRow(builtInMachine('haas-vf2')), rapidRate: 12345 }]);
    expect(machineById('haas-vf2').rapidRate).toBe(12345);
    expect(builtInMachine('haas-vf2').rapidRate).toBe(25400);
    expect(allMachines().filter((m) => m.id === 'haas-vf2')).toHaveLength(1);
  });

  it('an added machine is listed under its process, with its axes', () => {
    setShopMachines([{ id: 'shop-vmc-9', ...newMill }]);
    const m = machineById('shop-vmc-9');
    expect(m).toMatchObject({ source: 'added', label: 'Shop · VMC-9', rotary: ['A'], axisCount: 4 });
    expect(machinesFor('mill').some((x) => x.id === 'shop-vmc-9')).toBe(true);
    expect(machinesFor('turn').some((x) => x.id === 'shop-vmc-9')).toBe(false);
  });

  it('a malformed row is skipped, not fatal', () => {
    setShopMachines([{ id: 'x', kind: 'mill' }, { id: 'shop-vmc-9', ...newMill }]);
    expect(machineById('x').id).not.toBe('x');
    expect(machineById('shop-vmc-9').id).toBe('shop-vmc-9');
  });
});

describe('machineStore', () => {
  beforeEach(async () => {
    rows.clear();
    await store().load();
  });

  it('save adds a machine and remove deletes it', async () => {
    await store().save('shop-vmc-9', newMill);
    expect(machineById('shop-vmc-9').source).toBe('added');
    await store().remove('shop-vmc-9');
    expect(machineById('shop-vmc-9').id).not.toBe('shop-vmc-9');
  });

  it('changing the machine in use re-applies it to the plan', async () => {
    useCamPlanStore.getState().setMachine('haas-vf2');
    await store().save('haas-vf2', { ...machineRow(builtInMachine('haas-vf2')), maxRpm: 6000 });
    expect(useCamPlanStore.getState().machineId).toBe('haas-vf2');
    expect(machineById('haas-vf2').maxRpm).toBe(6000);
    await store().remove('haas-vf2');
    expect(machineById('haas-vf2').maxRpm).toBe(8100);
  });

  it('deleting the added machine in use falls back to the default of its kind', async () => {
    await store().save('shop-vmc-9', newMill);
    useCamPlanStore.getState().setMachine('shop-vmc-9');
    await store().remove('shop-vmc-9');
    expect(machineById(useCamPlanStore.getState().machineId).kind).toBe('mill');
    expect(useCamPlanStore.getState().machineId).not.toBe('shop-vmc-9');
  });
});

describe('rowProblem', () => {
  it('accepts a complete machine and names what is missing', () => {
    expect(rowProblem(newMill)).toBeNull();
    expect(rowProblem({ ...newMill, brand: ' ' })).toMatch(/Brand/);
    expect(rowProblem({ ...newMill, minRpm: 20000 })).toMatch(/Min rpm/);
    expect(rowProblem({ ...newMill, travel: { X: 600, Y: 400 } })).toMatch(/Stroke Z/);
  });
});
