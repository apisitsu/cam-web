/**
 * SketchToolbar — the sketcher's controls as a symbolic **icon toolbar** floating
 * over the 3D viewport (replaces the old text panel in the sidebar). A vertical
 * rail of glyph buttons picks the drawing tool and runs the frequent actions
 * (undo/redo/solve/delete); the contextual constraint buttons, the dimension
 * value, and the constraint list live in a popover so the rail stays compact.
 *
 * Drawing itself still happens in the viewport (SketchLayer); this is the toolbar
 * and status readout, wired to the same sketchStore.
 */
import { Button, Tooltip, Popover, InputNumber, Space, Tag, Typography, Divider } from 'antd';
import {
  UndoOutlined, RedoOutlined, DeleteOutlined, ThunderboltOutlined,
  NodeIndexOutlined, EllipsisOutlined, BulbOutlined, ClearOutlined,
} from '@ant-design/icons';
import { useState } from 'react';
import { useSketchStore } from '../stores/sketchStore.js';

const { Text } = Typography;

/** Wrap an SVG path set as an antd-compatible icon. */
const glyph = (node) => function Glyph() {
  return (
    <span role="img" className="anticon" style={{ display: 'inline-flex' }}>
      <svg
        viewBox="0 0 24 24" width="1em" height="1em" fill="none"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      >
        {node}
      </svg>
    </span>
  );
};

// Symbolic glyphs for each drawing tool.
const SelectIcon = glyph(<path d="M5 3l6 15 2.2-6.2L19.5 9.6z" fill="currentColor" stroke="none" />);
const PointIcon = glyph(<><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></>);
const LineIcon = glyph(<><line x1="5" y1="19" x2="19" y2="5" /><circle cx="5" cy="19" r="1.8" fill="currentColor" /><circle cx="19" cy="5" r="1.8" fill="currentColor" /></>);
const RectIcon = glyph(<rect x="4.5" y="6.5" width="15" height="11" />);
const CircleIcon = glyph(<circle cx="12" cy="12" r="7.5" />);
const ArcIcon = glyph(<><path d="M4 18A14 14 0 0 1 18 4" /><circle cx="4" cy="18" r="1.8" fill="currentColor" /><circle cx="18" cy="4" r="1.8" fill="currentColor" /></>);
const DimIcon = glyph(<><path d="M4 7v10M20 7v10M4 12h16" /><path d="M7 9l-3 3 3 3M17 9l3 3-3 3" /></>);

const TOOLS = [
  { value: 'select', label: 'Select', Icon: SelectIcon, hint: 'Click points, lines, circles or arcs to select' },
  { value: 'point', label: 'Point', Icon: PointIcon, hint: 'Click on the plane to add points' },
  { value: 'line', label: 'Line', Icon: LineIcon, hint: 'Click to start, click to finish · Esc cancels' },
  { value: 'rectangle', label: 'Rectangle', Icon: RectIcon, hint: 'Click two opposite corners' },
  { value: 'circle', label: 'Circle', Icon: CircleIcon, hint: 'Click centre, then a point on the rim' },
  { value: 'arc', label: 'Arc', Icon: ArcIcon, hint: 'Click centre, start, then end (sweeps CCW) · Esc cancels' },
  { value: 'dimension', label: 'Dimension', Icon: DimIcon, hint: 'Pick 1 line / 2 points / 1 circle, set a value → Dimension' },
];

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

/** The contextual constraint/dimension controls shown inside the popover. */
function ConstraintsPanel() {
  const {
    sk, selection, applyConstraint, applyConstraintRefs, dimension, chamfer, removeConstraintAt,
  } = useSketchStore();
  const [value, setValue] = useState(10);

  const lineIds = selection.filter((id) => sk.entities.get(id)?.type === 'line');
  const pointIds = selection.filter((id) => sk.entities.get(id)?.type === 'point');
  const twoLinesSelected = selection.length === 2 && lineIds.length === 2;
  const pointAndLineSelected = selection.length === 2 && pointIds.length === 1 && lineIds.length === 1;
  const isCircleSelection = selection.length === 1 && sk.entities.get(selection[0])?.type === 'circle';
  const oneLine = selection.length === 1 && lineIds.length === 1;
  const twoPoints = selection.length === 2 && pointIds.length === 2;
  const canDimension = oneLine || twoPoints || isCircleSelection;

  return (
    <div style={{ width: 268 }}>
      <Space size={4}>
        <Text type="secondary" style={{ fontSize: 12 }}>value</Text>
        <InputNumber size="small" value={value} onChange={(v) => setValue(v ?? 0)} style={{ width: 90 }} />
        <Button size="small" type="primary" ghost disabled={!canDimension} onClick={() => dimension(value)}>
          Dimension
        </Button>
      </Space>

      <Divider style={{ margin: '8px 0' }} />

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
        <Button size="small" disabled={!isCircleSelection} onClick={() => applyConstraint('radius', value)}>
          Radius
        </Button>
      </Space>

      <Divider style={{ margin: '8px 0' }} />

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
        <Button size="small" disabled={!twoLinesSelected} onClick={() => chamfer(value)}>
          Chamfer
        </Button>
      </Space>

      <Divider style={{ margin: '8px 0' }} />

      <Text type="secondary" style={{ fontSize: 12 }}>Constraints ({sk.constraints.length})</Text>
      <div style={{ maxHeight: 160, overflow: 'auto', marginTop: 4 }}>
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
      </div>
    </div>
  );
}

