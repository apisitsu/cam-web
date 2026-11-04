/**
 * The standard-cutting-speed check, as a dialog.
 *
 * Opens by itself when a program has just been loaded and either its material
 * is unknown or the standard would change something; opens on request from
 * Tools ▸ Standard cutting speeds. It shows what it found — the material and how
 * it was recognised, then one row per tool: the speed the program has, the range
 * the standard allows, and what it would write instead — and the operator
 * decides. *Use standard* rewrites the listing (and can be undone from the
 * Tools menu); *Keep as is* closes it and changes nothing.
 *
 * Every number here is computed by `engine/cam/stdVc.js` and handed over on the
 * store's `proposal`; this component arranges them and turns two buttons into
 * two store calls. Rows carry words, not glyphs, for the same reason the library
 * does: this is a dialog that reads like a table, not a rail of commands.
 *
 * A material whose figures are still `draft` says so at the top of the dialog.
 * The ranges came from a shop table nobody has checked against the tool maker's
 * data, and a proposal made from them must not read as authority.
 */
import { useEffect } from 'react';
import { Modal, Select, Table, Tag, Alert, Checkbox, InputNumber, Space, Typography, Button, App as AntdApp } from 'antd';
import { useStdStore } from '../stores/stdStore.js';
import { useCamStore } from '../stores/camStore.js';
import { CAD } from '../theme.js';
import { formatDuration } from '../engine/view/programStats.js';

const { Text } = Typography;

const STATUS = {
  ok: { color: 'green', text: 'In range' },
  change: { color: 'blue', text: 'Will change' },
  limit: { color: 'orange', text: 'Spindle limit' },
  'no-standard': { color: 'default', text: 'No standard' },
  'no-spindle': { color: 'default', text: 'No speed set' },
  'no-diameter': { color: 'orange', text: 'No diameter' },
};

const OP_LABEL = {
  turning: 'Turning', milling: 'Milling', drilling: 'Drilling', reaming: 'Reaming', tap: 'Tapping',
  parting: 'Parting', grooving: 'Grooving', centre: 'Centre drill',
};

const m = (v) => (v == null ? '—' : Math.round(v));

/** The speed column: "175 m/min (G96)" or "43 m/min · S1700". */
function speedNow(r) {
  if (r.sOld == null) return '—';
  return r.css ? `${m(r.vcOld)} m/min (G96)` : `${m(r.vcOld)} m/min · S${r.sOld}`;
}
function speedNext(r) {
  if (r.status !== 'change') return '';
  return r.css ? `${m(r.vcNew)} m/min (G96)` : `${m(r.vcNew)} m/min · S${r.sNew}`;
}

