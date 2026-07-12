/**
 * SketchPanel — Phase 2 sketcher controls: tool palette, constraint buttons,
 * solve, and DOF/solve feedback. Drawing happens in the viewport (SketchLayer);
 * this panel is the toolbar and status.
 */
import { Card, Button, Typography, Tag, Space, Segmented, InputNumber, Divider } from 'antd';
import { useState } from 'react';
import { useSketchStore } from '../stores/sketchStore.js';

const { Text } = Typography;

// Point-selection constraints (line constraints come with line selection later).
const POINT_CONSTRAINTS = [
  { kind: 'coincident', label: 'Coincident', need: 2 },
  { kind: 'horizontal', label: 'Horizontal', need: 2 },
  { kind: 'vertical', label: 'Vertical', need: 2 },
  { kind: 'distance', label: 'Distance', need: 2, value: true },
  { kind: 'lockX', label: 'Lock X', need: 1, value: true },
  { kind: 'lockY', label: 'Lock Y', need: 1, value: true },
];

export default function SketchPanel() {
  const {
    tool, selection, dofState, solveResult, error,
    setTool, applyConstraint, solve, deleteSelected, loadDemo, clear,
  } = useSketchStore();
  const [value, setValue] = useState(10);

  return (
    <Card
      size="small"
      title="Sketcher · Phase 2 (planegcs)"
      styles={{ header: { color: '#e5e7eb' } }}
      style={{ background: '#0b1220', borderColor: '#1f2937' }}
    >
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Segmented
          size="small"
          value={tool}
          onChange={setTool}
          options={[
            { label: 'Select', value: 'select' },
            { label: 'Point', value: 'point' },
            { label: 'Line', value: 'line' },
          ]}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {tool === 'select'
            ? `Click points to select · ${selection.length} selected`
            : `Click on the viewport plane to add a ${tool}`}
        </Text>

        <Divider style={{ margin: '4px 0' }} />

        <Space wrap size={4}>
          {POINT_CONSTRAINTS.map((c) => (
            <Button
              key={c.kind}
              size="small"
              disabled={selection.length !== c.need}
              onClick={() => applyConstraint(c.kind, c.value ? value : undefined)}
            >
              {c.label}
            </Button>
          ))}
        </Space>
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 12 }}>value</Text>
          <InputNumber size="small" value={value} onChange={(v) => setValue(v ?? 0)} style={{ width: 90 }} />
        </Space>

        <Divider style={{ margin: '4px 0' }} />

        <Space wrap size={4}>
          <Button size="small" type="primary" onClick={() => solve()}>Solve</Button>
          <Button size="small" danger disabled={!selection.length} onClick={() => deleteSelected()}>
            Delete
          </Button>
          <Button size="small" onClick={() => loadDemo()}>Demo</Button>
          <Button size="small" onClick={() => clear()}>Clear</Button>
        </Space>

        {dofState && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            DOF: {dofState.free} free ·{' '}
            <Tag
              color={dofState.state === 'full' ? 'green' : dofState.state === 'over' ? 'red' : 'blue'}
              style={{ marginInlineEnd: 0 }}
            >
              {dofState.state}
            </Tag>
          </Text>
        )}
        {solveResult && (
          <Tag color={solveResult.success ? 'green' : 'red'}>
            {solveResult.success ? 'solved' : `solve status ${solveResult.status}`}
          </Tag>
        )}
        {solveResult?.conflicting?.length > 0 && (
          <Text type="danger" style={{ fontSize: 12 }}>
            conflicting: {solveResult.conflicting.join(', ')}
          </Text>
        )}
        {error && <Text type="danger" style={{ fontSize: 12 }}>{error}</Text>}
      </Space>
    </Card>
  );
}
