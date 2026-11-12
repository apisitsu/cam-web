/**
 * Tools ▸ Machines — the shop's machine list.
 *
 * Left, every machine: the built-in ones (tagged *changed* once the shop has
 * put its own figures on them) and the ones the shop added. Right, the selected
 * machine's figures. Saving a built-in stores the shop's version of it; *Reset*
 * puts the shipped figures back. An added machine can be deleted.
 *
 * Home is a **machine** coordinate — where G28 goes, 0 on a control whose G28
 * point is machine zero. Where the work sits (G54…) belongs to the job, not to
 * the machine, and is set per project.
 *
 * On EngineerSystem only engineers may save; the server refuses anyone else and
 * its sentence is shown here.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Modal, Table, Tag, Button, Space, Input, InputNumber, Select, Alert, Typography, Popconfirm, App as AntdApp,
} from 'antd';
import { useMachineStore } from '../stores/machineStore.js';
import {
  allMachines, machineRow, builtInMachine, AXES,
} from '../engine/cam/machines.js';
import { DIALECT_LIST } from '../engine/cam/post/dialect.js';
import { CAD } from '../theme.js';

const { Text } = Typography;

const AXES_FOR = {
  mill: [
    { value: 'mill3', label: '3-axis (XYZ)' },
    { value: 'mill4', label: '4-axis (XYZ + A)' },
    { value: 'mill5bc', label: '5-axis (XYZ + BC)' },
  ],
  turn: [
    { value: 'turn2', label: '2-axis (XZ)' },
    { value: 'turn3c', label: 'XZ + C (driven tools)' },
    { value: 'swiss', label: 'Swiss (XYZ + C)' },
  ],
};

const BLANK = {
  mill: {
    kind: 'mill', brand: '', model: '', controller: 'fanuc', note: '', axes: 'mill3',
    maxRpm: 12000, minRpm: 100, maxFeed: 10000, rapidRate: 15000, rigidity: 1, toolStations: 20,
    travel: { X: 800, Y: 500, Z: 500 }, home: { X: 0, Y: 0, Z: 0 },
  },
  turn: {
    kind: 'turn', brand: '', model: '', controller: 'fanuc', note: '', axes: 'turn2',
    maxRpm: 4000, minRpm: 50, maxFeed: 8000, rapidRate: 20000, rigidity: 1, toolStations: 12,
    maxTurnRpm: 4000, maxTurnDia: 300, travel: { X: 200, Z: 500 }, home: { X: 0, Z: 0 },
  },
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/** A new machine's id from its name, unique among the machines there are. */
function newId(row) {
  const base = slug(`${row.brand} ${row.model}`) || 'machine';
  const taken = new Set(allMachines().map((m) => m.id));
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base.slice(0, 44)}-${i}`;
  return id;
}

/** What is wrong with a row, as a sentence, or null. The server checks again. */
export function rowProblem(row) {
  if (!row.brand?.trim() || !row.model?.trim()) return 'Brand and model are required.';
  for (const k of ['maxRpm', 'maxFeed', 'rapidRate']) {
    if (!(row[k] > 0)) return 'Max rpm, max feed and rapid must be above 0.';
  }
  if (!(row.minRpm >= 0) || row.minRpm >= row.maxRpm) return 'Min rpm must be below max rpm.';
  for (const a of AXES[row.axes].linear) {
    if (!(row.travel?.[a] > 0)) return `Stroke ${a} must be above 0.`;
  }
  return null;
}

function Field({ label, children, width = 120 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <Text style={{ color: CAD.label, fontSize: 12, width, flex: 'none' }}>{label}</Text>
      {children}
    </div>
  );
}

function Num({ value, onChange, min = 0, step = 1, width = 110, prefix, suffix }) {
  const small = (t) => t && <span style={{ color: CAD.muted, fontSize: 11 }}>{t}</span>;
  return (
    <InputNumber
      size="small" controls={false} min={min} step={step} value={value} onChange={onChange}
      prefix={small(prefix)} suffix={small(suffix)} style={{ width }}
    />
  );
}

export default function MachineDialog() {
  const open = useMachineStore((s) => s.editorOpen);
  const close = useMachineStore((s) => s.closeEditor);
  const save = useMachineStore((s) => s.save);
  const remove = useMachineStore((s) => s.remove);
  const loadError = useMachineStore((s) => s.error);
  const version = useMachineStore((s) => s.version);
  const { message } = AntdApp.useApp();

  const machines = useMemo(() => allMachines(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const [selected, setSelected] = useState(null);   // id, or null while adding
  const [row, setRow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const current = machines.find((m) => m.id === selected) ?? null;

  const pick = (m) => {
    setSelected(m.id);
    setRow(machineRow(m));
    setError(null);
  };

  useEffect(() => {
    if (!open) return;
    if (current) setRow(machineRow(current));
    else if (selected == null && !row && machines[0]) pick(machines[0]);
  }, [open, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (kind) => {
    setSelected(null);
    setRow(structuredClone(BLANK[kind]));
    setError(null);
  };

  const put = (patch) => setRow((r) => ({ ...r, ...patch }));
  const putAxis = (field, axis, v) => setRow((r) => ({ ...r, [field]: { ...r[field], [axis]: v } }));
  const setAxes = (axes) => setRow((r) => {
    const linear = AXES[axes].linear;
    const keep = (o, d) => Object.fromEntries(linear.map((a) => [a, o?.[a] ?? d]));
    return { ...r, axes, travel: keep(r.travel, 100), home: keep(r.home, 0) };
  });

  const run = async (fn, said) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (said) message.success(said);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSave = () => {
    const problem = rowProblem(row);
    if (problem) { setError(problem); return; }
    const id = selected ?? newId(row);
    run(async () => {
      await save(id, row);
      setSelected(id);
    }, 'Machine saved');
  };

  const onRemove = () => run(async () => {
    await remove(current.id);
    if (current.source === 'added') { setSelected(null); setRow(null); }
  }, current?.source === 'added' ? 'Machine deleted' : 'Back to the built-in figures');

  const columns = [
    {
      title: 'Machine',
      dataIndex: 'label',
      render: (label, m) => (
        <span>
          {label}
          {m.source !== 'built-in' && (
            <Tag color={m.source === 'added' ? 'green' : 'blue'} style={{ marginLeft: 6, fontSize: 10 }}>
              {m.source}
            </Tag>
          )}
        </span>
      ),
    },
    { title: 'Type', dataIndex: 'kind', width: 70, render: (k) => (k === 'turn' ? 'Lathe' : 'Mill') },
  ];

  const linear = row ? AXES[row.axes].linear : [];
  const shipped = current?.source === 'changed' ? builtInMachine(current.id) : null;

  return (
    <Modal
      open={open}
      title="Machines"
      width={1040}
      onCancel={close}
      maskClosable={false}
      footer={<Button onClick={close}>Close</Button>}
      data-machine-dialog
    >
      {loadError && (
        <Alert type="warning" showIcon style={{ marginBottom: 8 }}
          message={`Could not read the shop's machines (${loadError}) — showing the built-in list.`} />
      )}
      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ width: 380, flex: 'none' }}>
          <Space style={{ marginBottom: 8 }}>
            <Button size="small" onClick={() => add('mill')} data-machine-add="mill">Add mill</Button>
            <Button size="small" onClick={() => add('turn')} data-machine-add="turn">Add lathe</Button>
          </Space>
          <Table
            size="small"
            rowKey="id"
            columns={columns}
            dataSource={machines}
            pagination={false}
            scroll={{ y: 460 }}
            onRow={(m) => ({ onClick: () => pick(m), style: { cursor: 'pointer' } })}
            rowClassName={(m) => (m.id === selected ? 'ant-table-row-selected' : '')}
          />
        </div>

        {row && (
          <div style={{ flex: 1, minWidth: 0 }} data-machine-form>
            <Text strong>
              {selected ? current?.label : `New ${row.kind === 'turn' ? 'lathe' : 'mill'}`}
            </Text>
            {shipped && (
              <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>changed from the built-in figures</Text>
            )}
            <div style={{ marginTop: 8 }}>
              <Field label="Brand"><Input size="small" value={row.brand} onChange={(e) => put({ brand: e.target.value })} style={{ width: 220 }} /></Field>
              <Field label="Model"><Input size="small" value={row.model} onChange={(e) => put({ model: e.target.value })} style={{ width: 220 }} /></Field>
              <Field label="Controller">
                <Select size="small" value={row.controller} onChange={(v) => put({ controller: v })} style={{ width: 220 }}
                  options={DIALECT_LIST.map((d) => ({ value: d.id, label: d.label }))} />
              </Field>
              <Field label="Axes">
                <Select size="small" value={row.axes} onChange={setAxes} style={{ width: 220 }} options={AXES_FOR[row.kind]} />
              </Field>
              <Field label="Note"><Input size="small" value={row.note} onChange={(e) => put({ note: e.target.value })} /></Field>
              <Field label="Spindle">
                <Space size={4}>
                  <Num value={row.minRpm} onChange={(v) => put({ minRpm: v })} width={110} prefix="min" />
                  <Num value={row.maxRpm} onChange={(v) => put({ maxRpm: v })} width={130} prefix="max" suffix="rpm" />
                </Space>
              </Field>
              {row.kind === 'turn' && (
                <Field label="Turning">
                  <Space size={4}>
                    <Num value={row.maxTurnRpm} onChange={(v) => put({ maxTurnRpm: v })} width={130} prefix="G50" suffix="rpm" />
                    <Num value={row.maxTurnDia} onChange={(v) => put({ maxTurnDia: v })} width={130} prefix="max Ø" suffix="mm" />
                  </Space>
                </Field>
              )}
              <Field label="Feed / rapid">
                <Space size={4}>
                  <Num value={row.maxFeed} onChange={(v) => put({ maxFeed: v })} width={150} prefix="feed" suffix="mm/min" />
                  <Num value={row.rapidRate} onChange={(v) => put({ rapidRate: v })} width={150} prefix="rapid" suffix="mm/min" />
                </Space>
              </Field>
              <Field label="Tools / rigidity">
                <Space size={4}>
                  <Num value={row.toolStations} onChange={(v) => put({ toolStations: v })} min={1} width={110} suffix="stations" />
                  <Num value={row.rigidity} onChange={(v) => put({ rigidity: v })} min={0.1} step={0.05} width={150} prefix="rigidity" suffix="× VMC" />
                </Space>
              </Field>
              <Field label={row.kind === 'turn' ? 'Stroke (X radius)' : 'Stroke'}>
                <Space size={4}>
                  {linear.map((a) => <Num key={a} value={row.travel[a]} onChange={(v) => putAxis('travel', a, v)} min={1} width={100} prefix={a} suffix="mm" />)}
                </Space>
              </Field>
              <Field label="G28 home">
                <Space size={4}>
                  {linear.map((a) => <Num key={a} value={row.home[a]} onChange={(v) => putAxis('home', a, v ?? 0)} min={-10000} width={100} prefix={a} suffix="mm" />)}
                </Space>
              </Field>
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
                G28 home is in machine coordinates — 0 where G28 goes to machine zero (most Fanuc and Haas controls).
                The work offset (G54…) is set per project.
              </Text>
            </div>
            {error && <Alert type="error" showIcon style={{ marginBottom: 8 }} message={error} data-machine-error />}
            <Space>
              <Button type="primary" size="small" loading={busy} onClick={onSave} data-machine-save>Save</Button>
              {current?.source === 'changed' && (
                <Popconfirm title="Put the built-in figures back?" onConfirm={onRemove}>
                  <Button size="small" disabled={busy}>Reset to built-in</Button>
                </Popconfirm>
              )}
              {current?.source === 'added' && (
                <Popconfirm title="Delete this machine?" onConfirm={onRemove}>
                  <Button size="small" danger disabled={busy}>Delete</Button>
                </Popconfirm>
              )}
            </Space>
          </div>
        )}
      </div>
    </Modal>
  );
}
