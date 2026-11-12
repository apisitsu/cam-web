/**
 * Tools ▸ Work offsets — where work zero sits on the machine, for this project.
 *
 * One row per offset (G54…G59): the machine coordinates of work zero, typed in
 * as they read on the control's Work Offset page, and a note for which vise or
 * fixture it is. The offset marked *In use* is the one the program is posted
 * with, and the one G28 is timed from: the distance to home is the machine's
 * home (Tools ▸ Machines) less this offset. An empty box falls back to the
 * stroke estimate. Saved with the project.
 */
import {
  Modal, Table, Button, Radio, InputNumber, Input, Typography, Space,
} from 'antd';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { useCamStore } from '../stores/camStore.js';
import { machineById, WORK_OFFSET_CODES } from '../engine/cam/machines.js';
import { CAD } from '../theme.js';

const { Text } = Typography;

export default function WorkOffsetDialog() {
  const open = useCamPlanStore((s) => s.workOffsetsOpen);
  const close = useCamPlanStore((s) => s.closeWorkOffsets);
  const offsets = useCamPlanStore((s) => s.workOffsets);
  const active = useCamPlanStore((s) => s.activeOffset);
  const machineId = useCamPlanStore((s) => s.machineId);
  const setOffset = useCamPlanStore((s) => s.setWorkOffset);
  const addOffset = useCamPlanStore((s) => s.addWorkOffset);
  const removeOffset = useCamPlanStore((s) => s.removeWorkOffset);
  const setActive = useCamPlanStore((s) => s.setActiveOffset);
  const home = useCamStore((s) => s.home);

  const machine = machineById(machineId);
  const lathe = machine.kind === 'turn';

  const axisColumn = (axis) => ({
    title: lathe && axis === 'X' ? 'X (Ø)' : axis,
    dataIndex: axis,
    width: 110,
    render: (v, o) => (
      <InputNumber
        size="small"
        controls={false}
        step={0.001}
        value={v}
        placeholder="—"
        onChange={(n) => setOffset(o.code, { [axis]: Number.isFinite(n) ? n : null })}
        style={{ width: 100 }}
        data-offset-axis={`${o.code}-${axis}`}
      />
    ),
  });

  const columns = [
    {
      title: 'In use',
      width: 60,
      render: (_, o) => <Radio checked={o.code === active} onChange={() => setActive(o.code)} />,
    },
    { title: 'Offset', dataIndex: 'code', width: 70, render: (c) => <Text strong>{c}</Text> },
    ...machine.linear.map(axisColumn),
    {
      title: 'Note',
      dataIndex: 'note',
      render: (v, o) => (
        <Input size="small" value={v} placeholder="vise / fixture" onChange={(e) => setOffset(o.code, { note: e.target.value })} />
      ),
    },
    {
      width: 70,
      render: (_, o) => (
        <Button size="small" type="text" danger disabled={offsets.length === 1} onClick={() => removeOffset(o.code)}>
          Remove
        </Button>
      ),
    },
  ];

  return (
    <Modal
      open={open}
      title="Work offsets"
      width={820}
      onCancel={close}
      footer={<Button onClick={close}>Close</Button>}
      data-work-offsets
    >
      <Text style={{ color: CAD.label, fontSize: 12, display: 'block', marginBottom: 8 }}>
        Machine coordinates of work zero, as on the control&apos;s Work Offset page. The program is posted with
        the offset in use, and G28 is timed from it. An empty box uses an estimate from the machine&apos;s stroke.
      </Text>
      <Table size="small" rowKey="code" columns={columns} dataSource={offsets} pagination={false} />
      <Space style={{ marginTop: 8, width: '100%', justifyContent: 'space-between' }}>
        <Button size="small" onClick={addOffset} disabled={offsets.length >= WORK_OFFSET_CODES.length}>
          Add offset
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }} data-offset-home>
          {machine.label} — G28 from {active}:{' '}
          {Object.entries(home ?? {}).map(([a, v]) => `${a}${v}`).join(' ')} mm
        </Text>
      </Space>
    </Modal>
  );
}