export default function StdVcDialog() {
  const open = useStdStore((s) => s.open);
  const materials = useStdStore((s) => s.materials);
  const detection = useStdStore((s) => s.detection);
  const selectedKey = useStdStore((s) => s.selectedKey);
  const proposal = useStdStore((s) => s.proposal);
  const off = useStdStore((s) => s.off);
  const timing = useStdStore((s) => s.timing);
  const error = useStdStore((s) => s.error);
  const choose = useStdStore((s) => s.choose);
  const toggle = useStdStore((s) => s.toggle);
  const setDiameter = useStdStore((s) => s.setDiameter);
  const apply = useStdStore((s) => s.apply);
  const dismiss = useStdStore((s) => s.dismiss);
  const autoCheck = useStdStore((s) => s.autoCheck);
  const result = useStdStore((s) => s.result);
  const clearResult = useStdStore((s) => s.clearResult);
  const { message } = AntdApp.useApp();

  const fileName = useCamStore((s) => s.fileName);
  const gcode = useCamStore((s) => s.gcode);
  const tabMode = useCamStore((s) => s.mode);
  const programMode = useStdStore((s) => s.programMode) || tabMode;
  const detectedMode = useStdStore((s) => s.detectedMode);
  const modeOverride = useStdStore((s) => s.modeOverride);
  const setProgramType = useStdStore((s) => s.setProgramType);

  // A program has arrived: ask once for each distinct text.
  useEffect(() => {
    if (fileName && gcode) autoCheck();
  }, [fileName, gcode, autoCheck]);

  // The one line that says what just happened, then it goes away.
  useEffect(() => {
    if (result) {
      message.success(`${result.applied} tool${result.applied === 1 ? '' : 's'} set to the standard. Tools ▸ Restore program puts the original back.`);
      clearResult();
    }
  }, [result, message, clearResult]);

  const material = materials.find((x) => x.key === selectedKey);
  const rows = proposal?.rows ?? [];
  const selected = rows.filter((r) => r.status === 'change' && !off[r.id]).length;

  const columns = [
    {
      title: '', dataIndex: 'use', width: 36,
      render: (_, r) => (r.status === 'change'
        ? <Checkbox checked={!off[r.id]} onChange={() => toggle(r.id)} aria-label={`Change ${r.label}`} />
        : null),
    },
    {
      title: 'Tool', dataIndex: 'label', width: 150,
      render: (_, r) => (
        <div>
          <Text strong>{r.label}</Text>
          <div style={{ color: CAD.muted, fontSize: 11 }}>{r.desc}</div>
        </div>
      ),
    },
    { title: 'Operation', dataIndex: 'operation', width: 90, render: (v) => OP_LABEL[v] || '—' },
    {
      title: 'Ø mm', dataIndex: 'diameter', width: 84,
      render: (v, r) => {
        // Only a rpm speed needs a diameter, and only where the program gives none.
        const needs = r.diameterEditable && r.operation && r.range && r.sOld != null && !r.css;
        if (!needs && !(r.diameterEditable && r.status === 'no-diameter')) return v ?? '—';
        return (
          <InputNumber
            size="small" min={0} max={500} step={0.5} controls={false} placeholder="Ø"
            value={r.diameterGiven ? v : null} style={{ width: 66 }}
            onChange={(x) => setDiameter(r.id, x)}
            aria-label={`Diameter of ${r.label}`} data-std-diameter={r.id}
          />
        );
      },
    },
    {
      title: 'Time', key: 'time', width: 92,
      render: (_, r) => {
        const t = timing?.rows?.[r.id];
        if (!t) return '—';
        const a = formatDuration(t.before);
        const b = formatDuration(t.after);
        return (
          <span data-std-time={r.id}>{a === b ? a : `${a} → ${b}`}</span>
        );
      },
    },
    { title: 'Program has', key: 'now', width: 160, render: (_, r) => speedNow(r) },
    {
      title: 'Standard', key: 'range', width: 100,
      render: (_, r) => (r.range ? `${r.range[0]}–${r.range[1]} m/min` : '—'),
    },
    {
      title: 'Would write', key: 'next', width: 170,
      render: (_, r) => (
        <div>
          {speedNext(r)}
          {r.warnings.map((w) => (
            <div key={w} style={{ color: '#b45309', fontSize: 11 }}>{w}</div>
          ))}
        </div>
      ),
    },
    {
      title: 'Status', key: 'status', width: 110,
      render: (_, r) => {
        const s = STATUS[r.status] || STATUS['no-standard'];
        return (
          <div>
            <Tag color={s.color} style={{ marginInlineEnd: 0 }}>{s.text}</Tag>
            {r.status !== 'ok' && r.reason && (
              <div style={{ color: CAD.muted, fontSize: 11, marginTop: 2 }}>{r.reason}</div>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <Modal
      open={open}
      title="Standard cutting speeds"
      width={1060}
      destroyOnHidden
      onCancel={dismiss}
      maskClosable={false}
      footer={(
        <Space>
          <Button onClick={dismiss} data-std-keep>Keep as is</Button>
          <Button type="primary" onClick={apply} disabled={selected === 0} data-std-apply>
            {selected > 0 ? `Use standard (${selected} tool${selected === 1 ? '' : 's'})` : 'Use standard'}
          </Button>
        </Space>
      )}
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {error && <Alert type="error" showIcon message={error} data-std-error />}

        <Space wrap size={8} align="center">
          <Text>Material</Text>
          <Select
            style={{ width: 240 }}
            value={selectedKey ?? undefined}
            placeholder="Choose the material"
            onChange={choose}
            options={materials.map((x) => ({ value: x.key, label: `${x.label}${x.isoGroup ? ` · ${x.isoGroup}` : ''}` }))}
            data-std-material
          />
          {detection && selectedKey === detection.key && (
            <Tag color="geekblue">Recognised from the {detection.source} (“{detection.alias}”)</Tag>
          )}
          {!detection && <Tag>Not found in the file name or header</Tag>}
          <Text>Program type</Text>
          <Select
            style={{ width: 190 }}
            value={modeOverride ?? 'auto'}
            onChange={setProgramType}
            options={[
              { value: 'auto', label: `Auto (${(detectedMode ?? tabMode) === 'turn' ? 'Turning' : 'Milling'}${detectedMode ? '' : ', from tab'})` },
              { value: 'turn', label: 'Turning' },
              { value: 'mill', label: 'Milling' },
            ]}
            data-std-program-type
          />
          {material?.status === 'draft' && <Tag color="orange" data-std-draft>DRAFT standard — not yet approved</Tag>}
        </Space>

        {programMode !== tabMode && (
          <Alert
            type="warning" showIcon data-std-mode-mismatch
            message={`This looks like a ${programMode === 'turn' ? 'turning' : 'milling'} program, but the CAM tab is set to ${tabMode === 'turn' ? 'Turning' : 'Milling'}. The check above follows the program; switch the tab in Setup so the viewport, Cycle time and simulation read it the same way.`}
          />
        )}

        {detection?.conflict && (
          <Alert
            type="warning" showIcon
            message={`The file name says ${detection.key}, but the program header names ${detection.conflict}. Check the material.`}
          />
        )}

        {!material && (
          <Alert type="info" showIcon message="This program does not say what it is cut from. Choose the material to compare it with the standard." />
        )}

        {material && proposal && (
          <>
            <Table
              size="small" pagination={false} rowKey="id" columns={columns} dataSource={rows}
              scroll={{ y: 360 }}
              rowClassName={(r) => (r.status === 'change' ? 'std-row-change' : '')}
            />
            {timing && (
              <Alert
                type={selected > 0 && timing.after > timing.before * 1.1 ? 'warning' : 'info'} showIcon data-std-timing
                message={selected > 0
                  ? `Estimated cycle time: ${formatDuration(timing.before)} now → ${formatDuration(timing.after)} with the selected tools`
                  : `Estimated cycle time: ${formatDuration(timing.before)} (nothing selected to change)`}
                description={selected > 0 && timing.after > timing.before * 1.1
                  ? 'The standard is slower than the program for some tools. Switch those tools off above if the extra time is not wanted.'
                  : undefined}
              />
            )}
            <Text type="secondary" style={{ fontSize: 12 }}>
              Speeds only: on a mill the feeds move with them so chip load per tooth stays the same; on a lathe the
              feed per revolution is left as written. Time is each tool's own machining time from the simulation (moves and dwells); tool changes are not counted, so the column adds up to a little less than the cycle time. A Ø you type is used for the calculation only and is not written to the program. Threading has no standard and is never changed. The original program can be restored from Tools ▸ Restore program.
              {material.sourceNote ? ` Source: ${material.sourceNote}` : ''}
            </Text>
          </>
        )}
      </Space>
    </Modal>
  );
}
