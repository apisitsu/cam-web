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
import { Button, Tooltip, Popover, InputNumber, Space, Tag, Typography, Divider, Segmented } from 'antd';
import {
  UndoOutlined, RedoOutlined, DeleteOutlined, ThunderboltOutlined,
  NodeIndexOutlined, EllipsisOutlined, BulbOutlined, ClearOutlined,
} from '@ant-design/icons';
import { useState, useEffect } from 'react';
import { useSketchStore } from '../stores/sketchStore.js';

const { Text } = Typography;
const DEG = Math.PI / 180;

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
const TrimIcon = glyph(<><circle cx="6" cy="7" r="2.4" /><circle cx="6" cy="17" r="2.4" /><path d="M8 8.4L20 16M8 15.6L20 8" /></>);
const ChamferIcon = glyph(<path d="M5 20V10L11 4H20" />);

const TOOLS = [
  { value: 'select', label: 'Select', Icon: SelectIcon, hint: 'Click points, lines, circles or arcs to select' },
  { value: 'point', label: 'Point', Icon: PointIcon, hint: 'Click on the plane to add points' },
  { value: 'line', label: 'Line', Icon: LineIcon, hint: 'Click to start, click to finish · locks to 0/45/90…° and snaps tangent to circles/arcs · Esc cancels' },
  { value: 'rectangle', label: 'Rectangle', Icon: RectIcon, hint: 'Click two opposite corners' },
  { value: 'circle', label: 'Circle', Icon: CircleIcon, hint: 'Click centre, then a point on the rim' },
  { value: 'arc', label: 'Arc', Icon: ArcIcon, hint: 'Click centre, start, then end (sweeps CCW) · Esc cancels' },
  { value: 'dimension', label: 'Dimension', Icon: DimIcon, hint: 'Pick 1 pt (to origin) / 2 pts / 1 line / 1 circle / pt+line / 2 lines (gap or angle) / line+circle / 2 circles — set value, or click empty space to apply' },
  { value: 'trim', label: 'Trim', Icon: TrimIcon, hint: 'Click a line, circle or arc to trim it at its intersections' },
  { value: 'chamfer', label: 'Chamfer / Fillet', Icon: ChamferIcon, hint: 'Click the two lines that share a corner, choose C (chamfer) or R (fillet), then type the size' },
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
    sk, selection, applyConstraint, applyConstraintRefs, dimension,
    removeConstraintAt, resolveDimension,
  } = useSketchStore();
  const [value, setValue] = useState(10);

  const lineIds = selection.filter((id) => sk.entities.get(id)?.type === 'line');
  const pointIds = selection.filter((id) => sk.entities.get(id)?.type === 'point');
  const circleIds = selection.filter((id) => sk.entities.get(id)?.type === 'circle');
  const arcIds = selection.filter((id) => sk.entities.get(id)?.type === 'arc');
  const twoLinesSelected = selection.length === 2 && lineIds.length === 2;
  const pointAndLineSelected = selection.length === 2 && pointIds.length === 1 && lineIds.length === 1;
  const lineAndCircle = selection.length === 2 && lineIds.length === 1 && circleIds.length === 1;
  const lineAndArc = selection.length === 2 && lineIds.length === 1 && arcIds.length === 1;
  const isCircleSelection = selection.length === 1 && sk.entities.get(selection[0])?.type === 'circle';
  // What (if anything) a dimension would apply to for the current selection.
  const dimSpec = resolveDimension();

  return (
    <div style={{ width: 268 }}>
      <Space size={4}>
        <Text type="secondary" style={{ fontSize: 12 }}>value</Text>
        <InputNumber controls={false} size="small" value={value} onChange={(v) => setValue(v ?? 0)} style={{ width: 90 }} />
        <Button size="small" type="primary" ghost disabled={!dimSpec} onClick={() => dimension(value)}>
          {dimSpec ? `Dim: ${dimSpec.label}` : 'Dimension'}
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
        <Button
          size="small"
          disabled={!twoLinesSelected}
          onClick={() => applyConstraintRefs('angle', lineIds, value * DEG)}
        >
          Angle°
        </Button>
        <Button
          size="small"
          disabled={!(lineAndCircle || lineAndArc)}
          onClick={() => (lineAndCircle
            ? applyConstraintRefs('tangent', [lineIds[0], circleIds[0]])
            : applyConstraintRefs('tangentArc', [lineIds[0], arcIds[0]]))}
        >
          Tangent
        </Button>
      </Space>

      <Divider style={{ margin: '8px 0' }} />

      <Text type="secondary" style={{ fontSize: 12 }}>Constraints ({sk.constraints.length})</Text>
      <div style={{ maxHeight: 160, overflow: 'auto', marginTop: 4 }}>
        {sk.constraints.map((c, i) => (
          <Space key={i} size={4} style={{ width: '100%', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 11, color: '#9ca3af' }}>
              {c.kind} [{c.refs.join(', ')}]
              {c.value != null ? ` = ${c.kind === 'angle' ? `${(c.value / DEG).toFixed(1)}°` : c.value}` : ''}
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

/**
 * Inline dimension value entry — appears under the toolbar when a dimension-mode
 * empty-click captured a dimensionable selection (`dimensionPending`). Replaces
 * the old window.prompt: auto-focused, Enter applies, Esc/✕ cancels.
 */
function DimensionInput() {
  const dimensionPending = useSketchStore((s) => s.dimensionPending);
  const dimension = useSketchStore((s) => s.dimension);
  const cancelDimension = useSketchStore((s) => s.cancelDimension);
  const swapDimensionRefs = useSketchStore((s) => s.swapDimensionRefs);
  const [val, setVal] = useState(10);

  useEffect(() => {
    if (dimensionPending) {
      const cur = dimensionPending.current;
      setVal(Number.isFinite(cur) ? Math.round(cur * 1000) / 1000 : 10);
    }
  }, [dimensionPending]);

  if (!dimensionPending) return null;
  const apply = () => { if (Number.isFinite(val)) dimension(val); };
  // For an angle the two lines aren't symmetric: the constraint is measured FROM
  // the base line (highlighted cyan in the viewport) TO the rotating line (amber).
  // Swap flips which is which so the user controls the reference.
  const angular = !!dimensionPending.angular;

  return (
    <div
      onKeyDown={(e) => { if (e.key === 'Escape') cancelDimension(); }}
      style={{
        position: 'absolute', top: 60, left: 12, zIndex: 6,
        display: 'flex', gap: 6, alignItems: 'center',
        background: 'rgba(15,23,42,0.95)', border: '1px solid #38bdf8',
        padding: '6px 10px', borderRadius: 8,
      }}
    >
      <Text style={{ color: '#cbd5e1', fontSize: 12 }}>{dimensionPending.label}</Text>
      {angular && (
        <>
          <Text style={{ color: '#22d3ee', fontSize: 11 }}>base L{dimensionPending.refs[0]}</Text>
          <Text style={{ color: '#64748b', fontSize: 11 }}>→</Text>
          <Text style={{ color: '#f59e0b', fontSize: 11 }}>rotate L{dimensionPending.refs[1]}</Text>
          <Tooltip title="Swap base / rotating line">
            <Button size="small" onClick={swapDimensionRefs} style={{ padding: '0 6px' }}>⇄</Button>
          </Tooltip>
        </>
      )}
      <InputNumber controls={false}
        autoFocus
        size="small"
        value={val}
        onChange={(v) => setVal(v ?? 0)}
        onPressEnter={apply}
        style={{ width: 96 }}
        addonAfter={dimensionPending.unit ?? 'mm'}
      />
      <Button size="small" type="primary" onClick={apply}>Set</Button>
      <Button size="small" type="text" style={{ color: '#94a3b8' }} onClick={cancelDimension}>✕</Button>
    </div>
  );
}

/**
 * Inline chamfer/fillet entry — the Chamfer tool's companion, shown once two
 * lines that share a corner are picked. A C/R toggle chooses a straight **C**hamfer
 * or a rounded **R** fillet; type a size and Set applies it (typed value only, no
 * spinner). Picking elsewhere clears the selection and hides this.
 */
function ChamferInput() {
  const tool = useSketchStore((s) => s.tool);
  const selection = useSketchStore((s) => s.selection);
  const sk = useSketchStore((s) => s.sk);
  const chamfer = useSketchStore((s) => s.chamfer);
  const fillet = useSketchStore((s) => s.fillet);
  const chamferKind = useSketchStore((s) => s.chamferKind);
  const setChamferKind = useSketchStore((s) => s.setChamferKind);
  const [val, setVal] = useState(3);

  const lineIds = selection.filter((id) => sk.entities.get(id)?.type === 'line');
  if (tool !== 'chamfer' || lineIds.length !== 2) return null;
  const rounded = chamferKind === 'R';
  const apply = () => {
    if (!(Number.isFinite(val) && val > 0)) return;
    rounded ? fillet(val) : chamfer(val);
  };

  return (
    <div
      style={{
        position: 'absolute', top: 60, left: 12, zIndex: 6,
        display: 'flex', gap: 6, alignItems: 'center',
        background: 'rgba(15,23,42,0.95)', border: '1px solid #f59e0b',
        padding: '6px 10px', borderRadius: 8,
      }}
    >
      <Text style={{ color: '#cbd5e1', fontSize: 12 }}>{rounded ? 'Fillet' : 'Chamfer'}</Text>
      <Tooltip title="C = straight chamfer · R = rounded fillet (tangent arc)">
        <Segmented
          size="small"
          value={chamferKind}
          onChange={setChamferKind}
          options={[{ label: 'C', value: 'C' }, { label: 'R', value: 'R' }]}
        />
      </Tooltip>
      <InputNumber controls={false}
        autoFocus
        size="small"
        value={val}
        onChange={(v) => setVal(v ?? 0)}
        onPressEnter={apply}
        style={{ width: 96 }}
        addonAfter={rounded ? 'R mm' : 'mm'}
      />
      <Button size="small" type="primary" onClick={apply}>Set</Button>
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
  // Vertical hairline separating groups in the horizontal rail.
  const sep = <div style={{ width: 1, height: 24, background: '#334155', margin: '0 2px' }} />;

  return (
    <>
    <div style={{
      position: 'absolute', top: 12, left: 12, zIndex: 5,
      display: 'flex', flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap',
      background: 'rgba(15,23,42,0.82)', border: '1px solid #334155',
      padding: 6, borderRadius: 8, maxWidth: 'calc(100% - 24px)',
    }}>
      {TOOLS.map((t) => (
        <Tooltip key={t.value} title={`${t.label} — ${t.hint}`} placement="bottom">
          <Button
            type={tool === t.value ? 'primary' : 'text'}
            icon={<t.Icon />}
            onClick={() => setTool(t.value)}
            style={{ ...railBtn(), color: tool === t.value ? undefined : '#cbd5e1' }}
          />
        </Tooltip>
      ))}

      {sep}

      <Popover
        trigger="click"
        placement="bottomLeft"
        title="Constraints & dimensions"
        content={<ConstraintsPanel />}
      >
        <Tooltip title="Constraints & dimensions" placement="bottom">
          <Button type="text" icon={<NodeIndexOutlined />} style={{ ...railBtn(), color: '#cbd5e1' }} />
        </Tooltip>
      </Popover>

      <Tooltip title="Solve (apply constraints)" placement="bottom">
        <Button type="text" icon={<ThunderboltOutlined />} onClick={() => solve()} style={{ ...railBtn(), color: '#38bdf8' }} />
      </Tooltip>
      <Tooltip title="Undo (Ctrl+Z)" placement="bottom">
        <Button type="text" icon={<UndoOutlined />} disabled={!past.length} onClick={() => undo()} style={{ ...railBtn(), color: '#cbd5e1' }} />
      </Tooltip>
      <Tooltip title="Redo (Ctrl+Y)" placement="bottom">
        <Button type="text" icon={<RedoOutlined />} disabled={!future.length} onClick={() => redo()} style={{ ...railBtn(), color: '#cbd5e1' }} />
      </Tooltip>
      <Tooltip title="Delete selection (Del)" placement="bottom">
        <Button type="text" danger icon={<DeleteOutlined />} disabled={!selection.length} onClick={() => deleteSelected()} style={railBtn()} />
      </Tooltip>

      <Popover
        trigger="click"
        placement="bottomLeft"
        content={(
          <Space direction="vertical" size={4}>
            <Button size="small" icon={<BulbOutlined />} onClick={() => loadDemo()} block>Demo sketch</Button>
            <Button size="small" icon={<ClearOutlined />} onClick={() => clear()} block>Clear all</Button>
          </Space>
        )}
      >
        <Tooltip title="More" placement="bottom">
          <Button type="text" icon={<EllipsisOutlined />} style={{ ...railBtn(), color: '#cbd5e1' }} />
        </Tooltip>
      </Popover>

      {/* Compact status: active-tool hint, DOF, solve result. */}
      {sep}
      <Space size={4}>
        {dofState && (
          <Tooltip
            placement="bottom"
            title={`${dofState.free} free DOF — ${dofState.state}${activeHint ? ` · ${activeHint}` : ''}`}
          >
            <Tag
              color={dofState.state === 'full' ? 'green' : dofState.state === 'over' ? 'red' : 'blue'}
              style={{ margin: 0, minWidth: 28, textAlign: 'center', fontSize: 10, padding: '0 4px' }}
            >
              {dofState.state === 'full' ? '✓' : dofState.free}
            </Tag>
          </Tooltip>
        )}
        {solveResult && !solveResult.success && (
          <Tooltip title={`solve status ${solveResult.status}`} placement="bottom">
            <Tag color="red" style={{ margin: 0, minWidth: 20, textAlign: 'center', fontSize: 10, padding: '0 4px' }}>!</Tag>
          </Tooltip>
        )}
        {error && (
          <Tooltip title={error} placement="bottom">
            <Tag color="orange" style={{ margin: 0, minWidth: 20, textAlign: 'center', fontSize: 10, padding: '0 4px' }}>?</Tag>
          </Tooltip>
        )}
      </Space>
    </div>
    <DimensionInput />
    <ChamferInput />
    </>
  );
}
