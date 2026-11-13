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
  NodeIndexOutlined,
} from '@ant-design/icons';
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSketchStore } from '../stores/sketchStore.js';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { useCamStore } from '../stores/camStore.js';
import { patternSeeds } from '../engine/sketch/edit.js';
import { PLANE_PRESETS, planeBasis } from '../engine/sketch/plane.js';
import { useFeatureStore } from '../stores/featureStore.js';
import RibbonButton from './RibbonButton.jsx';
import SketchesPanel from './SketchesPanel.jsx';
import BuildPanel from './BuildPanel.jsx';
// The helper this rail introduced now serves the whole app — see `glyph.jsx`.
import { glyph, skGlyph, INK } from './glyph.jsx';
import { CAD } from '../theme.js';

const { Text } = Typography;
const DEG = Math.PI / 180;

// Every rail and prompt on this page floats over the viewport. On the old
// near-black background a pale panel separated itself by contrast; on the light
// CAD one it does not, so they all carry the same drop shadow instead. One
// constant, so the sketcher's six floating surfaces cannot drift apart.
const FLOAT_SHADOW = '0 2px 10px rgba(23,42,66,0.18)';

// Symbolic glyphs for each drawing tool.
const SelectIcon = glyph(<path d="M5 3l6 15 2.2-6.2L19.5 9.6z" fill="currentColor" stroke="none" />);
const PointIcon = skGlyph(<><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></>);
const LineIcon = skGlyph(<><line x1="5" y1="19" x2="19" y2="5" /><circle cx="5" cy="19" r="1.8" fill="currentColor" /><circle cx="19" cy="5" r="1.8" fill="currentColor" /></>);
const RectIcon = skGlyph(<rect x="4.5" y="6.5" width="15" height="11" />);
const SlotIcon = skGlyph(<path d="M8.5 7.5h7a4.5 4.5 0 0 1 0 9h-7a4.5 4.5 0 0 1 0-9z" />);
const PolygonIcon = skGlyph(<path d="M12 4l7 4.2v7.6L12 20l-7-4.2V8.2z" />);
const CircleIcon = skGlyph(<circle cx="12" cy="12" r="7.5" />);
const ArcIcon = skGlyph(<><path d="M4 18A14 14 0 0 1 18 4" /><circle cx="4" cy="18" r="1.8" fill="currentColor" /><circle cx="18" cy="4" r="1.8" fill="currentColor" /></>);
const DimIcon = glyph(<><path d="M4 7v10M20 7v10M4 12h16" /><path d="M7 9l-3 3 3 3M17 9l3 3-3 3" /></>);
// Center Rectangle: a rectangle with its centre and a dashed diagonal.
const CenterRectIcon = skGlyph(<><rect x="4.5" y="6.5" width="15" height="11" /><path d="M4.5 6.5l15 11" strokeDasharray="2 1.6" opacity="0.6" /><circle cx="12" cy="12" r="1.8" fill="currentColor" /></>);
// 3-Point Arc: an arc through three marked points.
const Arc3Icon = skGlyph(<><path d="M4 17A9 9 0 0 1 20 17" /><circle cx="4" cy="17" r="1.8" fill="currentColor" /><circle cx="20" cy="17" r="1.8" fill="currentColor" /><circle cx="12" cy="8" r="1.8" fill="currentColor" /></>);
// Tangent Arc: a line running straight on into a curve.
const TangentArcIcon = skGlyph(<><path d="M3 18h8" /><path d="M11 18a7 7 0 0 0 7-7V5" /><circle cx="11" cy="18" r="1.8" fill="currentColor" /></>);
// Extend: a short line with an arrow running on to a wall.
const ExtendIcon = glyph(<><path d="M20 4v16" stroke={INK.sketch} /><path d="M3 12h6" stroke={INK.sketch} /><path d="M9 12h8M14.5 9.5L17 12l-2.5 2.5" stroke={INK.go} strokeDasharray="2 1.5" /></>);
// Convert Entities: a part's edge (solid) copied up into the sketch (sketch blue).
const ConvertIcon = glyph(<><path d="M3 15l7-3.5 11 4-7 3.5z" fill={INK.body} /><path d="M3 15l7-3.5 11 4" stroke={INK.sketch} strokeWidth="2.2" /><path d="M12 9V3M9.5 5.5L12 3l2.5 2.5" stroke={INK.go} strokeWidth="2" /></>);
const TrimIcon = glyph(<><circle cx="6" cy="7" r="2.4" stroke={INK.cut} /><circle cx="6" cy="17" r="2.4" stroke={INK.cut} /><path d="M8 8.4L20 16M8 15.6L20 8" /></>);
const ChamferIcon = glyph(<><path d="M5 20V10M11 4H20" stroke={INK.sketch} /><path d="M5 10L11 4" stroke={INK.cut} strokeWidth="2.6" /></>);
// Sketch-modify tools (SolidWorks keeps these on the Sketch tab, not with relations).
const ConstructionIcon = skGlyph(<path d="M4 18L20 6" strokeDasharray="3 2.5" />);
const MirrorIcon = glyph(<><path d="M12 3v18" strokeDasharray="3 2" /><path d="M9 7L4 12l5 5z" stroke={INK.sketch} fill={INK.sketchSoft} /><path d="M15 7l5 5-5 5z" stroke={INK.sketch} strokeDasharray="2.5 1.5" /></>);
const OffsetIcon = skGlyph(<><path d="M4 16c4-8 12-8 16 0" /><path d="M4 20c4-8 12-8 16 0" opacity="0.55" /></>);
// Linear Pattern: a shape repeating along a line, fading out — the repeats,
// not the direction, are the point, so no arrow is drawn.
const LinearPatternIcon = glyph(<g stroke={INK.sketch}><rect x="3.5" y="9" width="5" height="6" fill={INK.sketchSoft} /><rect x="10" y="9" width="5" height="6" opacity="0.6" /><rect x="16.5" y="9" width="4" height="6" opacity="0.3" /></g>);
// Circular Pattern: the same repeats, arranged around a centre.
const CircularPatternIcon = glyph(<g stroke={INK.sketch}><rect x="10" y="3.3" width="4" height="4" fill={INK.sketchSoft} /><rect x="16.7" y="7.3" width="4" height="4" opacity="0.6" /><rect x="16.7" y="14.7" width="4" height="4" opacity="0.3" /><rect x="10" y="18.7" width="4" height="4" opacity="0.3" /><rect x="3.3" y="14.7" width="4" height="4" opacity="0.3" /><rect x="3.3" y="7.3" width="4" height="4" opacity="0.6" /></g>);
// Copy / Paste: the familiar stacked-rectangle and clipboard glyphs.
const CopyIcon = glyph(<><rect x="8.5" y="8.5" width="11" height="11" rx="1" /><path d="M5.5 15.5V5.5a1 1 0 0 1 1-1h10" opacity="0.55" /></>);
const PasteIcon = glyph(<><rect x="6" y="5" width="12" height="15" rx="1" /><path d="M9.5 5V3.8a.8.8 0 0 1 .8-.8h3.4a.8.8 0 0 1 .8.8V5" /></>);
// 2D→3D. Planes: two sheets at an angle, the way a CAD tree draws its reference
// planes. Extrude: a profile with the solid pushed off it.
const PlanesIcon = glyph(<><path d="M3 8.5l8-3.5 10 3-8 3.5z" fill={INK.sketchSoft} stroke={INK.sketch} /><path d="M3 8.5v7l8 3.5v-7" stroke={INK.sketch} /><path d="M21 8v7l-10 4" stroke={INK.sketch} opacity="0.55" /></>);
const ExtrudeIcon = glyph(<><path d="M4 12l8 4 8-4v5l-8 4-8-4z" fill={INK.body} /><path d="M4 12l8-4 8 4-8 4z" fill={INK.bodyTop} /><path d="M12 16v5" /><path d="M12 1.5v8M8.8 4.7L12 1.5l3.2 3.2" stroke={INK.go} strokeWidth="2.4" /></>);
// Sketch on Face: a block with its top face picked. Normal To: a plane seen square,
// with the line of sight running into it.
const SketchOnFaceIcon = glyph(<><path d="M4 9l8-4 8 4-8 4z" fill={INK.sketchSoft} stroke={INK.sketch} strokeWidth="2.2" /><path d="M4 9v7l8 4 8-4V9z" fill={INK.body} /><path d="M4 9l8 4 8-4M12 13v7" /></>);
const NormalToIcon = glyph(<><rect x="5" y="5" width="14" height="14" fill={INK.sketchSoft} stroke={INK.sketch} /><path d="M12 12v-9M9.5 5.5L12 3l2.5 2.5" stroke={INK.go} strokeWidth="2.2" /><circle cx="12" cy="12" r="1.8" fill="currentColor" /></>);

