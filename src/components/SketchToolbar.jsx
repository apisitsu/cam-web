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
  { value: 'select', label: 'Select', Icon: SelectIcon, hint: 'Click to select points, lines, circles or arcs · drag a point to move it (the sketch re-solves) · double-click a dimension to edit it' },
  { value: 'point', label: 'Point', Icon: PointIcon, hint: 'Click on the plane to add points' },
  { value: 'line', label: 'Line', Icon: LineIcon, hint: 'Click to start, click to finish · locks to 0/45/90…° and snaps tangent to circles/arcs · Esc cancels' },
  { value: 'rectangle', label: 'Rectangle', Icon: RectIcon, hint: 'Click two opposite corners' },
  { value: 'circle', label: 'Circle', Icon: CircleIcon, hint: 'Click centre, then a point on the rim' },
  { value: 'arc', label: 'Arc', Icon: ArcIcon, hint: 'Click centre, start, then end (sweeps CCW) · Esc cancels' },
  { value: 'dimension', label: 'Dimension', Icon: DimIcon, hint: 'Pick 1 pt (to origin) / 2 pts / 1 line / 1 circle / 1 arc / pt+line / 2 lines (gap or angle) / line+circle / 2 circles — set value, or click empty space to apply' },
  { value: 'trim', label: 'Trim', Icon: TrimIcon, hint: 'Click a line, circle or arc to trim it at its intersections' },
  { value: 'chamfer', label: 'Chamfer / Fillet', Icon: ChamferIcon, hint: 'Click the two elements that share a corner (2 lines, or a line + arc / 2 arcs), choose C (chamfer) or R (fillet — the only option when a curve is involved), then type the size' },
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
    toggleConstruction, mirror, offset, toggleDriven,
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
  const isArcSelection = selection.length === 1 && sk.entities.get(selection[0])?.type === 'arc';
  // Two circles/arcs (any mix) → Equal Radius / Concentric.
  const curveIds = [...circleIds, ...arcIds];
  const twoCurves = selection.length === 2 && curveIds.length === 2;
  const centreOf = (id) => sk.entities.get(id)?.center;
  // 2 points + 1 line → Symmetric (the line is the axis).
  const symmetricSel = selection.length === 3 && pointIds.length === 2 && lineIds.length === 1;
  // Geometry present → construction toggle / offset; ≥2 with a line → mirror.
  const geomSel = [...lineIds, ...circleIds, ...arcIds];
  const canMirror = selection.length >= 2 && lineIds.length >= 1;
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
        <Button
          size="small"
          disabled={!isCircleSelection && !isArcSelection}
          onClick={() => applyConstraint(isArcSelection ? 'arcRadius' : 'radius', value)}
        >
          Radius
        </Button>
        <Button size="small" disabled={!isCircleSelection} onClick={() => applyConstraint('diameter', value)}>
          Diameter
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
          disabled={!pointAndLineSelected}
          onClick={() => applyConstraintRefs('midpoint', [pointIds[0], lineIds[0]])}
        >
          Midpoint
        </Button>
        <Button
          size="small"
          disabled={!twoCurves}
          onClick={() => applyConstraintRefs('equalRadius', curveIds)}
        >
          Equal Radius
        </Button>
        <Button
          size="small"
          disabled={!twoCurves}
          onClick={() => applyConstraintRefs('coincident', [centreOf(curveIds[0]), centreOf(curveIds[1])])}
        >
          Concentric
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
        <Button
          size="small"
          disabled={!symmetricSel}
          onClick={() => applyConstraintRefs('symmetric', [pointIds[0], pointIds[1], lineIds[0]])}
        >
          Symmetric
        </Button>
      </Space>

      <Divider style={{ margin: '8px 0' }} />

      {/* Modify tools: construction toggle, mirror, offset. */}
      <Space wrap size={4}>
        <Button size="small" disabled={!geomSel.length} onClick={() => toggleConstruction()}>
          Construction
        </Button>
        <Tooltip title="Mirror the selection about an axis line (make the axis a construction line)">
          <Button size="small" disabled={!canMirror} onClick={() => mirror()}>Mirror</Button>
        </Tooltip>
        <Tooltip title="Offset the selected lines/circles/arcs by the value (negative flips the side)">
          <Button size="small" disabled={!geomSel.length} onClick={() => offset(value)}>Offset</Button>
        </Tooltip>
      </Space>

      <Divider style={{ margin: '8px 0' }} />

      <Text type="secondary" style={{ fontSize: 12 }}>Constraints ({sk.constraints.length})</Text>
      <div style={{ maxHeight: 160, overflow: 'auto', marginTop: 4 }}>
        {sk.constraints.map((c, i) => (
          <Space key={i} size={4} style={{ width: '100%', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 11, color: c.driven ? '#c4b5fd' : '#9ca3af' }}>
              {c.kind} [{c.refs.join(', ')}]
              {c.value != null ? ` = ${c.kind === 'angle' ? `${(c.value / DEG).toFixed(1)}°` : Math.round(c.value * 100) / 100}` : ''}
              {c.driven ? ' (ref)' : ''}
            </Text>
            <Space size={0}>
              {c.value != null && (
                <Tooltip title={c.driven ? 'Make driving' : 'Make driven (reference only)'}>
                  <Button
                    size="small"
                    type="text"
                    style={{ fontSize: 11, lineHeight: 1, padding: '0 4px', color: c.driven ? '#a78bfa' : '#64748b' }}
                    onClick={() => toggleDriven(i)}
                  >
                    D
                  </Button>
                </Tooltip>
              )}
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
 * Inline editor for an already-placed dimension — appears when a dimension label
 * in the viewport is double-clicked (`editingConstraint`). Prefilled with the
 * current value (degrees for an angle, mm otherwise); Enter/Set commits and
 * re-solves, Esc/✕ cancels. Distinct green border so it reads as "editing", not
 * "adding".
 */
function EditDimensionInput() {
  const editingConstraint = useSketchStore((s) => s.editingConstraint);
  const applyEditConstraint = useSketchStore((s) => s.applyEditConstraint);
  const cancelEditConstraint = useSketchStore((s) => s.cancelEditConstraint);
  const [val, setVal] = useState(0);

  useEffect(() => {
    if (editingConstraint) {
      const cur = editingConstraint.value;
      setVal(Number.isFinite(cur) ? Math.round(cur * 1000) / 1000 : 0);
    }
  }, [editingConstraint]);

  if (!editingConstraint) return null;
  const apply = () => { if (Number.isFinite(val)) applyEditConstraint(val); };

  return (
    <div
      onKeyDown={(e) => { if (e.key === 'Escape') cancelEditConstraint(); }}
      style={{
        position: 'absolute', top: 104, left: 12, zIndex: 6,
        display: 'flex', gap: 6, alignItems: 'center',
        background: 'rgba(15,23,42,0.95)', border: '1px solid #22c55e',
        padding: '6px 10px', borderRadius: 8,
      }}
    >
      <Text style={{ color: '#cbd5e1', fontSize: 12 }}>Edit {editingConstraint.label}</Text>
      <InputNumber controls={false}
        autoFocus
        size="small"
        value={val}
        onChange={(v) => setVal(v ?? 0)}
        onPressEnter={apply}
        style={{ width: 96 }}
        addonAfter={editingConstraint.angular ? '°' : 'mm'}
      />
      <Button size="small" type="primary" onClick={apply}>Set</Button>
      <Button size="small" type="text" style={{ color: '#94a3b8' }} onClick={cancelEditConstraint}>✕</Button>
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
  const arcIds = selection.filter((id) => sk.entities.get(id)?.type === 'arc');
  // Valid pairings: 2 lines (chamfer or fillet), or a curve is involved
  // (1 line + 1 arc, or 2 arcs) → fillet only, since a straight chamfer needs
  // two straight edges.
  const twoLines = selection.length === 2 && lineIds.length === 2;
  const withArc = selection.length === 2 && arcIds.length >= 1 && lineIds.length + arcIds.length === 2;
  if (tool !== 'chamfer' || (!twoLines && !withArc)) return null;
  // A curve pairing forces fillet (R); two lines respect the C/R toggle.
  const rounded = withArc || chamferKind === 'R';
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
      {twoLines ? (
        <Tooltip title="C = straight chamfer · R = rounded fillet (tangent arc)">
          <Segmented
            size="small"
            value={chamferKind}
            onChange={setChamferKind}
            options={[{ label: 'C', value: 'C' }, { label: 'R', value: 'R' }]}
          />
        </Tooltip>
      ) : (
        <Tooltip title="A junction with an arc can only be rounded (fillet), not chamfered">
          <Tag color="orange" style={{ margin: 0 }}>R</Tag>
        </Tooltip>
      )}
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
    <EditDimensionInput />
    <ChamferInput />
    </>
  );
}