export default function SketchToolbar() {
  const tool = useSketchStore((s) => s.tool);
  const selection = useSketchStore((s) => s.selection);
  const past = useSketchStore((s) => s.past);
  const future = useSketchStore((s) => s.future);
  const dofState = useSketchStore((s) => s.dofState);
  const solveResult = useSketchStore((s) => s.solveResult);
  const error = useSketchStore((s) => s.error);
  const setTool = useSketchStore((s) => s.setTool);
  const solve = useSketchStore((s) => s.solve);
  const undo = useSketchStore((s) => s.undo);
  const redo = useSketchStore((s) => s.redo);
  const deleteSelected = useSketchStore((s) => s.deleteSelected);
  const loadDemo = useSketchStore((s) => s.loadDemo);
  const clear = useSketchStore((s) => s.clear);

  const activeHint = TOOLS.find((t) => t.value === tool)?.hint;

  const railBtn = () => ({ width: 34, height: 34 });

  return (
    <div style={{
      position: 'absolute', top: 12, left: 12, zIndex: 5,
      display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch',
      background: 'rgba(15,23,42,0.82)', border: '1px solid #334155',
      padding: 6, borderRadius: 8, maxWidth: 46,
    }}>
      {TOOLS.map((t) => (
        <Tooltip key={t.value} title={`${t.label} — ${t.hint}`} placement="right">
          <Button
            type={tool === t.value ? 'primary' : 'text'}
            icon={<t.Icon />}
            onClick={() => setTool(t.value)}
            style={{ ...railBtn(), color: tool === t.value ? undefined : '#cbd5e1' }}
          />
        </Tooltip>
      ))}

      <div style={{ height: 1, background: '#334155', margin: '2px 0' }} />

      <Popover
        trigger="click"
        placement="rightTop"
        title="Constraints & dimensions"
        content={<ConstraintsPanel />}
      >
        <Tooltip title="Constraints & dimensions" placement="right">
          <Button type="text" icon={<NodeIndexOutlined />} style={{ ...railBtn(), color: '#cbd5e1' }} />
        </Tooltip>
      </Popover>

      <Tooltip title="Solve (apply constraints)" placement="right">
        <Button type="text" icon={<ThunderboltOutlined />} onClick={() => solve()} style={{ ...railBtn(), color: '#38bdf8' }} />
      </Tooltip>
      <Tooltip title="Undo (Ctrl+Z)" placement="right">
        <Button type="text" icon={<UndoOutlined />} disabled={!past.length} onClick={() => undo()} style={{ ...railBtn(), color: '#cbd5e1' }} />
      </Tooltip>
      <Tooltip title="Redo (Ctrl+Y)" placement="right">
        <Button type="text" icon={<RedoOutlined />} disabled={!future.length} onClick={() => redo()} style={{ ...railBtn(), color: '#cbd5e1' }} />
      </Tooltip>
      <Tooltip title="Delete selection (Del)" placement="right">
        <Button type="text" danger icon={<DeleteOutlined />} disabled={!selection.length} onClick={() => deleteSelected()} style={railBtn()} />
      </Tooltip>

      <Popover
        trigger="click"
        placement="rightTop"
        content={(
          <Space direction="vertical" size={4}>
            <Button size="small" icon={<BulbOutlined />} onClick={() => loadDemo()} block>Demo sketch</Button>
            <Button size="small" icon={<ClearOutlined />} onClick={() => clear()} block>Clear all</Button>
          </Space>
        )}
      >
        <Tooltip title="More" placement="right">
          <Button type="text" icon={<EllipsisOutlined />} style={{ ...railBtn(), color: '#cbd5e1' }} />
        </Tooltip>
      </Popover>

      {/* Compact status: active-tool hint, DOF, solve result. */}
      <div style={{ height: 1, background: '#334155', margin: '2px 0' }} />
      <div style={{ maxWidth: 34 }}>
        {dofState && (
          <Tooltip
            placement="right"
            title={`${dofState.free} free DOF — ${dofState.state}${activeHint ? ` · ${activeHint}` : ''}`}
          >
            <Tag
              color={dofState.state === 'full' ? 'green' : dofState.state === 'over' ? 'red' : 'blue'}
              style={{ margin: 0, width: 34, textAlign: 'center', fontSize: 10, padding: 0 }}
            >
              {dofState.state === 'full' ? '✓' : dofState.free}
            </Tag>
          </Tooltip>
        )}
        {solveResult && !solveResult.success && (
          <Tooltip title={`solve status ${solveResult.status}`} placement="right">
            <Tag color="red" style={{ margin: '4px 0 0', width: 34, textAlign: 'center', fontSize: 10, padding: 0 }}>!</Tag>
          </Tooltip>
        )}
        {error && (
          <Tooltip title={error} placement="right">
            <Tag color="orange" style={{ margin: '4px 0 0', width: 34, textAlign: 'center', fontSize: 10, padding: 0 }}>?</Tag>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