const TOOLS = [
  { value: 'select', label: 'Select', Icon: SelectIcon, hint: 'Click to select · drag empty space for a box (left→right encloses, right→left also grabs what it touches) · drag a point to move it · double-click a dimension to edit it' },
  { value: 'point', label: 'Point', Icon: PointIcon, hint: 'Click on the plane to add points · snaps to vertices, curve rims, line midpoints, circle quadrants (the axis high points) and where two curves cross' },
  { value: 'line', label: 'Line', Icon: LineIcon, hint: 'Click to start, click to finish · locks to 0/45/90…° and to parallel / perpendicular of an existing line (adds the relation) · snaps tangent, to midpoints, quadrants and intersections · Esc cancels' },
  { value: 'rectangle', label: 'Rectangle', Icon: RectIcon, hint: 'Click two opposite corners' },
  { value: 'centerRect', label: 'Center Rectangle', Icon: CenterRectIcon, hint: 'Click the centre, then a corner · the centre stays the centre when it is dimensioned' },
  { value: 'slot', label: 'Slot', Icon: SlotIcon, hint: 'Click the two ends of the slot axis, then a point setting the radius · the flanks stay tangent to the caps' },
  { value: 'polygon', label: 'Polygon', Icon: PolygonIcon, hint: 'Click the centre, then a corner (sets size and rotation) · pick the number of sides on the rail' },
  { value: 'circle', label: 'Circle', Icon: CircleIcon, hint: 'Click centre, then a point on the rim' },
  { value: 'arc', label: 'Arc', Icon: ArcIcon, hint: 'Click centre, start, then end (sweeps CCW) · Esc cancels' },
  { value: 'arc3', label: '3-Point Arc', Icon: Arc3Icon, hint: 'Click the two ends, then a point the arc passes through' },
  { value: 'tangentArc', label: 'Tangent Arc', Icon: TangentArcIcon, hint: 'Click the end of a line or arc, then where the arc should end · it leaves tangent and stays tangent' },
  { value: 'dimension', label: 'Dimension', Icon: DimIcon, hint: 'Pick 1 pt (to origin) / 2 pts / 1 line / 1 circle / 1 arc / pt+line / 2 lines (gap or angle) / line+circle / 2 circles, or an edge or corner of the part — set value, or click empty space to apply' },
  { value: 'trim', label: 'Trim', Icon: TrimIcon, hint: 'Click a line, circle or arc to trim it at its intersections' },
  { value: 'extend', label: 'Extend', Icon: ExtendIcon, hint: 'Click a line near the end to run it on to the next line, circle or arc it meets' },
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
    removeConstraintAt, resolveDimension, toggleDriven,
    dimensionAxis, setDimensionAxis,
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
      {dimSpec?.axial && (
        <div style={{ marginTop: 6 }}>
          <Tooltip title="Set by where you placed the dimension (below → dX, to the side → dY, square off the line → aligned). Change it here to override.">
            <Segmented
              size="small"
              value={dimensionAxis}
              onChange={setDimensionAxis}
              options={[
                { label: '⤢ aligned', value: 'aligned' },
                { label: '↔ dX', value: 'x' },
                { label: '↕ dY', value: 'y' },
              ]}
            />
          </Tooltip>
        </div>
      )}

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

      <Text type="secondary" style={{ fontSize: 12 }}>Constraints ({sk.constraints.length})</Text>
      <div style={{ maxHeight: 160, overflow: 'auto', marginTop: 4 }}>
        {sk.constraints.map((c, i) => (
          <Space key={i} size={4} style={{ width: '100%', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 11, color: c.driven ? CAD.skDriven : CAD.muted }}>
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
                    style={{ fontSize: 11, lineHeight: 1, padding: '0 4px', color: c.driven ? CAD.skDriven : CAD.muted }}
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

// `InputNumber`'s `addonAfter` is deprecated in this antd version in favour of
// `Space.Compact` — this is that replacement: the input plus a plain span
// styled to match antd's own addon look, reused everywhere a value needs a
// unit suffix (dimension entry, chamfer/fillet, offset).
function UnitInput({
  value, onChange, onPressEnter, unit, width = 96, autoFocus,
}) {
  return (
    <Space.Compact>
      <InputNumber
        controls={false}
        autoFocus={autoFocus}
        size="small"
        value={value}
        onChange={onChange}
        onPressEnter={onPressEnter}
        style={{ width }}
      />
      <span style={{
        display: 'inline-flex', alignItems: 'center', padding: '0 8px',
        border: `1px solid ${CAD.border}`, borderLeft: 'none',
        borderRadius: '0 4px 4px 0', background: CAD.glass, color: CAD.muted,
        fontSize: 12, whiteSpace: 'nowrap',
      }}
      >
        {unit}
      </span>
    </Space.Compact>
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
  const dimensionAxis = useSketchStore((s) => s.dimensionAxis);
  const setDimensionAxis = useSketchStore((s) => s.setDimensionAxis);
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
        background: CAD.glassSolid, border: `1px solid ${CAD.accent}`,
        padding: '6px 10px', borderRadius: 4, boxShadow: FLOAT_SHADOW,
      }}
    >
      <Text style={{ color: CAD.icon, fontSize: 12 }}>{dimensionPending.label}</Text>
      {angular && (
        <>
          <Text style={{ color: CAD.skAxis, fontSize: 11 }}>base L{dimensionPending.refs[0]}</Text>
          <Text style={{ color: CAD.muted, fontSize: 11 }}>→</Text>
          <Text style={{ color: CAD.skPreview, fontSize: 11 }}>rotate L{dimensionPending.refs[1]}</Text>
          <Tooltip title="Swap base / rotating line">
            <Button size="small" onClick={swapDimensionRefs} style={{ padding: '0 6px' }}>⇄</Button>
          </Tooltip>
        </>
      )}
      {dimensionPending.axial && (
        <Tooltip title="Measure the true distance, the horizontal gap (dX), or the vertical gap (dY)">
          <Segmented
            size="small"
            value={dimensionAxis}
            onChange={setDimensionAxis}
            options={[
              { label: '⤢', value: 'aligned' },
              { label: '↔', value: 'x' },
              { label: '↕', value: 'y' },
            ]}
          />
        </Tooltip>
      )}
      <UnitInput
        autoFocus
        value={val}
        onChange={(v) => setVal(v ?? 0)}
        onPressEnter={apply}
        unit={dimensionPending.unit ?? 'mm'}
      />
      <Button size="small" type="primary" onClick={apply}>Set</Button>
      <Button size="small" type="text" style={{ color: CAD.label }} onClick={cancelDimension}>✕</Button>
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
        background: CAD.glassSolid, border: `1px solid ${CAD.feed}`,
        padding: '6px 10px', borderRadius: 4, boxShadow: FLOAT_SHADOW,
      }}
    >
      <Text style={{ color: CAD.icon, fontSize: 12 }}>Edit {editingConstraint.label}</Text>
      <UnitInput
        autoFocus
        value={val}
        onChange={(v) => setVal(v ?? 0)}
        onPressEnter={apply}
        unit={editingConstraint.angular ? '°' : 'mm'}
      />
      <Button size="small" type="primary" onClick={apply}>Set</Button>
      <Button size="small" type="text" style={{ color: CAD.label }} onClick={cancelEditConstraint}>✕</Button>
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
  const circleIds = selection.filter((id) => sk.entities.get(id)?.type === 'circle');
  const twoLines = selection.length === 2 && lineIds.length === 2;
  const withArc = selection.length === 2 && arcIds.length >= 1 && lineIds.length + arcIds.length === 2;
  // A whole circle is a closed curve — there is no corner on it to round. Rather
  // than render nothing (which just looks like the tool is broken), explain it.
  // Two whole circles that cross are filleted directly — the fillet auto-trims
  // them into arcs (SolidWorks behaviour). A circle paired with a line or arc
  // still has to be trimmed by hand, so that case just explains itself.
  const twoCircles = selection.length === 2 && circleIds.length === 2;
  const loneCircle = selection.length === 2 && circleIds.length === 1;
  if (tool !== 'chamfer' || (!twoLines && !withArc && !twoCircles && !loneCircle)) return null;
  if (loneCircle) {
    return (
      <div
        style={{
          position: 'absolute', top: 60, left: 12, zIndex: 6,
          display: 'flex', gap: 8, alignItems: 'center', maxWidth: 420,
          background: CAD.glassSolid, border: `1px solid ${CAD.skPreview}`,
          padding: '6px 10px', borderRadius: 4, boxShadow: FLOAT_SHADOW,
        }}
      >
        <Text style={{ color: CAD.skHover, fontSize: 12 }}>Fillet</Text>
        <Text style={{ color: CAD.icon, fontSize: 12 }}>
          A whole circle has no corner to round against a line or arc — Trim it to an arc first, then apply R.
        </Text>
      </div>
    );
  }
  // A curve pairing forces fillet (R); two lines respect the C/R toggle.
  const rounded = withArc || twoCircles || chamferKind === 'R';
  const apply = () => {
    if (!(Number.isFinite(val) && val > 0)) return;
    rounded ? fillet(val) : chamfer(val);
  };

  return (
    <div
      style={{
        position: 'absolute', top: 60, left: 12, zIndex: 6,
        display: 'flex', gap: 6, alignItems: 'center',
        background: CAD.glassSolid, border: `1px solid ${CAD.skPreview}`,
        padding: '6px 10px', borderRadius: 4, boxShadow: FLOAT_SHADOW,
      }}
    >
      <Text style={{ color: CAD.icon, fontSize: 12 }}>{rounded ? 'Fillet' : 'Chamfer'}</Text>
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
      <UnitInput
        autoFocus
        value={val}
        onChange={(v) => setVal(v ?? 0)}
        onPressEnter={apply}
        unit={rounded ? 'R mm' : 'mm'}
      />
      <Button size="small" type="primary" onClick={apply}>Set</Button>
    </div>
  );
}

/**
 * Inline distance entry for the Offset tool — the rail button arms it
 * (`offsetPending`) and this asks for the distance, matching how Chamfer and
 * Dimension take their values. Negative flips the side.
 */
const geomCount = (s) => s.selection.filter((id) => {
  const t = s.sk.entities.get(id)?.type;
  return t === 'line' || t === 'circle' || t === 'arc';
}).length;

/** How many entities the open panel will act on, or the prompt to pick some. */
function PickPrompt({ count, empty = 'Click the geometry in the sketch' }) {
  return (
    <Text style={{ color: count ? CAD.dim : CAD.skOver, fontSize: 11, whiteSpace: 'nowrap' }}>
      {count ? `${count} selected` : empty}
    </Text>
  );
}

const MIRROR_AXES = [['x', 'X axis'], ['y', 'Y axis'], ['line', 'Centerline / Line']];

/** Mirror: pick what to mirror and say what about, with the panel open. */
function MirrorInput() {
  const mirrorPending = useSketchStore((s) => s.mirrorPending);
  const mirror = useSketchStore((s) => s.mirror);
  const cancelMirror = useSketchStore((s) => s.cancelMirror);
  const about = useSketchStore((s) => s.mirrorAbout);
  const setAbout = useSketchStore((s) => s.setMirrorAbout);
  const selected = useSketchStore((s) => s.selection.length);
  const axis = useSketchStore((s) => s.mirrorAxis());
  const axisPicked = useSketchStore((s) => s.selection.includes(s.mirrorAxis()));

  if (!mirrorPending) return null;
  const count = axisPicked ? selected - 1 : selected;
  const ready = axis != null && count >= 1;
  let prompt = `${count} to mirror`;
  if (axis == null) prompt = about === 'line' ? 'Click the centerline or line to mirror about' : 'Choose what to mirror about';
  else if (!ready) prompt = 'Click what to mirror';

  return (
    <div
      onKeyDown={(e) => { if (e.key === 'Escape') cancelMirror(); }}
      style={{
        position: 'absolute', top: 60, left: 12, zIndex: 6,
        display: 'flex', gap: 6, alignItems: 'center',
        background: CAD.glassSolid, border: `1px solid ${CAD.skTangent}`,
        padding: '6px 10px', borderRadius: 4, boxShadow: FLOAT_SHADOW,
      }}
      data-mirror-panel
    >
      <Text style={{ color: CAD.icon, fontSize: 12 }}>Mirror about</Text>
      {MIRROR_AXES.map(([value, label]) => (
        <Button key={value} size="small" type={about === value ? 'primary' : 'default'} onClick={() => setAbout(value)}>{label}</Button>
      ))}
      <Text style={{ color: ready ? CAD.dim : CAD.skOver, fontSize: 11, whiteSpace: 'nowrap' }}>{prompt}</Text>
      <Button size="small" type="primary" disabled={!ready} onClick={() => mirror()}>Set</Button>
      <Button size="small" type="text" style={{ color: CAD.label }} onClick={cancelMirror}>✕</Button>
    </div>
  );
}

function OffsetInput() {
  const picked = useSketchStore(geomCount);
  const offsetPending = useSketchStore((s) => s.offsetPending);
  const offset = useSketchStore((s) => s.offset);
  const cancelOffset = useSketchStore((s) => s.cancelOffset);
  const [val, setVal] = useState(5);

  if (!offsetPending) return null;
  const apply = () => { if (picked && Number.isFinite(val) && val !== 0) offset(val); };

  return (
    <div
      onKeyDown={(e) => { if (e.key === 'Escape') cancelOffset(); }}
      style={{
        position: 'absolute', top: 60, left: 12, zIndex: 6,
        display: 'flex', gap: 6, alignItems: 'center',
        background: CAD.glassSolid, border: `1px solid ${CAD.skTangent}`,
        padding: '6px 10px', borderRadius: 4, boxShadow: FLOAT_SHADOW,
      }}
    >
      <Text style={{ color: CAD.icon, fontSize: 12 }}>Offset</Text>
      <PickPrompt count={picked} />
      <UnitInput
        autoFocus
        value={val}
        onChange={(v) => setVal(v ?? 0)}
        onPressEnter={apply}
        unit="mm"
      />
      <Button size="small" type="primary" disabled={!picked} onClick={apply}>Set</Button>
      <Button size="small" type="text" style={{ color: CAD.label }} onClick={cancelOffset}>✕</Button>
    </div>
  );
}

/**
 * Inline entry for Linear Pattern — the rail button arms it (`linearPatternPending`),
 * matching how Offset takes its distance. How many along X and Y, counting the
 * original, and the distance between neighbours each way.
 */
function LinearPatternInput() {
  const picked = useSketchStore((s) => patternSeeds(s.sk, s.selection).length);
  const linearPatternPending = useSketchStore((s) => s.linearPatternPending);
  const linearPattern = useSketchStore((s) => s.linearPattern);
  const cancelLinearPattern = useSketchStore((s) => s.cancelLinearPattern);
  const [nx, setNx] = useState(3);
  const [dx, setDx] = useState(10);
  const [ny, setNy] = useState(1);
  const [dy, setDy] = useState(10);

  if (!linearPatternPending) return null;
  const apply = () => { if (picked) linearPattern(nx, dx ?? 0, ny, dy ?? 0); };

  return (
    <div
      onKeyDown={(e) => { if (e.key === 'Escape') cancelLinearPattern(); }}
      style={{
        position: 'absolute', top: 60, left: 12, zIndex: 6,
        display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', maxWidth: 'calc(100% - 24px)',
        background: CAD.glassSolid, border: `1px solid ${CAD.skTangent}`,
        padding: '6px 10px', borderRadius: 4, boxShadow: FLOAT_SHADOW,
      }}
      data-linear-panel
    >
      <Text style={{ color: CAD.icon, fontSize: 12 }}>Linear Pattern</Text>
      <PickPrompt count={picked} empty="Click the points or geometry to repeat" />
      <UnitInput autoFocus value={nx} onChange={(v) => setNx(v ?? 1)} onPressEnter={apply} unit="X count" width={50} />
      <UnitInput value={dx} onChange={(v) => setDx(v ?? 0)} onPressEnter={apply} unit="dX mm" width={70} />
      <UnitInput value={ny} onChange={(v) => setNy(v ?? 1)} onPressEnter={apply} unit="Y count" width={50} />
      <UnitInput value={dy} onChange={(v) => setDy(v ?? 0)} onPressEnter={apply} unit="dY mm" width={70} />
      <Button size="small" type="primary" disabled={!picked} onClick={apply}>Set</Button>
      <Button size="small" type="text" style={{ color: CAD.label }} onClick={cancelLinearPattern}>✕</Button>
    </div>
  );
}

const PATTERN_CENTRES = [['origin', 'Origin'], ['point', 'Point']];
const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Inline entry for Circular Pattern: the first pick is where it starts and stays
 * put; how many, on what PCD, and that pick's angle on the circle. PCD and start
 * read from the centre chosen, until edited; editing them places the centre.
 */
function CircularPatternInput() {
  const picked = useSketchStore((s) => s.circularSeeds().length);
  const circularPatternPending = useSketchStore((s) => s.circularPatternPending);
  const circularPattern = useSketchStore((s) => s.circularPattern);
  const cancelCircularPattern = useSketchStore((s) => s.cancelCircularPattern);
  const about = useSketchStore((s) => s.circularAbout);
  const setAbout = useSketchStore((s) => s.setCircularAbout);
  const hasCentre = useSketchStore((s) => s.circularCenter() != null);
  const seedKey = useSketchStore((s) => `${s.version}|${s.selection.join()}|${s.circularAbout}|${s.circularCenterId}`);
  const [count, setCount] = useState(6);
  const [angle, setAngle] = useState(360);
  const [pcd, setPcd] = useState(null);
  const [start, setStart] = useState(null);
  useEffect(() => { setPcd(null); setStart(null); }, [seedKey]);

  if (!circularPatternPending) return null;
  const polar = useSketchStore.getState().circularPolar();
  const ready = picked > 0 && hasCentre && Number.isFinite(angle) && angle !== 0;
  const apply = () => { if (ready && Number.isFinite(count)) circularPattern(count, angle, { pcd, startDeg: start }); };
  return (
    <div
      onKeyDown={(e) => { if (e.key === 'Escape') cancelCircularPattern(); }}
      style={{
        position: 'absolute', top: 60, left: 12, zIndex: 6,
        display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', maxWidth: 'calc(100% - 24px)',
        background: CAD.glassSolid, border: `1px solid ${CAD.skTangent}`,
        padding: '6px 10px', borderRadius: 4, boxShadow: FLOAT_SHADOW,
      }}
      data-circular-panel
    >
      <Text style={{ color: CAD.icon, fontSize: 12 }}>Circular Pattern about</Text>
      {PATTERN_CENTRES.map(([value, label]) => (
        <Button key={value} size="small" type={about === value ? 'primary' : 'default'} onClick={() => setAbout(value)}>{label}</Button>
      ))}
      <PickPrompt
        count={hasCentre ? picked : 0}
        empty={hasCentre ? 'Click the first point' : 'Click the centre point'}
      />
      <UnitInput autoFocus value={count} onChange={(v) => setCount(v ?? 2)} onPressEnter={apply} unit="count" width={50} />
      <UnitInput value={pcd ?? (polar ? round3(polar.pcd) : null)} onChange={setPcd} onPressEnter={apply} unit="PCD mm" width={80} />
      <UnitInput value={start ?? (polar ? round3(polar.startDeg) : null)} onChange={setStart} onPressEnter={apply} unit="° start" width={70} />
      <UnitInput value={angle} onChange={(v) => setAngle(v ?? 0)} onPressEnter={apply} unit="° sweep" width={70} />
      <Button size="small" type="primary" disabled={!ready} onClick={apply}>Set</Button>
      <Button size="small" type="text" style={{ color: CAD.label }} onClick={cancelCircularPattern}>✕</Button>
    </div>
  );
}

/**
 * The sketcher's command rail, and the overlays it drives (dimension and chamfer
 * inputs, which float over the viewport).
 *
 * `ribbonSlot` is a DOM node under the title bar. When given, the rail is drawn
 * there as a docked **Ribbon** with a label under every button, via a portal — so
 * it leaves the viewport clear, while still being part of this component's React
 * tree (state, popovers and events all keep working) and the input overlays below
 * stay where they were, over the viewport they belong to. Without a slot (the
 * component on its own, as the tests mount it) the rail floats as it always did.
 */
export default function SketchToolbar({ ribbonSlot = null }) {
  const docked = !!ribbonSlot;
  const tool = useSketchStore((s) => s.tool);
  const selection = useSketchStore((s) => s.selection);
  const selectedDims = useSketchStore((s) => s.selectedDims);
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
  const sk = useSketchStore((s) => s.sk);
  const toggleConstruction = useSketchStore((s) => s.toggleConstruction);
  const beginMirror = useSketchStore((s) => s.beginMirror);
  const beginOffset = useSketchStore((s) => s.beginOffset);
  const beginLinearPattern = useSketchStore((s) => s.beginLinearPattern);
  const beginCircularPattern = useSketchStore((s) => s.beginCircularPattern);
  const copySelection = useSketchStore((s) => s.copySelection);
  const paste = useSketchStore((s) => s.paste);
  const clipboard = useSketchStore((s) => s.clipboard);
  const polygonSides = useSketchStore((s) => s.polygonSides);
  const facePick = useSketchStore((s) => s.facePick);
  const sketchOpen = useSketchStore((s) => s.sketchOpen);
  const startSketch = useFeatureStore((s) => s.startSketch);
  const setFacePick = useSketchStore((s) => s.setFacePick);
  const convertPick = useSketchStore((s) => s.convertPick);
  const setConvertPick = useSketchStore((s) => s.setConvertPick);
  const activePlane = useSketchStore((s) => (s.sketches.find((x) => x.id === s.activeId) ?? s.sketches[0])?.plane);
  const hasPart = useCamPlanStore((s) => Boolean(s.analysis));
  const normalTo = useCamStore((s) => s.normalTo);
  const setPolygonSides = useSketchStore((s) => s.setPolygonSides);

  // Ctrl+8: Normal To the sketch, SolidWorks' key for it.
  useEffect(() => {
    if (!sketchOpen || !activePlane) return undefined;
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.code !== 'Digit8') return;
      e.preventDefault();
      const { n, v } = planeBasis(activePlane);
      normalTo(n, v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sketchOpen, activePlane, normalTo]);

  const activeHint = TOOLS.find((t) => t.value === tool)?.hint;
  // Enablement for the sketch-modify tools, from the current selection.
  const selectedTypes = selection.map((id) => sk.entities.get(id)?.type);
  const geomSelected = selectedTypes.some((t) => t === 'line' || t === 'circle' || t === 'arc');

  // Each `RibbonButton` opts back into pointer events itself, after the floating
  // rail container below turns them off — see that div's comment for why.
  // Vertical hairline separating groups in the horizontal rail.
  const sep = docked
    ? <div style={{ width: 1, alignSelf: 'stretch', background: CAD.border, margin: '4px 4px' }} />
    : <div style={{ width: 1, height: 24, background: CAD.border, margin: '0 2px' }} />;

  // Docked, the rail is the Ribbon: it takes the full width under the title bar,
  // sits in the page flow (so it no longer needs to be a `data-cam-overlay` — it
  // covers none of the viewport), and shows labels.
  const DOCKED_OVERRIDES = {
    position: 'static',
    top: 'auto',
    left: 'auto',
    zIndex: 'auto',
    maxWidth: 'none',
    gap: 2,
    alignItems: 'stretch',
    padding: '4px 12px',
    background: CAD.panelBg,
    border: 'none',
    borderBottom: `1px solid ${CAD.border}`,
    borderRadius: 0,
    boxShadow: 'none',
    pointerEvents: 'auto',
  };

  const railProps = {
    ...(docked ? { 'data-sketch-ribbon': true } : { 'data-cam-overlay': 'top' }),
    style: {
      position: 'absolute', top: 12, left: 12, zIndex: 5,
      display: 'flex', flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap',
      background: CAD.glass, border: `1px solid ${CAD.border}`,
      padding: 6, borderRadius: 4, boxShadow: FLOAT_SHADOW,
      maxWidth: 'calc(100% - 24px)',
      // The rail sits over the top-left of the viewport, on top of the 3D
      // canvas underneath it (they overlap, this one on top). A solid
      // `pointer-events: auto` here (the default) swallows every pointer
      // event anywhere inside this box — the padding and the gaps between
      // buttons included, since the DOM hit-test only sees this div's
      // background there, not the canvas behind it. A line dragged toward
      // this corner would hit that box before reaching where the operator was
      // actually aiming, and stop dead at whatever edge of it the cursor last
      // crossed — which reads as "my second point jumped to some other spot
      // near the toolbar" and was mistaken for the angle-guide misbehaving in
      // several rounds of bug reports before this was found. `none` here lets
      // pointer events fall through the empty parts of the rail to the
      // viewport below; each button opts back in with its own
      // `pointerEvents: 'auto'` (`RibbonButton` does it for the plain ones).
      pointerEvents: 'none',
      ...(docked ? DOCKED_OVERRIDES : {}),
    },
  };

  const sketchesPanel = (
    <SketchesPanel
      trigger={(
        <Tooltip title="Sketches — which one you are drawing, and the plane it sits on" placement="bottom">
          <RibbonButton icon={<PlanesIcon />} label="Sketches" />
        </Tooltip>
      )}
    />
  );

  // No sketch open: nothing to draw on, so the rail offers what starts one.
  const closedRail = (
    <div {...railProps}>
      <Text style={{ alignSelf: 'center', padding: '0 8px', color: CAD.label, fontSize: 12 }}>
        Pick a plane or a face to start a sketch
      </Text>
      {Object.entries(PLANE_PRESETS).map(([preset, p]) => (
        <RibbonButton
          key={preset}
          icon={<PlanesIcon />}
          label={p.label}
          onClick={() => startSketch({ preset, offset: 0 })}
          data-sketch-start={preset}
        />
      ))}
      {sep}
      {sketchesPanel}
      {error && <Text style={{ alignSelf: 'center', padding: '0 8px', color: CAD.skOver, fontSize: 12 }}>{error}</Text>}
    </div>
  );

  const rail = !sketchOpen ? closedRail : (
    <div {...railProps}>
      {TOOLS.map((t) => (
        <Tooltip key={t.value} title={`${t.label} — ${t.hint}`} placement="bottom">
          <RibbonButton
            active={tool === t.value}
            icon={<t.Icon />}
            label={t.label}
            onClick={() => setTool(t.value)}
          />
        </Tooltip>
      ))}

      {/* The polygon's side count, beside the tool rather than in a popover: it
          is picked before the two clicks, not after, so it has to be reachable
          without covering the viewport being clicked on. */}
      {tool === 'polygon' && (
        <Tooltip title="Sides — set before drawing; the polygon is inscribed in the circle through the corner you click" placement="bottom">
          <InputNumber
            size="small"
            min={3}
            max={64}
            value={polygonSides}
            onChange={(v) => setPolygonSides(v)}
            style={{ width: 62, pointerEvents: 'auto' }}
            data-polygon-sides
          />
        </Tooltip>
      )}

      {sep}

      {/* Sketch-modify tools. SolidWorks puts these on the Sketch tab next to the
          drawing tools — they change geometry, unlike the relations in the
          popover — so they sit on the rail, acting on the current selection. */}
      <Tooltip title="Construction — toggle the selected lines/circles/arcs to reference geometry (dashed; excluded from the profile)" placement="bottom">
        <RibbonButton
          icon={<ConstructionIcon />}
          label="Construction"
          disabled={!geomSelected}
          onClick={() => toggleConstruction()}
        />
      </Tooltip>
      <Tooltip title="Mirror — reflect entities about a line: press, click what to mirror, then the line" placement="bottom">
        <RibbonButton
          icon={<MirrorIcon />}
          label="Mirror"
          onClick={() => beginMirror()}
        />
      </Tooltip>
      <Tooltip title="Offset — copy the selected lines/circles/arcs a set distance away (negative flips the side)" placement="bottom">
        <RibbonButton
          icon={<OffsetIcon />}
          label="Offset"
          onClick={() => beginOffset()}
        />
      </Tooltip>
      <Tooltip title="Linear Pattern — stamp copies of the selection in a straight line" placement="bottom">
        <RibbonButton
          icon={<LinearPatternIcon />}
          label="Linear Pattern"
          onClick={() => beginLinearPattern()}
        />
      </Tooltip>
      <Tooltip title="Circular Pattern — stamp copies of the selection around a centre, on a PCD" placement="bottom">
        <RibbonButton
          icon={<CircularPatternIcon />}
          label="Circular Pattern"
          onClick={() => beginCircularPattern()}
        />
      </Tooltip>
      <Tooltip title="Copy (Ctrl+C) — capture the selection to the sketch clipboard" placement="bottom">
        <RibbonButton
          icon={<CopyIcon />}
          label="Copy"
          disabled={!selection.length}
          onClick={() => copySelection()}
        />
      </Tooltip>
      <Tooltip title="Paste (Ctrl+V) — drop the last copy into this sketch, stepped out from where it was copied" placement="bottom">
        <RibbonButton
          icon={<PasteIcon />}
          label="Paste"
          disabled={!clipboard}
          onClick={() => paste()}
        />
      </Tooltip>
      <Tooltip
        title={hasPart
          ? (convertPick ? 'Click an edge of the part, or a face for its whole outline · Esc to finish' : 'Convert Entities — copy edges of the part into this sketch')
          : 'Build or import a part first'}
        placement="bottom"
      >
        <RibbonButton
          icon={<ConvertIcon />}
          label="Convert Entities"
          active={convertPick}
          disabled={!hasPart}
          onClick={() => setConvertPick(!convertPick)}
        />
      </Tooltip>

      {sep}

      <Popover
        trigger="click"
        placement="bottomLeft"
        title="Relations & dimensions"
        content={<ConstraintsPanel />}
      >
        <Tooltip title="Relations & dimensions" placement="bottom">
          <RibbonButton icon={<NodeIndexOutlined />} label="Relations" />
        </Tooltip>
      </Popover>

      <Tooltip title="Solve (apply constraints)" placement="bottom">
        <RibbonButton icon={<ThunderboltOutlined />} label="Solve" accent onClick={() => solve()} />
      </Tooltip>
      <Tooltip title="Undo (Ctrl+Z)" placement="bottom">
        <RibbonButton icon={<UndoOutlined />} label="Undo" disabled={!past.length} onClick={() => undo()} />
      </Tooltip>
      <Tooltip title="Redo (Ctrl+Y)" placement="bottom">
        <RibbonButton icon={<RedoOutlined />} label="Redo" disabled={!future.length} onClick={() => redo()} />
      </Tooltip>
      <Tooltip title="Delete selection (Del) — geometry or a selected dimension" placement="bottom">
        <RibbonButton danger icon={<DeleteOutlined />} label="Delete" disabled={!selection.length && !selectedDims.length} onClick={() => deleteSelected()} />
      </Tooltip>

      {sep}

      {/* The 2D→3D pair. Which sketch and which plane comes first because it is
          what the drawing lands on; Build is next to it because it is what the
          drawing is for. Saving and opening projects, DXF and the library are in
          the File menu, and Clear sketch is in Edit. */}
      {sketchesPanel}
      <Tooltip
        title={hasPart
          ? (facePick ? 'Click a face of the part to sketch on it · Esc cancels' : 'Sketch on a face of the part: press, then click the face')
          : 'Build or import a part first'}
        placement="bottom"
      >
        <RibbonButton
          icon={<SketchOnFaceIcon />}
          label="Sketch on Face"
          active={facePick}
          disabled={!hasPart}
          onClick={() => setFacePick(!facePick)}
        />
      </Tooltip>
      <Tooltip title="Normal To — look straight at this sketch's plane · press again to look from the other side" placement="bottom">
        <RibbonButton
          icon={<NormalToIcon />}
          label="Normal To"
          onClick={() => {
            const { n, v } = planeBasis(activePlane);
            normalTo(n, v);
          }}
        />
      </Tooltip>
      <BuildPanel
        trigger={(
          <Tooltip title="Build — extrude or revolve this sketch into a solid and send it to CAM" placement="bottom">
            <RibbonButton icon={<ExtrudeIcon />} label="Build" accent />
          </Tooltip>
        )}
      />

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
              style={{
                margin: 0, minWidth: 28, textAlign: 'center', fontSize: 10, padding: '0 4px',
                pointerEvents: 'auto',
              }}
            >
              {dofState.state === 'full' ? '✓' : dofState.free}
            </Tag>
          </Tooltip>
        )}
        {solveResult && !solveResult.success && (
          <Tooltip title={`solve status ${solveResult.status}`} placement="bottom">
            <Tag color="red" style={{ margin: 0, minWidth: 20, textAlign: 'center', fontSize: 10, padding: '0 4px', pointerEvents: 'auto' }}>!</Tag>
          </Tooltip>
        )}
        {error && (
          <Tooltip title={error} placement="bottom">
            <Tag color="orange" style={{ margin: 0, minWidth: 20, textAlign: 'center', fontSize: 10, padding: '0 4px', pointerEvents: 'auto' }}>?</Tag>
          </Tooltip>
        )}
      </Space>
    </div>
  );

  return (
    <>
    {ribbonSlot ? createPortal(rail, ribbonSlot) : rail}
    <DimensionInput />
    <EditDimensionInput />
    <ChamferInput />
    <OffsetInput />
    <MirrorInput />
    <LinearPatternInput />
    <CircularPatternInput />
    </>
  );
}
