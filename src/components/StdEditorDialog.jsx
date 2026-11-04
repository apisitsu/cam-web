/**
 * Edit the standard cutting-speed table (Tools ▸ Edit standard…).
 *
 * One material at a time: its name, aliases (what detection looks for in a file
 * name or header), source note, and a min–max Vc for each operation. Saving goes
 * to `PUT /api/engineer/cam/std-vc/:key`; the server decides who may do what —
 * engineers can edit, only an administrator can mark a standard `approved`, and
 * changing a range drops an existing sign-off back to `draft`. This dialog does
 * not try to second-guess that: a refusal arrives as the server's own sentence.
 *
 * An operation left blank is not sent, so it keeps whatever the table has (the
 * API has no way to delete a range, and blanking one by accident must not do so).
 */
import { useEffect, useState } from 'react';
import { Modal, Select, Input, InputNumber, Space, Typography, Button, Alert } from 'antd';
import { useStdStore } from '../stores/stdStore.js';
import { STD_OPERATIONS } from '../engine/cam/stdVc.js';
import { CAD } from '../theme.js';

const { Text } = Typography;
const NEW = '__new__';

const OP_LABEL = {
  turning: 'Turning', milling: 'Milling', drilling: 'Drilling', reaming: 'Reaming', tap: 'Tapping',
  parting: 'Parting', grooving: 'Grooving', centre: 'Centre drill',
};

function formFrom(material) {
  const vc = {};
  for (const op of STD_OPERATIONS) vc[op] = material?.vc?.[op] ? [...material.vc[op]] : [null, null];
  return {
    key: material?.key ?? '',
    label: material?.label ?? '',
    isoGroup: material?.isoGroup ?? '',
    aliases: material?.aliases ?? [],
    status: material?.status ?? 'draft',
    sourceNote: material?.sourceNote ?? '',
    vc,
  };
}

export default function StdEditorDialog() {
  const open = useStdStore((s) => s.editorOpen);
  const materials = useStdStore((s) => s.materials);
  const closeEditor = useStdStore((s) => s.closeEditor);
  const saveMaterial = useStdStore((s) => s.saveMaterial);

  const [pick, setPick] = useState(null);
  const [form, setForm] = useState(formFrom(null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  // Start on the first material each time the editor opens.
  useEffect(() => {
    if (!open) return;
    const first = materials[0];
    setPick(first ? first.key : NEW);
    setForm(formFrom(first));
    setError(null);
    setSaved(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (key) => {
    setPick(key);
    setForm(formFrom(key === NEW ? null : materials.find((x) => x.key === key)));
    setError(null);
    setSaved(false);
  };
  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setSaved(false); };
  const setRange = (op, idx, v) => {
    setForm((f) => {
      const r = [...f.vc[op]];
      r[idx] = v;
      return { ...f, vc: { ...f.vc, [op]: r } };
    });
    setSaved(false);
  };

  const save = async () => {
    setError(null);
    const vc = {};
    for (const op of STD_OPERATIONS) {
      const [lo, hi] = form.vc[op];
      if (lo == null && hi == null) continue;
      if (lo == null || hi == null) { setError(`${OP_LABEL[op]}: give both a minimum and a maximum.`); return; }
      vc[op] = [Number(lo), Number(hi)];
    }
    const key = pick === NEW ? form.key.trim() : pick;
    setBusy(true);
    try {
      await saveMaterial(key, {
        label: form.label, isoGroup: form.isoGroup, aliases: form.aliases,
        status: form.status, sourceNote: form.sourceNote, vc,
      });
      setSaved(true);
      if (pick === NEW) setPick(key);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Edit standard cutting speeds"
      width={720}
      destroyOnHidden
      maskClosable={false}
      onCancel={closeEditor}
      footer={(
        <Space>
          <Button onClick={closeEditor} data-std-editor-close>Close</Button>
          <Button type="primary" onClick={save} loading={busy} data-std-editor-save>Save</Button>
        </Space>
      )}
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {error && <Alert type="error" showIcon message={error} data-std-editor-error />}
        {saved && <Alert type="success" showIcon message="Saved." data-std-editor-saved />}

        <Space wrap>
          <Text>Material</Text>
          <Select
            style={{ width: 260 }}
            value={pick ?? undefined}
            onChange={choose}
            options={[
              ...materials.map((x) => ({ value: x.key, label: x.label })),
              { value: NEW, label: '+ New material…' },
            ]}
            data-std-editor-material
          />
          {pick === NEW && (
            <Input
              style={{ width: 200 }} placeholder="Key, e.g. 316L" value={form.key}
              onChange={(e) => set({ key: e.target.value })} data-std-editor-key
            />
          )}
        </Space>

        <Space wrap>
          <Input
            style={{ width: 300 }} placeholder="Name shown to the operator" value={form.label}
            onChange={(e) => set({ label: e.target.value })} addonBefore="Name"
          />
          <Input
            style={{ width: 200 }} placeholder="ISO group" value={form.isoGroup}
            onChange={(e) => set({ isoGroup: e.target.value })} addonBefore="Group"
          />
          <Select
            style={{ width: 150 }} value={form.status} onChange={(v) => set({ status: v })}
            options={[{ value: 'draft', label: 'Draft' }, { value: 'approved', label: 'Approved (admin)' }]}
          />
        </Space>

        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Names the program may use for this material (file name or header). Press Enter after each.
          </Text>
          <Select
            mode="tags" style={{ width: '100%' }} value={form.aliases} open={false}
            onChange={(v) => set({ aliases: v })} tokenSeparators={[',']} placeholder="17-4PH, SUS630 …"
          />
        </div>

        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>Vc range, m/min. Leave both blank to keep the table as it is.</Text>
          {STD_OPERATIONS.map((op) => (
            <Space key={op} style={{ display: 'flex', marginTop: 4 }}>
              <span style={{ display: 'inline-block', width: 80, color: CAD.text }}>{OP_LABEL[op]}</span>
              <InputNumber
                min={0} max={5000} placeholder="min" value={form.vc[op][0]}
                onChange={(v) => setRange(op, 0, v)} data-std-editor-min={op}
              />
              <span>–</span>
              <InputNumber
                min={0} max={5000} placeholder="max" value={form.vc[op][1]}
                onChange={(v) => setRange(op, 1, v)} data-std-editor-max={op}
              />
            </Space>
          ))}
        </div>

        <Input.TextArea
          rows={2} placeholder="Where these figures come from" value={form.sourceNote}
          onChange={(e) => set({ sourceNote: e.target.value })}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          Changing a range sends the standard back to Draft unless an administrator saves it as Approved.
        </Text>
      </Space>
    </Modal>
  );
}
