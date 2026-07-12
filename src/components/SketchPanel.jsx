/**
 * SketchPanel — Phase 2 sketcher controls: tool palette, constraint buttons,
 * dimensioning, chamfer, undo/redo, solve, and DOF/solve feedback. Drawing
 * happens in the viewport (SketchLayer); this panel is the toolbar and status.
 */
import { Card, Button, Typography, Tag, Space, Segmented, InputNumber, Divider } from 'antd';
import { useState } from 'react';
import { useSketchStore } from '../stores/sketchStore.js';

const { Text } = Typography;

// Point-selection constraints.
const POINT_CONSTRAINTS = [
  { kind: 'coincident', label: 'Coincident', need: 2 },
  { kind: 'horizontal', label: 'Horizontal', need: 2 },
  { kind: 'vertical', label: 'Vertical', need: 2 },
  { kind: 'distance', label: 'Distance', need: 2, value: true },
  { kind: 'lockX', label: 'Lock X', need: 1, value: true },
  { kind: 'lockY', label: 'Lock Y', need: 1, value: true },
];

// Line-selection constraints — need exactly 2 lines selected.
const LINE_CONSTRAINTS = [
  { kind: 'parallel', label: 'Parallel' },
  { kind: 'perpendicular', label: 'Perpendicular' },
  { kind: 'equalLength', label: 'Equal Length' },
];

function toolHint(tool, count) {
  if (tool === 'select') return `Click points, lines or circles to select · ${count} selected`;
  if (tool === 'dimension') return `Pick 1 line / 2 points / 1 circle, set value → Dimension · ${count} selected`;
  if (tool === 'point') return 'Click on the plane to add points';
  return 'Click to start, move, click to finish · Esc cancels';
}

export default function SketchPanel() {
  const {
    sk, tool, selection, dofState, solveResult, error, past, future,
    setTool, applyConstraint, applyConstraintRefs, dimension, chamfer,
    solve, deleteSelected, undo, redo, loadDemo, clear, removeConstraintAt,
  } = useSketchStore();
  const [value, setValue] = useState(10);

  // Split the (mixed point/line/circle) selection by entity type so the
  // line/radius/dimension/chamfer buttons can enable and build ordered refs.
  const lineIds = selection.filter((id) => sk.entities.get(id)?.type === 'line');
  const pointIds = selection.filter((id) => sk.entities.get(id)?.type === 'point');
  const twoLinesSelected = selection.length === 2 && lineIds.length === 2;
  const pointAndLineSelected = selection.length === 2 && pointIds.length === 1 && lineIds.length === 1;
  const isCircleSelection = selection.length === 1 && sk.entities.get(selection[0])?.type === 'circle';
  const oneLine = selection.length === 1 && lineIds.length === 1;
  const twoPoints = selection.length === 2 && pointIds.length === 2;
  const canDimension = oneLine || twoPoints || isCircleSelection;

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
            { label: 'Rectangle', value: 'rectangle' },
            { label: 'Circle', value: 'circle' },
            { label: 'Dimension', value: 'dimension' },
          ]}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {toolHint(tool, selection.length)}
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
          {/* Radius dimension: enabled only when the selection is a single circle. */}
          <Button
            size="small"
            disabled={!isCircleSelection}
            onClick={() => applyConstraint('radius', value)}
          >
            Radius
          </Button>
        </Space>
        <Space size={4}>
          <Text type="secondary" style={{ fontSize: 12 }}>value</Text>
          <InputNumber size="small" value={value} onChange={(v) => setValue(v ?? 0)} style={{ width: 90 }} />
          {/* Smart dimension: infers distance / length / radius from the selection. */}
          <Button size="small" type="primary" ghost disabled={!canDimension} onClick={() => dimension(value)}>
            Dimension
          </Button>
        </Space>

        <Divider style={{ margin: '4px 0' }} />

        <Space wrap size={4}>
          {LINE_CONSTRAINTS.map((c) => (
            <Button
              key={c.kind}
              size="small"
              disabled={!twoLinesSelected}
              onClick={() => applyConstraintRefs(c.kind, lineIds)}
            >
              {c.label}
            </Button>
          ))}
          <Button
            size="small"
            disabled={!pointAndLineSelected}
            onClick={() => applyConstraintRefs('pointOnLine', [pointIds[0], lineIds[0]])}
          >
            Point on Line
          </Button>
          {/* Chamfer the shared corner of two selected lines by `value`. */}
          <Button size="small" disabled={!twoLinesSelected} onClick={() => chamfer(value)}>
            Chamfer
          </Button>
        </Space>

        <Divider style={{ margin: '4px 0' }} />

        <Space wrap size={4}>
          <Button size="small" onClick={() => undo()} disabled={!past.length}>Undo</Button>
          <Button size="small" onClick={() => redo()} disabled={!future.length}>Redo</Button>
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

        <Divider style={{ margin: '4px 0' }} />

        <Text type="secondary" style={{ fontSize: 12 }}>Constraints ({sk.constraints.length})</Text>
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          {sk.constraints.map((c, i) => (
            <Space key={i} size={4} style={{ width: '100%', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 11, color: '#9ca3af' }}>
                {c.kind} [{c.refs.join(', ')}]{c.value != null ? ` = ${c.value}` : ''}
              </Text>
              <Button
                size="small"
                danger
                type="text"
                style={{ fontSize: 11, lineHeight: 1, padding: '0 4px' }}
                onClick={() => removeConstraintAt(i)}
              >
                ×
              </Button>
            </Space>
          ))}
        </Space>
      </Space>
    </Card>
  );
}
