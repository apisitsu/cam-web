/**
 * App — CAM Web shell: G-code editor/loader + backplot & sim viewport + playback.
 *
 * Thin Presentation layer (per cam_web.txt): all parsing/carving lives in the
 * workers/engine, all state in camStore. Playback scrubs the ordered path and
 * (optionally) drives progressive material removal.
 */
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  Layout, Button, Statistic, Alert, Space, Typography, theme,
  InputNumber, Segmented, Switch, Divider, Slider, Upload, Tag, Tooltip,
} from 'antd';
import {
  ThunderboltOutlined, BulbOutlined,
  PlayCircleFilled, PauseCircleFilled, UploadOutlined, StepBackwardOutlined,
  StepForwardOutlined, FastBackwardOutlined, RollbackOutlined,
  ExpandOutlined, DownloadOutlined,
  PlusOutlined, ColumnWidthOutlined, DatabaseOutlined,
} from '@ant-design/icons';
import CommandButton from './components/CommandButton.jsx';
import {
  PartIcon, StockCutIcon, VoxelIcon, TurningIcon, ArborIcon, RotateWorkIcon,
  CUTTER_ICONS,
} from './components/glyph.jsx';
import {
  CUTTERS, cutterById, cutterWarning, defaultThickness, defaultShank,
} from './engine/cam/cutters.js';
import { effectiveTool } from './engine/cam/effectiveTool.js';
import { useCamStore } from './stores/camStore.js';
import { useCamPlanStore } from './stores/camPlanStore.js';
import { PART_FORMATS } from './engine/mesh/import.js';
import CamPanel from './components/CamPanel.jsx';
import { useSketchStore } from './stores/sketchStore.js';
import { exportGcode, openProjectFile } from './lib/projectIO.js';
import LibraryPanel from './components/LibraryPanel.jsx';
import { useLibraryStore } from './stores/libraryStore.js';
import { fitBoundsFor, fitBoundsForPart, chuckFromBounds } from './engine/view/setup.js';
import { unionBounds } from './engine/view/camera.js';
import { simMethodFor } from './engine/sim/method.js';
import { SPEEDS, PLAY_BASE_SECONDS, perTick } from './engine/view/playback.js';
import { sidebarSections } from './engine/view/sidebar.js';
import { autoSimKey, shouldAutoSimulate } from './engine/view/autoSim.js';
import { offerArborToggle, parkedTip } from './engine/view/millTool.js';
import { sweptFitBox } from './engine/view/rotaryFrame.js';
import { sketchBounds } from './engine/sketch/edit.js';
import {
  lineAt, timeAt, rotaryAt, toolAt, segmentAtTime, toolPointAt, blockTargetAt,
  runningAt,
} from './engine/gcode/path.js';
import { STANDARD_TURN_TOOLS } from './engine/sim/turning.js';
import {
  billetBox, billetWarnings, billetExtents, previewSolid, suggestBillet,
} from './engine/sim/billet.js';
import { SAMPLE_GCODE, SAMPLE_TURNING } from './SAMPLE_GCODE.js';
import Viewport from './components/Viewport.jsx';
import GcodePanel from './components/GcodePanel.jsx';
import PositionReadout from './components/PositionReadout.jsx';
import SketchToolbar from './components/SketchToolbar.jsx';
import { invalidate } from '@react-three/fiber';
import { getBuf } from './engine/bufferCache.js';

const { Sider, Content, Header } = Layout;
const { Title, Text } = Typography;

const PAGES = [
  { label: 'Milling', value: 'mill' },
  { label: 'Turning', value: 'turn' },
  { label: 'Sketch', value: 'sketch' },
];

/**
 * Isometric view-cube glyphs for the view presets (SolidWorks-style standard
 * views). The cube is drawn from the iso eye (+X, −Y, +Z) so its three visible
 * faces are Top (+Z, upper diamond), Front (−Y, lower-left) and Right (+X,
 * lower-right). Each preset highlights the face you'd be looking down:
 *   - solid accent  → that face is toward you (top / front / right / iso)
 *   - medium accent → the *opposite* (hidden) face, for back / left, which share
 *     a projected rhombus with front / right; the tooltip names the exact view.
 * Pure SVG on `currentColor`, so the glyph inherits the Segmented item's colour
 * (selected vs idle) automatically.
 */
const CUBE_FACES = {
  top: [[12, 3], [20, 7.5], [12, 12], [4, 7.5]],
  front: [[4, 7.5], [12, 12], [12, 21], [4, 16.5]],
  right: [[20, 7.5], [20, 16.5], [12, 21], [12, 12]],
};
function CubeGlyph({ face, whole = false, hollow = false }) {
  const op = (f) => {
    if (whole) return f === 'top' ? 0.42 : f === 'front' ? 0.3 : 0.18;
    if (f !== face) return 0.12;
    return hollow ? 0.45 : 0.95;
  };
  const poly = (f) => (
    <polygon
      points={CUBE_FACES[f].map((p) => p.join(',')).join(' ')}
      fill="currentColor"
      fillOpacity={op(f)}
      stroke="currentColor"
      strokeWidth="1"
      strokeLinejoin="round"
    />
  );
  return (
    <span role="img" className="anticon" style={{ display: 'inline-flex' }}>
      <svg viewBox="0 0 24 24" width="18" height="18" style={{ display: 'block' }}>
        {poly('top')}
        {poly('front')}
        {poly('right')}
      </svg>
    </span>
  );
}
const viewGlyph = (title, glyph) => ({
  title,
  label: <span title={title} style={{ display: 'inline-flex', padding: '1px 2px' }}>{glyph}</span>,
});
const VIEWS = [
  { value: 'iso', ...viewGlyph('Isometric', <CubeGlyph whole />) },
  { value: 'top', ...viewGlyph('Top', <CubeGlyph face="top" />) },
  { value: 'front', ...viewGlyph('Front', <CubeGlyph face="front" />) },
  { value: 'back', ...viewGlyph('Back', <CubeGlyph face="front" hollow />) },
  { value: 'left', ...viewGlyph('Left', <CubeGlyph face="right" hollow />) },
  { value: 'right', ...viewGlyph('Right', <CubeGlyph face="right" />) },
];

/** Seconds → `1:02:03` / `2:03` / `0:03`, the way a control posts cycle time. */
function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Metallic palette for the realistic tool glyphs (fixed colours, like the real
// tool — the active state is shown by the button's highlighted background).
const TG = {
  steel: '#c3ccd8', steelEdge: '#7b8798', steelHi: '#eef2f7',
  gold: '#f4c53d', goldEdge: '#9a6b0f', goldHi: '#fbe7a0',
  screw: '#6b5212',
};

/**
 * A little picture of the actual turning tool for the icon picker (modelled on the
 * catalogue photos in image_tool/): a steel shank holding a **gold rhombic insert**
 * with a round clamp screw. The insert's nose angle is the real ISO shape
 * (V 35° narrow → C 80° → S 90° square), and the holder's hand (`flip`) mirrors it,
 * so MVJNR/MVVNN/DCLNR/SCLCR read as distinct real tools. Boring bars reach in along
 * the bore; the parting tool is a thin blade.
 */
function TurnToolGlyph({ tool }) {
  // A gold ISO insert (rhombus of the given nose angle) with edge + clamp screw.
  const Insert = ({ ox, oy, p = 5.5, angle = tool.angle }) => {
    const q = p * Math.tan((angle * Math.PI) / 180 / 2);
    const d = `M${ox} ${oy - p} L${ox + q} ${oy} L${ox} ${oy + p} L${ox - q} ${oy} Z`;
    return (
      <>
        <path d={d} fill={TG.gold} stroke={TG.goldEdge} strokeWidth="0.8" strokeLinejoin="round" />
        <path d={`M${ox} ${oy - p * 0.6} L${ox + q * 0.55} ${oy}`} stroke={TG.goldHi} strokeWidth="0.7" fill="none" opacity="0.8" />
        <circle cx={ox} cy={oy} r="1.7" fill={TG.screw} />
        <circle cx={ox - 0.4} cy={oy - 0.4} r="0.7" fill={TG.goldHi} />
      </>
    );
  };
  let body;
  if (tool.kind === 'parting') {
    body = (
      <>
        <rect x="13.6" y="10" width="4.8" height="17" rx="1.2" fill={TG.steel} stroke={TG.steelEdge} strokeWidth="0.7" />
        <rect x="14.4" y="10.6" width="1" height="15" fill={TG.steelHi} opacity="0.7" />
        <rect x="12.8" y="5" width="6.4" height="6" rx="1.2" fill={TG.gold} stroke={TG.goldEdge} strokeWidth="0.8" />
        <circle cx="16" cy="8" r="1.5" fill={TG.screw} />
      </>
    );
  } else if (tool.kind === 'boring') {
    body = (
      <>
        <rect x="3" y="14.5" width="21" height="6.4" rx="3.2" fill={TG.steel} stroke={TG.steelEdge} strokeWidth="0.7" />
        <rect x="4" y="15.4" width="17" height="1.1" rx="0.5" fill={TG.steelHi} opacity="0.7" />
        <Insert ox={22} oy={11} p={4.6} />
      </>
    );
  } else {
    // OD holder: steel shank bar to the lower corner, gold insert at the tip. Drawn
    // right-handed; mirror for the other hand so the two 35° tools differ.
    body = (
      <g transform={tool.flip ? undefined : 'translate(32,0) scale(-1,1)'}>
        <path d="M12.5 12 L28 27.5" stroke={TG.steelEdge} strokeWidth="8.4" strokeLinecap="round" />
        <path d="M12.5 12 L28 27.5" stroke={TG.steel} strokeWidth="7" strokeLinecap="round" />
        <path d="M14 12.5 L26.5 25" stroke={TG.steelHi} strokeWidth="1.4" strokeLinecap="round" opacity="0.55" />
        <Insert ox={12} oy={11} p={5.6} />
      </g>
    );
  }
  return (
    <span role="img" className="anticon" style={{ display: 'inline-flex' }}>
      <svg viewBox="0 0 32 32" width="1.7em" height="1.7em" style={{ display: 'block' }}>{body}</svg>
    </span>
  );
}

/**
 * Icon picker for a tool's turning insert/holder — a row of glyph buttons (one per
 * catalogue holder), replacing the old dropdown. The selected holder is
 * highlighted; the full catalogue name is on each button's tooltip.
 */
function TurnInsertPicker({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
      {STANDARD_TURN_TOOLS.map((x) => (
        <Tooltip key={x.id} title={x.label} placement="top">
          <Button
            size="small"
            type={value === x.id ? 'primary' : 'text'}
            icon={<TurnToolGlyph tool={x} />}
            onClick={() => onChange(x.id)}
            style={{ width: 32, height: 32, padding: 0, color: value === x.id ? undefined : '#cbd5e1' }}
          />
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * Pick a cutter TYPE — the six shapes in `engine/cam/cutters.js`.
 *
 * Icon-only, per the toolbar convention: the tooltip names each and says what
 * it is for. Shared by the fallback cutter and by every row of the Tool table,
 * because they are the same question asked about different tools — the table
 * used to ask a narrower one (Flat or Ball), which could not say "face mill"
 * at all, so a Ø50 face mill in the program could only ever be drawn and
 * carved as a Ø50 stick.
 */
function CutterPicker({ value, onChange, box = 32, scope = 'fallback' }) {
  return (
    <Space size={2} wrap>
      {CUTTERS.map((c) => {
        const Icon = CUTTER_ICONS[c.id];
        return (
          <Tooltip
            key={c.id}
            title={(
              <span>
                <b>{c.label}</b>
                <span style={{ display: 'block', opacity: 0.82, fontSize: 12, marginTop: 2 }}>
                  {c.note}
                </span>
              </span>
            )}
          >
            <Button
              size="small"
              aria-label={c.label}
              data-cutter={c.id}
              // Which tool is being typed — the fallback, or a row of the Tool
              // table. Both render the same six glyphs, so a test that asks for
              // "the face mill button" has to say whose.
              data-cutter-scope={scope}
              type={value === c.id ? 'primary' : 'text'}
              icon={<Icon />}
              onClick={() => onChange(c.id)}
              style={{
                width: box, height: box, padding: 0,
                color: value === c.id ? undefined : '#cbd5e1',
              }}
            />
          </Tooltip>
        );
      })}
    </Space>
  );
}

/**
 * The cutter the sim falls back to when the program never named one.
 *
 * Always collapsed to a single `+` until asked for. The first cut at this
 * opened it automatically whenever the program declared no tools — which was
 * exactly the common case, so the `+` was never seen and the row looked as
 * permanent as before. A control that is sometimes a button and sometimes a
 * form is worse than either; this is a button, and pressing it gives the form.
 */
function ToolFallback({
  open, onOpen, detected, diameter, cutter, flutes, angle, thickness, shank,
  onDiameter, onCutter, onFlutes, onAngle, onThickness, onShank, addonStyle,
}) {
  const spec = cutterById(cutter);
  if (!open) {
    return (
      <Space size={6} align="center">
        <CommandButton id="toolFallback" size="small" icon={<PlusOutlined />} onClick={onOpen} />
        <Text style={{ color: '#475569', fontSize: 11 }}>
          {detected > 0
            ? `Cutter from the program (${detected} ${detected === 1 ? 'tool' : 'tools'})`
            : `Cutter — the program names none, using ⌀${diameter} ${spec.label.toLowerCase()}`}
        </Text>
      </Space>
    );
  }
  const [loF, hiF] = spec.fluteRange;
  const advice = cutterWarning({ cutter, diameter });
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {/* The TYPE first: it decides what the other two fields mean. */}
      <CutterPicker value={cutter} onChange={onCutter} />
      <Space wrap align="center" size="small">
        <Tooltip title="Cutting diameter">
          <Space.Compact>
            <span className="ant-input-group-addon" style={addonStyle('left')}>⌀</span>
            <InputNumber controls={false}
              min={0.1} step={0.5} value={diameter} onChange={onDiameter}
              style={{ width: 74 }}
            />
            <span className="ant-input-group-addon" style={addonStyle('right')}>mm</span>
          </Space.Compact>
        </Tooltip>
        {/* Flutes are not decoration: feed = rpm x flutes x chip load, so this
            number is a term in the cycle time. Clamped to what the type is
            actually made in. */}
        <Tooltip title={`Flutes / inserts — feed is rpm x flutes x chip load, so this changes the cycle time (${loF}-${hiF} for a ${spec.label.toLowerCase()})`}>
          <Space.Compact>
            <span className="ant-input-group-addon" style={addonStyle('left')}>Z</span>
            <InputNumber controls={false}
              min={loF} max={hiF} step={1} value={flutes} onChange={onFlutes}
              style={{ width: 56 }}
            />
          </Space.Compact>
        </Tooltip>
        {spec.angleAdjustable && (
          <Tooltip title="Included angle — the chamfer this cutter leaves. 90° gives a 45° chamfer.">
            <Space.Compact>
              <span className="ant-input-group-addon" style={addonStyle('left')}>∠</span>
              <InputNumber controls={false}
                min={15} max={175} step={5} value={angle} onChange={onAngle}
                style={{ width: 62 }}
              />
              <span className="ant-input-group-addon" style={addonStyle('right')}>°</span>
            </Space.Compact>
          </Tooltip>
        )}
        {/* A slot cutter's cutting body and its shank are both numbers the
            diameter cannot imply — a necked tool is wide where it cuts and
            narrow where the holder grips it. */}
        {spec.thicknessAdjustable && (
          <Tooltip title="Cutter thickness — the width of the slot this tool leaves.">
            <Space.Compact>
              <span className="ant-input-group-addon" style={addonStyle('left')}>t</span>
              <InputNumber controls={false}
                aria-label="Cutter thickness"
                min={spec.thicknessRange[0]}
                max={spec.thicknessRange[1]}
                step={0.5}
                // Empty means "not measured": the marker falls back to what the
                // type implies and the cut is not capped. Showing that default
                // as a VALUE read as a setting that was already in force, so
                // pressing Simulate changed nothing and looked broken.
                value={thickness ?? null}
                placeholder={String(defaultThickness(spec.id, diameter))}
                onChange={onThickness}
                style={{ width: 66 }}
              />
              <span className="ant-input-group-addon" style={addonStyle('right')}>mm</span>
            </Space.Compact>
          </Tooltip>
        )}
        {spec.shankAdjustable && (
          <Tooltip title="Shank diameter — the plain part above the flutes, which the holder grips.">
            <Space.Compact>
              <span className="ant-input-group-addon" style={addonStyle('left')}>s⌀</span>
              <InputNumber controls={false}
                aria-label="Shank diameter"
                min={spec.shankRange[0]}
                max={spec.shankRange[1]}
                step={0.5}
                value={shank ?? null}
                placeholder={String(defaultShank(spec.id, diameter))}
                onChange={onShank}
                style={{ width: 66 }}
              />
              <span className="ant-input-group-addon" style={addonStyle('right')}>mm</span>
            </Space.Compact>
          </Tooltip>
        )}
      </Space>
      {advice && (
        <Text style={{ color: '#a16207', fontSize: 11 }}>{advice}</Text>
      )}
    </Space>
  );
}

/**
 * The billet: how big it is, and where it sits.
 *
 * Every number here is computed in `engine/sim/billet.js` — the box, the
 * extents, whether the program fits inside, and the blank to offer. This places
 * the fields and reports what the engine said.
 *
 * The extents line under the fields is not decoration. "Origin" is ambiguous on
 * its own — a corner, a centre, the middle of the top face are all plausible
 * readings, and no label settles it as well as printing the resulting range.
 * With `X −10.0 … 70.0` on screen there is nothing left to guess at.
 */
function BilletBox({
  size, origin, extents, suggestion, warnings, onSize, onOrigin, onFit,
  enabled, onToggle, addonStyle,
}) {
  const field = (k, value, onChange, placeholder, allowNegative) => (
    <Space.Compact key={k}>
      <span className="ant-input-group-addon" style={addonStyle('left')}>{k.toUpperCase()}</span>
      <InputNumber controls={false}
        disabled={!enabled}
        {...(allowNegative ? {} : { min: 0 })}
        placeholder={placeholder}
        value={value[k]}
        onChange={(v) => onChange({
          // A size of 0 is not a billet; an origin of 0 is a perfectly good
          // place to put one, so only sizes treat zero as "unset".
          [k]: allowNegative
            ? (Number.isFinite(v) ? v : null)
            : (v && v > 0 ? v : null),
        })}
        style={{ width: 76 }}
      />
    </Space.Compact>
  );
  const range = ([lo, hi]) => `${lo.toFixed(1)} … ${hi.toFixed(1)}`;

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Space align="center" wrap size="small">
        {/* On/off for the whole billet. Off hands the blank back to the
            automatic fit around the toolpath and takes the preview with it. */}
        <CommandButton
          id="stockEnabled"
          size="small"
          type={enabled ? 'primary' : 'default'}
          icon={<StockCutIcon />}
          onClick={onToggle}
        />
        <Tooltip title="The blank in the vice, in mm. Leave an axis blank to wrap the toolpath instead.">
          <span style={{ color: enabled ? '#94a3b8' : '#475569' }}>Stock</span>
        </Tooltip>
        {['x', 'y', 'z'].map((k) => field(k, size, onSize, 'auto', false))}
        <span style={{ color: '#475569', fontSize: 12 }}>mm</span>
        {suggestion && enabled && (
          <CommandButton
            id="fitStock"
            size="small"
            type="text"
            icon={<ColumnWidthOutlined />}
            onClick={onFit}
          />
        )}
      </Space>
      <Space align="center" wrap size="small">
        <span style={{ width: 24, display: 'inline-block' }} />
        <Tooltip title="Where the blank's X−/Y−/Z− corner sits in work coordinates. Blank centres it on the cutting in X and Y, and puts the top face on Z0 — which is now only a default, not a rule.">
          <span style={{ color: enabled ? '#94a3b8' : '#475569' }}>Origin</span>
        </Tooltip>
        {['x', 'y', 'z'].map((k) => field(k, origin, onOrigin, 'auto', true))}
        <span style={{ color: '#475569', fontSize: 12 }}>mm</span>
      </Space>
      {enabled && extents && (
        <Text style={{ color: '#475569', fontSize: 11, fontFamily: 'monospace' }}>
          X {range(extents.x)} · Y {range(extents.y)} · Z {range(extents.z)}
        </Text>
      )}
      {!enabled && (
        <Text style={{ color: '#475569', fontSize: 11 }}>
          Stock off — the sim fits a blank around the toolpath.
        </Text>
      )}
      {enabled && warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="The program cuts outside the blank"
          description={<ul style={{ margin: 0, paddingLeft: 18 }}>
            {warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>}
        />
      )}
    </Space>
  );
}

export default function App() {
  const { token } = theme.useToken();
  // Small scalar state from Zustand — large buffers live in bufferCache.
  const gcode = useCamStore((s) => s.gcode);
  const fileName = useCamStore((s) => s.fileName);
  const status   = useCamStore((s) => s.status);
  const error    = useCamStore((s) => s.error);
  const bufVer   = useCamStore((s) => s.bufVer);  // version counter — triggers re-render
  const playhead = useCamStore((s) => s.playhead);
  const playT    = useCamStore((s) => s.playT);
  const playing  = useCamStore((s) => s.playing);
  const simStatus = useCamStore((s) => s.simStatus);
  const mode      = useCamStore((s) => s.mode);
  const page      = useCamStore((s) => s.page);
  const diameterMode = useCamStore((s) => s.diameterMode);
  const rapidRate = useCamStore((s) => s.rapidRate);
  const view      = useCamStore((s) => s.view);
  const viewNonce = useCamStore((s) => s.viewNonce);
  const toolRadius = useCamStore((s) => s.toolRadius);
  const toolType  = useCamStore((s) => s.toolType);
  const toolCutter = useCamStore((s) => s.toolCutter);
  const toolFlutes = useCamStore((s) => s.toolFlutes);
  const toolAngle  = useCamStore((s) => s.toolAngle);
  const toolThickness = useCamStore((s) => s.toolThickness);
  const toolShank = useCamStore((s) => s.toolShank);
  const cellSize  = useCamStore((s) => s.cellSize);
  const cellSizeUsed = useCamStore((s) => s.cellSizeUsed);
  const cellLimited = useCamStore((s) => s.cellLimited);
  const voxelSize = useCamStore((s) => s.voxelSize);
  const voxelSizeUsed = useCamStore((s) => s.voxelSizeUsed);
  const voxelLimited = useCamStore((s) => s.voxelLimited);
  const simMethod = useCamStore((s) => s.simMethod);
  const turnTool  = useCamStore((s) => s.turnTool);
  const stockOversize = useCamStore((s) => s.stockOversize);
  const toolOverrides = useCamStore((s) => s.toolOverrides);
  const stockMargin = useCamStore((s) => s.stockMargin);
  const stockSize = useCamStore((s) => s.stockSize);
  const stockOrigin = useCamStore((s) => s.stockOrigin);
  const stockEnabled = useCamStore((s) => s.stockEnabled);
  const showStock = useCamStore((s) => s.showStock);
  const showArbor = useCamStore((s) => s.showArbor);
  const cutFollowsPlayback = useCamStore((s) => s.cutFollowsPlayback);
  const simReady  = useCamStore((s) => s.simReady);
  const removalNote = useCamStore((s) => s.removalNote);
  const aIndex    = useCamStore((s) => s.aIndex);
  const rotaryFrame = useCamStore((s) => s.rotaryFrame);
  const simFrameA   = useCamStore((s) => s.simFrameA);
  // Actions are stable references defined once in the store.
  const setGcode = useCamStore((s) => s.setGcode);
  const parse    = useCamStore((s) => s.parse);
  const loadFile = useCamStore((s) => s.loadFile);
  const setPlayhead = useCamStore((s) => s.setPlayhead);
  const togglePlay  = useCamStore((s) => s.togglePlay);
  const stepBlock   = useCamStore((s) => s.stepBlock);
  const simulate    = useCamStore((s) => s.simulate);
  const simulateVoxel = useCamStore((s) => s.simulateVoxel);
  const setTurnTool = useCamStore((s) => s.setTurnTool);
  const setToolOverride = useCamStore((s) => s.setToolOverride);
  const setToolCutter = useCamStore((s) => s.setToolCutter);
  const setToolThickness = useCamStore((s) => s.setToolThickness);
  const setToolShank = useCamStore((s) => s.setToolShank);
  const clearToolOverride = useCamStore((s) => s.clearToolOverride);
  const setTool     = useCamStore((s) => s.setTool);
  const setCutter   = useCamStore((s) => s.setCutter);
  const setThickness = useCamStore((s) => s.setThickness);
  const setShank = useCamStore((s) => s.setShank);
  const setFlutes   = useCamStore((s) => s.setFlutes);
  const toggleStock = useCamStore((s) => s.toggleStock);
  const setStockSize = useCamStore((s) => s.setStockSize);
  const setStockOrigin = useCamStore((s) => s.setStockOrigin);
  const setBillet = useCamStore((s) => s.setBillet);
  const toggleStockEnabled = useCamStore((s) => s.toggleStockEnabled);
  const toggleArbor = useCamStore((s) => s.toggleArbor);
  const setCutFollows = useCamStore((s) => s.setCutFollows);
  const setMode     = useCamStore((s) => s.setMode);
  const setPage     = useCamStore((s) => s.setPage);
  const setViewPreset = useCamStore((s) => s.setViewPreset);
  const setRapidRate = useCamStore((s) => s.setRapidRate);
  const setDiameterMode = useCamStore((s) => s.setDiameterMode);
  const setAIndex   = useCamStore((s) => s.setAIndex);
  const setRotaryFrame = useCamStore((s) => s.setRotaryFrame);
  const loadPart      = useCamPlanStore((s) => s.loadPart);
  const partAnalysis  = useCamPlanStore((s) => s.analysis);
  const partVer       = useCamPlanStore((s) => s.meshVer);
  // Where the physical A axis runs, so the work turns about the line it was
  // touched off on rather than the part's own zero. Subscribe to the function,
  // not its result — it builds a fresh array every call.
  const displayedRotaryCenter = useCamPlanStore((s) => s.displayedRotaryCenter);
  const partDatum     = useCamPlanStore((s) => s.datum);
  const [showPart, setShowPart] = useState(true);
  // The sim's fallback cutter is collapsed until asked for — see `ToolFallback`.
  const [toolFallbackOpen, setToolFallbackOpen] = useState(false);

  const [speed, setSpeed] = useState(1);
  const [dragActive, setDragActive] = useState(false);
  const sketching = page === 'sketch';
  const turning = page === 'turn';

  // Running a program collapses the sidebar to the program listing — the setup
  // controls are dead weight mid-run and push the live panel out of sight. The
  // decision lives in engine/view/sidebar.js so it is tested, not buried in JSX.
  const show = sidebarSections({ playing });
  const arborToggle = offerArborToggle({ mode, sketching });

  // Open on a blank page — no sample program is loaded. The user brings their
  // own via drag-and-drop, Open file, or the (optional) Load sample button.

  // Animation loop: advance the playhead while playing. Paced by *machine time*,
  // not segment count — a helix tessellates into tens of thousands of tiny
  // segments (T3 is 91% of them) while a face mill is a few long moves, so a
  // segment-paced run parks on the helix and never shows the other tools. Time
  // pacing gives every operation screen-time proportional to how long it runs.
  const playTimeRef = useRef(0);
  useEffect(() => {
    if (!playing) return undefined;
    const startPath = getBuf().path;
    if (!startPath) return undefined;
    // Resume from wherever the playhead sits (0 after a restart).
    playTimeRef.current = timeAt(startPath, useCamStore.getState().playhead);
    const id = setInterval(() => {
      // The path is read per tick rather than captured, so a re-parse mid-run is
      // picked up **without** this effect depending on `bufVer`. It must not:
      // carving bumps `bufVer` on every step, so with "cut with playback" on the
      // loop was torn down and rebuilt constantly, and each rebuild snapped the
      // time cursor to `timeAt(playhead)` — the *end* of the segment in progress.
      // Playback then advanced a whole segment per carve, running at the speed of
      // the worker instead of the speed setting.
      const path = getBuf().path;
      if (!path) return;
      const totalT = path.totalTime || 1;
      // 40 ms per tick; the whole program spans PLAY_BASE_SECONDS at 1×.
      playTimeRef.current += perTick(totalT, speed);
      const k = segmentAtTime(path, playTimeRef.current);
      useCamStore.getState().setPlayhead(k);
      useCamStore.setState({ playT: playTimeRef.current }); // smooth marker interpolation
      if (k >= path.count) useCamStore.getState().pause();
      invalidate(); // wake up the demand-mode canvas
    }, 40);
    return () => clearInterval(id);
  }, [playing, speed]);

  // Saving / opening work. Errors surface in the store's `error` alert, the same
  // place a parse failure lands, so there is one place to look.
  const [saveMsg, setSaveMsg] = useState(null);
  const report = useCallback(async (fn, done) => {
    try {
      const name = await fn();
      // A null name means the user closed the save dialog — say nothing.
      if (name !== null) setSaveMsg(done(name));
    } catch (err) {
      useCamStore.setState({ error: err?.message || String(err) });
    }
  }, []);
  const onExportGcode = useCallback(
    () => report(exportGcode, (n) => `Downloaded ${n}`), [report],
  );
  // Whether the library is open in the sidebar. It is a place to work, not a
  // menu, so it stays put until it is closed again.
  const [libraryOpen, setLibraryOpen] = useState(false);
  // ---- Simulate on its own, once the setup says what to simulate ----------
  //
  // A program, a stated billet and an origin are the three things that make
  // "what will this make?" answerable, and the moment they are all there the
  // operator has already asked the question. `autoSimKey` describes the setup as
  // a string so the run happens once per setup rather than once per render —
  // see `engine/view/autoSim.js`.
  const autoKey = autoSimKey({
    gcode, stockEnabled, stockSize, stockOrigin, datum: partDatum, aIndex,
  });
  const lastAutoKey = useRef(null);
  useEffect(() => {
    if (!shouldAutoSimulate({
      key: autoKey,
      last: lastAutoKey.current,
      playing,
      running: simStatus === 'running',
      sketching,
    })) return;
    lastAutoKey.current = autoKey;
    simulate();
  }, [autoKey, playing, simStatus, sketching, simulate]);

  // Let a save confirmation fade rather than linger.
  useEffect(() => {
    if (!saveMsg) return undefined;
    const id = setTimeout(() => setSaveMsg(null), 4000);
    return () => clearTimeout(id);
  }, [saveMsg]);

  // Drag-and-drop a real G-code file anywhere on the window.
  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      // A model is a thing to be machined, not a program to be run, so it goes
      // to the planner rather than the interpreter. Routing on the extension
      // keeps one drop target for both — and the planner re-checks the bytes,
      // so a mislabelled file still lands in the right place.
      const name = file.name.toLowerCase();
      if (PART_FORMATS.some((f) => f.extensions.some((e) => name.endsWith(e)))) {
        loadPart(file);
      } else if (name.endsWith('.json')) {
        // A project file. This is the only way in now that the sidebar's Open
        // project button has gone, so it must not be handed to the G-code
        // parser — which would read a JSON document as a program and fail.
        report(async () => {
          await openProjectFile(file);
          return file.name;
        }, (n) => `Opened project ${n}`);
      } else loadFile(file);
    },
    [loadFile, loadPart, report]
  );

  // Read large buffers from cache (not from React state). Viewport slices the
  // drawn sub-path itself; here we only need the small scalar bits.
  // `sim` is read here only for a truthiness gate + the scalar removedVolume —
  // it is never passed down as a prop (that would re-trigger the DataCloneError).
  const { bounds, stats, path, sim } = getBuf();

  const warnings = stats?.warnings ?? [];
  const rotaryIndices = stats?.aIndices ?? [0];
  // Live sketch bounds, so "Fit" frames what's drawn on the plane even with no
  // program loaded. Merged into the fit inside CameraRig (kept out of the fit
  // *key* there so drawing doesn't snap the camera — only an explicit Fit does).
  const sketchSk = useSketchStore((s) => s.sk);
  const sketchVersion = useSketchStore((s) => s.version);
  const sketchFit = useMemo(
    () => sketchBounds(sketchSk),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sketchSk, sketchVersion],
  );
  // The A-axis centre for the viewport's work rotation. `[0,0]` — the frame's
  // own origin — is what indexing assumed before an operator could pick one,
  // and stays the answer when they haven't.
  const picked = displayedRotaryCenter();
  const rotaryCenter = useMemo(
    () => picked ?? [0, 0],
    [picked?.[0], picked?.[1]], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // The frame toggle is only meaningful where there is a 4th axis to draw: a
  // milling program that actually indexes. Everything else has one honest view.
  const canRotateWork = !turning && rotaryIndices.length > 1;

  // The billet, measured against the program. All of it comes from
  // `engine/sim/billet.js` — the same function the carver builds its block
  // with — so what the panel reports and what gets cut cannot disagree.
  const billetSuggestion = useMemo(
    () => (bounds ? suggestBillet(bounds, { margin: stockMargin }) : null),
    [bounds, stockMargin],
  );
  // Deliberately NOT gated on a parsed program: the material is in the vice
  // before the .nc exists, and a blank you cannot describe until one is loaded
  // is a blank you cannot set up against. `previewSolid` owns the whole rule,
  // including when there is nothing worth drawing.
  const billetOpts = useMemo(
    () => ({ margin: stockMargin, origin: stockOrigin }),
    [stockMargin, stockOrigin],
  );
  const billetNow = useMemo(
    () => (turning || !stockEnabled ? null : billetBox(bounds, stockSize, billetOpts)),
    [bounds, stockSize, billetOpts, turning, stockEnabled],
  );
  // The blank as a drawable box, straight to the viewport. No worker, no carve —
  // so it follows the number being typed rather than the last press of Simulate.
  // Yielded to the carved block the moment there is one to show.
  const stockSolid = useMemo(
    () => (sim || turning || !stockEnabled ? null : previewSolid(bounds, stockSize, billetOpts)),
    [bounds, stockSize, billetOpts, sim, turning, stockEnabled],
  );
  // The readout describes what is actually on screen. With neither a program
  // nor a stated size there is no blank, and printing the ±margin box round the
  // origin would be reporting a billet that does not exist.
  const billetExtentsNow = useMemo(
    () => (stockSolid || sim ? billetExtents(billetNow) : null),
    [billetNow, stockSolid, sim],
  );
  const billetProblems = useMemo(
    // Only measurable against a program. With none loaded there is nothing the
    // blank could be too small for yet.
    () => (billetNow && bounds ? billetWarnings(billetNow, bounds) : []),
    [billetNow, bounds],
  );
  // The blank as a fit target, in the same shape the camera framing wants.
  const billetFit = useMemo(() => (stockSolid && billetNow ? {
    min: [billetNow.xMin, billetNow.yMin, billetNow.base],
    max: [billetNow.xMax, billetNow.yMax, billetNow.top],
  } : null), [stockSolid, billetNow]);

  // Frame the camera to the cutting geometry (the part), not the rapid retracts.
  // Deliberately NOT keyed on bufVer: the values don't change as the sim carves,
  // and refitting on every playback tick was resetting the user's zoom.
  // An imported model is framed too, and unioned with the program's bounds when
  // both exist — after "Verify in viewport" the toolpath and the part it came
  // from should be on screen together, not one of them off the edge.
  const fitBounds = useMemo(() => {
    // Machine frame: the cutting moves all sit above the A axis, so their bounds
    // are a plane and fitting to them frames a sliver. What is on screen over
    // the run is that path swept around the axis — see `sweptFitBox`.
    const cut = fitBoundsFor(turning ? 'turn' : 'mill', bounds);
    return unionBounds(
      unionBounds(
        rotaryFrame === 'machine' ? sweptFitBox(cut, rotaryCenter) : cut,
        // The blank is framed too. Without it, sizing stock on an empty
        // viewport draws a 50 mm block the camera is nowhere near.
        billetFit,
      ),
      fitBoundsForPart(turning ? 'turn' : 'mill', partAnalysis?.bounds ?? null),
    );
  }, [bounds, turning, partAnalysis, rotaryFrame, rotaryCenter, billetFit]);

  // Chuck placement uses the *real* cutting bounds (not the padded fit), so the
  // 5 mm clearance to the deepest cut is preserved regardless of framing. The
  // chuck grips the **raw bar** diameter (turned OD + oversize) — the same
  // uniform bar the sim carves — so the whole bar reads as one stock size.
  const turnChuck = useMemo(
    () => chuckFromBounds(turning ? 'turn' : 'mill', bounds, stockOversize),
    [bounds, turning, stockOversize],
  );
  // Tools auto-detected from the program's comments, and the one cutting now.
  const detectedTools = stats?.tools ?? [];
  const currentToolNum = useMemo(() => toolAt(path, playhead), [path, playhead, bufVer]);
  const currentTool = detectedTools.find((t) => t.n === currentToolNum) || null;
  // The tool marker follows the active cutter's real size AND shape, so it
  // visibly shrinks from a Ø32 face mill to a Ø3 reamer as the program runs, and
  // a face mill is a disc where a slot drill is a stick. Which of the three
  // sources wins — the Tool table, the program's comment, the fallback picker —
  // is `cam/effectiveTool.js`, the same decision the carvers make.
  const currentOverride = toolOverrides[currentToolNum] || {};
  const marker = effectiveTool({
    detected: currentTool,
    override: currentOverride,
    fallback: {
      radius: toolRadius,
      cutter: toolCutter,
      type: toolType,
      angle: toolAngle,
      thickness: toolThickness ?? undefined,
      shank: toolShank ?? undefined,
    },
  });
  const markerRadius = marker.radius;
  const markerType = marker.type;
  const markerCutter = marker.cutter;
  const markerAngle = marker.angle;
  const markerThickness = marker.thickness;
  const markerShank = marker.shank;
  // Gauge length (tip to collet) drives how far the milling marker sticks out.
  const markerLength = marker.length;
  // The turning toolholder for the marker — chosen per-tool in the Tool table.
  // MVJNR's insert nose angle is adjustable; MVVNN's is fixed.
  const baseTurnTool = STANDARD_TURN_TOOLS.find((t) => t.id === (currentOverride.insert ?? turnTool))
    ?? STANDARD_TURN_TOOLS[0];
  const turnInsert = turning
    ? {
        ...baseTurnTool,
        angle: baseTurnTool.adjustable ? (currentOverride.insertAngle ?? baseTurnTool.angle) : baseTurnTool.angle,
      }
    : null;
  // Feed and spindle speed at the playhead, and what the tool in the spindle
  // is, for the position page's footer. The tool description is the one the
  // marker draws and the carvers cut with (`effectiveTool` above), not the
  // program's comment on its own — the readout must name the tool that is
  // actually making the cut on screen.
  const running = useMemo(() => runningAt(path, playhead), [path, playhead, bufVer]);
  const droToolDesc = useMemo(() => ({
    cutter: turning ? null : marker.cutter ?? null,
    radius: turning ? 0 : marker.radius ?? 0,
    desc: currentTool?.desc ?? '',
    holder: turnInsert,
  }), [turning, marker.cutter, marker.radius, currentTool, turnInsert]);

  // Which tools cut at each rotary index — so the "pick which" selector can say
  // what you'll actually see carved at 0° / 90° / 270° instead of leaving you to
  // guess. Feeds only; one pass over the path, memoised on the buffer version.
  const toolsByIndex = useMemo(() => {
    const m = new Map();
    if (path?.rotary && path?.tools) {
      for (let i = 0; i < path.count; i++) {
        if (path.types[i] !== 1) continue; // cutting moves only
        const a = path.rotary[i];
        if (!m.has(a)) m.set(a, new Set());
        m.get(a).add(path.tools[i]);
      }
    }
    return m;
  }, [path, bufVer]);
  const toolsAtIndexLabel = (a) => {
    const set = toolsByIndex.get(a);
    if (!set || set.size === 0) return 'no cutting';
    return [...set].sort((x, y) => x - y).map((n) => `T${n}`).join(', ');
  };
  const count = path?.count ?? 0;
  const activeLine = useMemo(() => lineAt(path, playhead), [path, playhead, bufVer]);
  // Machine time consumed by the segments executed so far.
  const elapsed = useMemo(() => timeAt(path, playhead), [path, playhead, bufVer]);

  // Park the tool at the current tip (end of the last executed segment). Just a
  // 3-number array — safe to pass to Viewport as a React prop.
  const toolPos = useMemo(() => {
    if (!path || playhead <= 0) return null;
    // While playing, ride the continuous machine time so the marker glides along
    // long moves; paused/scrubbing, sit at the playhead's segment boundary.
    const t = playing ? playT : timeAt(path, playhead);
    return toolPointAt(path, t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, playhead, playT, playing, count, bufVer]);

  // Where the block in progress is headed, for the readout's DIST TO GO column.
  // The same clock as toolPos above, so the two numbers are always a matched
  // pair — a position and the distance left on the very move it is making.
  const toolTarget = useMemo(() => {
    if (!path || playhead <= 0) return null;
    const t = playing ? playT : timeAt(path, playhead);
    return blockTargetAt(path, t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, playhead, playT, playing, count, bufVer]);

  // Rotary index (A/B degrees) at the playhead, so the tool marker can stand
  // normal to the face being cut instead of always pointing straight up +Z.
  // Where to draw the tool when the machine is not running. Without this the
  // marker simply did not exist until the playhead moved, so picking a cutter
  // type changed nothing on screen and read as a picker that does not work.
  // Kept separate from `toolPos`: the position readout must go on showing
  // nothing, because the machine is not actually anywhere.
  // Memoised: a fresh array every render would retrigger the demand-mode
  // canvas's invalidate() on every keystroke anywhere in the app.
  const markerPos = useMemo(
    () => toolPos ?? parkedTip({ solid: stockSolid, bounds, radius: markerRadius }),
    [toolPos, stockSolid, bounds, markerRadius],
  );

  // Which simulator this setup needs, and why — the same pure rule the store
  // routes on, so the button says up front what pressing it will do.
  const simPlan = useMemo(
    () => simMethodFor({
      rotaryIndices,
      fallbackTool: { thickness: toolThickness ?? undefined },
      overrides: toolOverrides,
    }),
    [rotaryIndices, toolThickness, toolOverrides],
  );

  const toolRotary = useMemo(() => {
    if (!path || playhead <= 0) return null;
    return rotaryAt(path, playhead);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, playhead, count, bufVer]);

  const addonStyle = (side) => ({
    padding: '0 8px', background: '#1e293b', border: '1px solid #334155',
    [side === 'left' ? 'borderRight' : 'borderLeft']: 0,
    display: 'inline-flex', alignItems: 'center', color: '#94a3b8',
    fontSize: 12, borderRadius: side === 'left' ? '6px 0 0 6px' : '0 6px 6px 0',
  });

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragLeave={() => setDragActive(false)}
      onDrop={onDrop}
      style={{ height: '100vh' }}
    >
      <Layout style={{ height: '100vh' }}>
        <Header style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#0b1220' }}>
          <ThunderboltOutlined style={{ color: token.colorPrimary, fontSize: 22 }} />
          <Title level={4} style={{ color: '#e2e8f0', margin: 0 }}>
            Engineer CAD/CAM
          </Title>
          <Segmented
            value={page}
            onChange={setPage}
            options={PAGES}
            disabled={status === 'parsing'}
          />
          {fileName && <Tag color="blue">{fileName}</Tag>}
          <Text style={{ color: '#64748b', marginLeft: 'auto' }}>
            Rapid <span style={{ color: '#ef4444' }}>-----</span>   Feed {' '}
            <span style={{ color: '#22c55e' }}>-----</span>
          </Text>
        </Header>
        <Layout>
          {!sketching && (
          <Sider width={430} style={{ background: '#111827', padding: 16, overflow: 'auto' }}>
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              {/* Icon-only, like every other rail in the app: the names and the
                  descriptions come from the command catalogue and appear on
                  hover. See `engine/view/commands.js`. */}
              {show.files && (
              <Space wrap>
                <CommandButton
                  id="parse"
                  type="primary"
                  icon={<ThunderboltOutlined />}
                  loading={status === 'parsing'}
                  onClick={() => parse()}
                />
                <Upload
                  accept=".nc,.gcode,.gc,.tap,.cnc,.ngc,.txt,.mpf"
                  showUploadList={false}
                  beforeUpload={(file) => { loadFile(file); return false; }}
                >
                  <CommandButton id="openProgram" icon={<UploadOutlined />} />
                </Upload>
                <CommandButton
                  id="sample"
                  icon={<BulbOutlined />}
                  onClick={() => parse(turning ? SAMPLE_TURNING : SAMPLE_GCODE)}
                />
              </Space>
              )}

              {/* Keeping and handing on work. Saving to a **file** — the
                  project as .camweb.json, and opening one back — has moved out
                  of here: the library keeps the same thing in the browser under
                  a name, with no dialog and no folder to find again, and two
                  ways to do one job on one rail is two ways to be unsure which
                  one you used. A file still opens by dropping it on the window.
                  What is left is one row: keep it, or hand the program on. */}
              {show.project && <>
              <Space wrap>
                <CommandButton
                  id="openLibrary"
                  icon={<DatabaseOutlined />}
                  type={libraryOpen ? 'primary' : 'default'}
                  ghost={libraryOpen}
                  onClick={() => setLibraryOpen((v) => !v)}
                />
                <CommandButton
                  id="exportGcode"
                  icon={<DownloadOutlined />}
                  disabled={!gcode}
                  onClick={onExportGcode}
                />
              </Space>

              {/* The library works *in* the sidebar rather than in a popover:
                  saving, looking through what is there, opening one and deleting
                  two is a session, and a layer that shuts when you click near
                  its edge is the wrong container for one. */}
              <LibraryPanel inline open={libraryOpen} onDone={setSaveMsg} />

              <Text style={{ color: '#475569', fontSize: 12 }}>
                …or drag &amp; drop a .nc / .gcode / .tap program, a .camweb.json project,
                or an .stl / .obj / .ply to machine
              </Text>

              {saveMsg && <Alert type="success" showIcon message={saveMsg} />}
              </>}

              {/* CAM from a model. Sits above the program panel because it is
                  what *produces* a program — the G-code below is its output. */}
              {show.cam && <CamPanel />}

              <Divider style={{ margin: '4px 0' }} />
              <Space align="center" size="small" style={{ justifyContent: 'space-between', width: '100%' }}>
                <Title level={5} style={{ color: '#e2e8f0', margin: 0 }}>Program</Title>
                {/* Say why the rest of the panel went away — a sidebar that loses
                    most of its contents on its own reads as a bug. */}
                {playing && (
                  <Tag color="processing" style={{ marginInlineEnd: 0 }}>
                    running — pause to edit the setup
                  </Tag>
                )}
              </Space>

              <GcodePanel gcode={gcode} activeLine={activeLine} onChange={setGcode} />

              {error && <Alert type="error" showIcon message="Parse failed" description={error} />}

              {/* ---- Machine ---- */}
              {show.machine && (
              <Space align="center" wrap size="small">
                <Tooltip title="Traverse speed used to time G0 moves">
                  <span style={{ color: '#94a3b8' }}>Rapid</span>
                </Tooltip>
                <Space.Compact>
                  <InputNumber controls={false}
                    min={1}
                    step={500}
                    value={rapidRate}
                    onChange={(v) => setRapidRate(v || 5000)}
                    style={{ width: 96 }}
                  />
                  <span className="ant-input-group-addon" style={addonStyle('right')}>
                    mm/min
                  </span>
                </Space.Compact>
                {turning && (
                  <Tooltip title="Lathe convention: the X word is a diameter, not a radius">
                    <Space>
                      <span style={{ color: '#94a3b8' }}>X = ⌀</span>
                      <Switch checked={diameterMode} onChange={setDiameterMode} size="small" />
                    </Space>
                  </Tooltip>
                )}
              </Space>
              )}

              {show.stats && stats && (
                <Space size="large" wrap>
                  <Tooltip title={
                    `feed ${formatDuration(stats.feedTime)} · rapid ${formatDuration(stats.rapidTime)}`
                    + (stats.dwellTime > 0 ? ` · dwell ${formatDuration(stats.dwellTime)}` : '')
                  }>
                    <Statistic
                      title="Cycle time"
                      value={formatDuration(stats.cycleTime)}
                      valueStyle={{ color: token.colorPrimary }}
                    />
                  </Tooltip>
                  <Statistic title="Cutting length (mm)" value={stats.feedLength} precision={1} />
                  <Statistic title="Rapid (mm)" value={stats.rapidLength} precision={1} />
                  <Statistic title="Segments" value={stats.blocks} />
                </Space>
              )}

              {show.warnings && warnings.length > 0 && (
                <Alert
                  type="warning"
                  showIcon
                  message={`${warnings.length} warning(s)`}
                  description={
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {warnings.slice(0, 6).map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  }
                />
              )}

              {show.tools && detectedTools.length > 0 && (
                <>
                  <Divider style={{ margin: '4px 0', borderColor: '#334155' }}>
                    <Text style={{ color: '#64748b' }}>
                      Tool table{currentTool ? ` — cutting: T${currentTool.n}` : ''}
                    </Text>
                  </Divider>
                  <Text style={{ color: '#475569', fontSize: 11 }}>
                    Auto-detected from comments — edit any value to match the program;
                    the simulation uses these. Re-run Simulate after editing.
                  </Text>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {detectedTools.map((t) => {
                      const ov = toolOverrides[t.n] || {};
                      const active = t.n === currentToolNum;
                      const edited = ov.diameter != null || ov.simType != null
                        || ov.cutter != null || ov.angle != null || ov.thickness != null
                        || ov.shank != null
                        || ov.length != null || ov.insert != null || ov.insertAngle != null;
                      const effDia = ov.diameter ?? t.diameter;
                      // What this row's tool actually is, by the same rules the
                      // marker and the carvers use — so the highlighted glyph is
                      // the shape on screen, detected or picked.
                      const eff = effectiveTool({
                        detected: t,
                        override: ov,
                        fallback: {
                          radius: toolRadius,
                          cutter: toolCutter,
                          type: toolType,
                          angle: toolAngle,
                          thickness: toolThickness ?? undefined,
                          shank: toolShank ?? undefined,
                        },
                      });
                      const effSpec = cutterById(eff.cutter);
                      return (
                        <div
                          key={t.n}
                          title={t.desc}
                          style={{
                            display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
                            padding: '3px 6px', borderRadius: 4, fontSize: 12,
                            background: active ? '#1e293b' : 'transparent',
                            border: `1px solid ${active ? token.colorPrimary : '#1e293b'}`,
                          }}
                        >
                          <b style={{ color: active ? token.colorPrimary : '#cbd5e1', minWidth: 26 }}>
                            T{t.n}
                          </b>
                          <span style={{ minWidth: 58, color: '#64748b' }}>{t.type}</span>
                          {turning ? (() => {
                            const holderId = ov.insert ?? turnTool;
                            const holder = STANDARD_TURN_TOOLS.find((x) => x.id === holderId);
                            return (
                              <>
                                <TurnInsertPicker
                                  value={holderId}
                                  onChange={(id) => setToolOverride(t.n, { insert: id })}
                                />
                                {holder?.adjustable && (
                                  <>
                                    <span style={{ color: '#94a3b8' }}>insert°</span>
                                    <InputNumber controls={false}
                                      size="small"
                                      min={20}
                                      max={100}
                                      step={5}
                                      value={ov.insertAngle ?? holder.angle}
                                      onChange={(v) => setToolOverride(t.n, { insertAngle: v ?? holder.angle })}
                                      style={{ width: 62 }}
                                    />
                                  </>
                                )}
                              </>
                            );
                          })() : (
                            <>
                              <span style={{ color: '#94a3b8' }}>⌀</span>
                              <InputNumber controls={false}
                                size="small"
                                min={0.1}
                                step={0.5}
                                value={effDia}
                                placeholder="dia"
                                onChange={(v) => setToolOverride(t.n, { diameter: v ?? undefined })}
                                style={{ width: 68 }}
                              />
                              {/* The type, not just flat/ball: it is what the
                                  marker draws and what the carvers stamp. */}
                              <CutterPicker
                                box={26}
                                scope={`T${t.n}`}
                                value={eff.cutter}
                                onChange={(id) => setToolCutter(t.n, id)}
                              />
                              {effSpec.angleAdjustable && eff.cutter && (
                                <Tooltip title="Included angle — the chamfer this cutter leaves. 90° gives a 45° chamfer.">
                                  <Space.Compact>
                                    <span className="ant-input-group-addon" style={addonStyle('left')}>∠</span>
                                    <InputNumber controls={false}
                                      size="small"
                                      min={15}
                                      max={175}
                                      step={5}
                                      value={eff.angle}
                                      onChange={(v) => setToolOverride(t.n, { angle: v || 90 })}
                                      style={{ width: 56 }}
                                    />
                                  </Space.Compact>
                                </Tooltip>
                              )}
                              {/* Thickness: the slot this tool leaves. Only the
                                  slot cutter is specified that way. */}
                              {effSpec.thicknessAdjustable && eff.cutter && (
                                <Tooltip title="Cutter thickness — the width of the slot this tool leaves.">
                                  <Space.Compact>
                                    <span className="ant-input-group-addon" style={addonStyle('left')}>t</span>
                                    <InputNumber controls={false}
                                      size="small"
                                      aria-label={`T${t.n} cutter thickness`}
                                      min={effSpec.thicknessRange[0]}
                                      max={effSpec.thicknessRange[1]}
                                      step={0.5}
                                      value={eff.thickness ?? null}
                                      placeholder={String(defaultThickness(eff.cutter, eff.radius * 2))}
                                      onChange={(v) => setToolThickness(t.n, v, eff.cutter)}
                                      style={{ width: 62 }}
                                    />
                                  </Space.Compact>
                                </Tooltip>
                              )}
                              {/* Shank: a necked slot mill is narrower where
                                  the holder grips it than where it cuts. */}
                              {effSpec.shankAdjustable && eff.cutter && (
                                <Tooltip title="Shank diameter — the plain part above the flutes, which the holder grips.">
                                  <Space.Compact>
                                    <span className="ant-input-group-addon" style={addonStyle('left')}>s⌀</span>
                                    <InputNumber controls={false}
                                      size="small"
                                      aria-label={`T${t.n} shank diameter`}
                                      min={effSpec.shankRange[0]}
                                      max={effSpec.shankRange[1]}
                                      step={0.5}
                                      value={eff.shank ?? null}
                                      placeholder={String(defaultShank(eff.cutter, eff.radius * 2))}
                                      onChange={(v) => setToolShank(t.n, v, eff.cutter)}
                                      style={{ width: 62 }}
                                    />
                                  </Space.Compact>
                                </Tooltip>
                              )}
                              <Tooltip title="Gauge length — tip to the collet face (stick-out)">
                                <span style={{ color: '#94a3b8' }}>L</span>
                              </Tooltip>
                              <InputNumber controls={false}
                                size="small"
                                min={0}
                                step={1}
                                value={ov.length ?? t.length ?? undefined}
                                placeholder="len"
                                onChange={(v) => setToolOverride(t.n, { length: v ?? undefined })}
                                style={{ width: 66 }}
                              />
                            </>
                          )}
                          <span style={{ marginLeft: 'auto', color: '#475569' }}>
                            {t.cutLength > 0 ? `${t.cutLength.toFixed(0)} mm` : 'unused'}
                          </span>
                          {edited && (
                            <CommandButton
                              id="resetTool"
                              size="small"
                              type="text"
                              icon={<RollbackOutlined />}
                              onClick={() => clearToolOverride(t.n)}
                              style={{ color: '#64748b', padding: '0 4px' }}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* Playback controls live in the viewport toolbar (bottom bar),
                  next to the view selector — not here in the sidebar. */}

              {/* ---- Phase 1: material removal ---- */}
              {show.removal && <>
              <Divider style={{ margin: '4px 0', borderColor: '#334155' }}>
                <Text style={{ color: '#64748b' }}>Material removal</Text>
              </Divider>

              {turning ? (
                <>
                  <Text style={{ color: '#475569', fontSize: 11 }}>
                    Pick each tool's insert in the Tool table above.
                  </Text>
                  <Space align="center" wrap>
                    <Tooltip title="Raw bar diameter over the largest turned diameter in the program">
                      <span style={{ color: '#94a3b8' }}>Stock ⌀ oversize</span>
                    </Tooltip>
                    <Space.Compact>
                      <InputNumber controls={false}
                        min={0}
                        step={0.5}
                        value={stockOversize}
                        onChange={(v) => setTool({ stockOversize: v ?? 0 })}
                        style={{ width: 80 }}
                      />
                      <span className="ant-input-group-addon" style={addonStyle('right')}>mm</span>
                    </Space.Compact>
                  </Space>
                  <Space wrap align="center">
                    <CommandButton
                      id="simulateTurning"
                      type="primary"
                      ghost
                      icon={<TurningIcon />}
                      loading={simStatus === 'running'}
                      onClick={() => simulate()}
                    />
                    {sim && (
                      <Statistic title="Removed (mm³)" value={sim.removedVolume} precision={0} />
                    )}
                  </Space>
                  {sim && (
                    <Space size="large" wrap>
                      <Space>
                        <span style={{ color: '#94a3b8' }}>Show stock</span>
                        <Switch checked={showStock} onChange={toggleStock} size="small" />
                      </Space>
                      <Space>
                        <Tooltip title="Turn the bar down progressively as the playhead moves">
                          <span style={{ color: '#94a3b8' }}>Cut with playback</span>
                        </Tooltip>
                        <Switch
                          checked={cutFollowsPlayback}
                          onChange={setCutFollows}
                          size="small"
                          disabled={!simReady}
                        />
                      </Space>
                    </Space>
                  )}
                </>
              ) : (
                <>
                  {/* A tool that only cuts near its tip leaves a groove with a
                      roof on it, and the height field cannot hold one — see
                      `engine/sim/method.js`. Saying so is the difference
                      between "the slot cutter did not cut a slot" and knowing
                      which model is running. */}
                  {simPlan.method === 'voxel' && rotaryIndices.length <= 1 && (
                    <Alert
                      type="info"
                      showIcon
                      message="Simulating as voxels — this cutter leaves an undercut"
                      description={
                        <>
                          {simPlan.why}
                          {' '}The voxel block keeps it, and scrubs with playback
                          like the height field does.
                          {voxelSizeUsed && voxelSizeUsed !== voxelSize && (
                            <>
                              {' '}Voxels were
                              {voxelLimited ? ' held at ' : ' cut to '}
                              <b>{voxelSizeUsed.toFixed(3)} mm</b> tall
                              {voxelLimited
                                ? ' — as fine as this part can afford. A groove is rounded out to whole voxels, so it may still read taller than the tool.'
                                : ', so the groove is the height of the tool rather than of the grid. Their footprint stays at the size beside the button.'}
                            </>
                          )}
                        </>
                      }
                    />
                  )}
                  {rotaryIndices.length > 1 && (
                    <Alert
                      type="info"
                      showIcon
                      message={`4-axis program — A at ${rotaryIndices.map((a) => `${a}°`).join(', ')}`}
                      description={
                        <>
                          <b>Simulate all faces</b> carves every tool on every rotary
                          face into one voxel block (undercuts included) — no need to
                          pick a face. What runs where:
                          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                            {rotaryIndices.map((a) => (
                              <li key={a}>
                                <b>A {a}°</b> — {toolsAtIndexLabel(a)}
                              </li>
                            ))}
                          </ul>
                        </>
                      }
                    />
                  )}

                  {/* The cutter the sim carves with is normally read out of the
                      program and edited per tool in the Tool table above. This
                      is the fallback for a program that never says — worth
                      having, not worth a permanent row, so it lives behind a +.
                      It opens on its own when the program declared no tools at
                      all, because then it is the only thing that decides the
                      cut. */}
                  <ToolFallback
                    open={toolFallbackOpen}
                    onOpen={() => setToolFallbackOpen(true)}
                    detected={detectedTools.length}
                    diameter={toolRadius * 2}
                    cutter={toolCutter}
                    flutes={toolFlutes}
                    angle={toolAngle}
                    thickness={toolThickness}
                    shank={toolShank}
                    onDiameter={(v) => setTool({ toolRadius: (v || 0.2) / 2 })}
                    onCutter={setCutter}
                    onFlutes={setFlutes}
                    onAngle={(v) => setTool({ toolAngle: v || 90 })}
                    onThickness={setThickness}
                    onShank={setShank}
                    addonStyle={addonStyle}
                  />

                  {/* The billet, as a piece of material: X × Y × Z, and the
                      corner it sits on. The arithmetic lives in
                      `engine/sim/billet.js`; this only collects the numbers and
                      shows what the engine says about them. */}
                  <BilletBox
                    size={stockSize}
                    origin={stockOrigin}
                    extents={billetExtentsNow}
                    suggestion={billetSuggestion}
                    warnings={billetProblems}
                    onSize={setStockSize}
                    onOrigin={setStockOrigin}
                    onFit={() => setBillet(billetSuggestion)}
                    enabled={stockEnabled}
                    onToggle={toggleStockEnabled}
                    addonStyle={addonStyle}
                  />

                  <Space wrap>
                    {/* Each sim carries its own resolution, because they are
                        resolutions of different things — the height field's XY
                        cell and the voxel block's edge. Sitting in one column
                        under a shared "Stock" heading, they read as two settings
                        of one simulator, which they have never been. */}
                    <Space.Compact>
                      <CommandButton
                        id={simPlan.method === 'voxel'
                          ? (rotaryIndices.length > 1 ? 'simulateFaces' : 'simulateUndercut')
                          : 'simulate'}
                        type="primary"
                        ghost
                        icon={simPlan.method === 'voxel' ? <VoxelIcon /> : <StockCutIcon />}
                        loading={simStatus === 'running'}
                        onClick={() => simulate()}
                      />
                      <Tooltip title={cellSizeUsed && cellSizeUsed !== cellSize
                        ? `The coarsest the height field may be. The last run carved at ${cellSizeUsed.toFixed(3)} mm${cellLimited ? ' — as fine as this program can afford' : ', refined to the smallest cutter so its holes come out round'}.`
                        : 'The coarsest the height field may be — a small cutter refines it further, so its holes come out round'}
                      >
                        <InputNumber controls={false}
                          min={0.05}
                          step={0.1}
                          value={cellSize}
                          onChange={(v) => setTool({ cellSize: v || 0.5 })}
                          style={{ width: 70 }}
                          // A run that carved at something other than this
                          // number says so, rather than leaving the operator to
                          // wonder why a 0.5 mm grid drew a Ø3 hole round.
                          status={cellSizeUsed && cellSizeUsed !== cellSize ? 'warning' : ''}
                        />
                      </Tooltip>
                      <span className="ant-input-group-addon" style={addonStyle('right')}>mm</span>
                    </Space.Compact>
                    <Space.Compact>
                      <CommandButton
                        id="simulateVoxel"
                        icon={<VoxelIcon />}
                        loading={simStatus === 'running'}
                        onClick={() => simulateVoxel()}
                      />
                      <Tooltip title="Voxel edge length — smaller mm is finer and slower">
                        <InputNumber controls={false}
                          min={0.5}
                          step={0.5}
                          value={voxelSize}
                          onChange={(v) => setTool({ voxelSize: v || 1 })}
                          style={{ width: 70 }}
                        />
                      </Tooltip>
                      <span className="ant-input-group-addon" style={addonStyle('right')}>mm</span>
                    </Space.Compact>
                  </Space>
                  {/* A carve that takes nothing off looks exactly like a carve
                      that never ran. Saying which cause it was turns a silent
                      failure into a fixable one — see `engine/sim/removal.js`. */}
                  {removalNote && (
                    <Alert
                      type="warning"
                      showIcon
                      message="Nothing was removed"
                      description={removalNote}
                    />
                  )}
                  <Text style={{ color: '#475569', fontSize: 11 }}>
                    Left carves a <b>height field</b> — one Z per cell, so it is fast and
                    scrubs with playback, but cannot show an undercut. Right carves a{' '}
                    <b>voxel block</b> — every rotary face and every undercut, one shot,
                    no scrubbing.
                  </Text>
                  {simMethod === 'voxel' && sim && (
                    <Text style={{ color: '#475569', fontSize: 12 }}>
                      Voxel model — all faces &amp; undercuts, {(sim.cells / 1e6).toFixed(2)}M cells removed {sim.removedVolume?.toFixed(0)} mm³
                    </Text>
                  )}

                  {sim && (
                    <Space size="large" align="center" wrap>
                      <Statistic title="Removed (mm³)" value={sim.removedVolume} precision={0} />
                      <Space direction="vertical" size={2}>
                        <Space>
                          <span style={{ color: '#94a3b8' }}>Show stock</span>
                          <Switch checked={showStock} onChange={toggleStock} size="small" />
                        </Space>
                        <Space>
                          <Tooltip title="Carve the stock progressively as the playhead moves">
                            <span style={{ color: '#94a3b8' }}>Cut with playback</span>
                          </Tooltip>
                          <Switch
                            checked={cutFollowsPlayback}
                            onChange={setCutFollows}
                            size="small"
                            disabled={!simReady}
                          />
                        </Space>
                      </Space>
                    </Space>
                  )}
                </>
              )}
              </>}
            </Space>
          </Sider>
          )}
          <Content style={{ position: 'relative' }}>
            {/* Sketcher controls float over the viewport — only on the Sketch page,
                so the design workspace is separate from Milling / Turning. */}
            {sketching && <SketchToolbar />}

            {dragActive && (
              <div style={{
                position: 'absolute', inset: 0, zIndex: 10,
                background: 'rgba(56,189,248,0.12)', border: '2px dashed #38bdf8',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#e2e8f0', fontSize: 20, pointerEvents: 'none',
              }}>
                Drop a G-code program or an .stl / .obj / .ply model
              </div>
            )}

            {/* The control's position page, top-right — reads out where the tool
                is in work coordinates as the simulation runs. `mode` (not `page`)
                because that is what the interpreter used, so a lathe X stored as
                a radius is posted back as the diameter it was programmed as. */}
            <PositionReadout
              point={toolPos}
              target={toolTarget}
              mode={mode}
              diameterMode={diameterMode}
              rotary={toolRotary}
              aIndices={rotaryIndices}
              toolNumber={currentToolNum}
              tool={droToolDesc}
              running={running}
              line={activeLine}
              sketching={sketching}
              count={count}
            />

            {/* Bottom toolbar: view/plan selector and playback controls in one row. */}
            <div style={{
              position: 'absolute', bottom: 12, left: 12, right: 12, zIndex: 5,
              display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
              background: 'rgba(15,23,42,0.82)', border: '1px solid #334155',
              padding: '6px 12px', borderRadius: 8,
            }}>
              <Segmented size="small" value={view} onChange={setViewPreset} options={VIEWS} />
              <CommandButton
                id="fitView" size="small"
                icon={<ExpandOutlined />}
                title={sketching ? 'Frame the sketch in the window' : undefined}
                onClick={() => setViewPreset(view)}
              />
              {/* What the viewport draws is a set of toolbar toggles, the way a
                  CAD view toolbar does it — a pressed glyph, not a labelled
                  switch. `type` carries the on/off state. Only offered once
                  there is something to hide: a dead toggle is worse than none. */}
              {!sketching && partAnalysis && (
                <CommandButton
                  id="showPart" size="small"
                  type={showPart ? 'primary' : 'default'}
                  icon={<PartIcon />}
                  onClick={() => setShowPart(!showPart)}
                />
              )}
              {/* The arbor is the widest part of the marker, so it is what hides
                  the cut. Milling only — the lathe holder is drawn a different
                  way and has nothing to drop. */}
              {arborToggle && (
                <CommandButton
                  id="showArbor" size="small"
                  type={showArbor ? 'primary' : 'default'}
                  icon={<ArborIcon />}
                  onClick={toggleArbor}
                />
              )}
              {/* 4th axis: which end of the same rigid motion to watch. A rotary
                  table turns the WORK — that is what a 4-axis machine selects by
                  default — but the part frame, which keeps the workpiece still
                  and tilts the tool, is how you inspect every face at once. Both
                  states are real, so the tooltip says which one you are in. */}
              {canRotateWork && (
                <CommandButton
                  id="rotateWork" size="small"
                  type={rotaryFrame === 'machine' ? 'primary' : 'default'}
                  icon={<RotateWorkIcon />}
                  title={rotaryFrame === 'machine'
                    ? 'On: the table turns the work under an upright spindle, as it does on the machine'
                    : 'Off: the workpiece stays put and the tool tilts onto each indexed face'}
                  onClick={() => setRotaryFrame(rotaryFrame === 'machine' ? 'part' : 'machine')}
                />
              )}
              {!sketching && <>
              <div style={{ width: 1, alignSelf: 'stretch', background: '#334155' }} />
              <CommandButton
                id="restart"
                size="small" shape="circle"
                icon={<FastBackwardOutlined />}
                onClick={() => setPlayhead(0)}
                disabled={count === 0}
              />
              {/* Single block, either way: one source line per press, so an arc
                  steps as the one move it was written as and not as the hundreds
                  of chords it tessellates into. */}
              <CommandButton
                id="stepBack"
                size="small" shape="circle"
                icon={<StepBackwardOutlined />}
                onClick={() => stepBlock(-1)}
                disabled={count === 0 || playhead === 0}
              />
              <CommandButton
                id={playing ? 'pause' : 'play'}
                type="primary" shape="circle"
                icon={playing ? <PauseCircleFilled /> : <PlayCircleFilled />}
                onClick={togglePlay}
                disabled={count === 0}
              />
              <CommandButton
                id="stepForward"
                size="small" shape="circle"
                icon={<StepForwardOutlined />}
                onClick={() => stepBlock(1)}
                disabled={count === 0}
              />
              <Segmented size="small" value={speed} onChange={setSpeed} options={SPEEDS} />
              <Slider
                style={{ flex: 1, minWidth: 120, margin: 0 }}
                min={0}
                max={count}
                value={playhead}
                onChange={setPlayhead}
                tooltip={{ formatter: (v) => `${v} / ${count}` }}
                disabled={count === 0}
              />
              <Text style={{
                color: '#94a3b8', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap',
              }}>
                {formatDuration(elapsed)} / {formatDuration(stats?.cycleTime ?? 0)}
              </Text>
              </>}
            </div>

            <Viewport
              bounds={bounds}
              fitBounds={fitBounds}
              partVer={partVer}
              showPart={showPart}
              sketchFit={sketchFit}
              turnChuck={turnChuck}
              showStock={showStock}
              toolPos={markerPos}
              toolRotary={toolRotary}
              toolRadius={markerRadius}
              toolType={markerType}
              toolCutter={markerCutter}
              toolAngle={markerAngle}
              toolThickness={markerThickness}
              toolShank={markerShank}
              toolLength={markerLength}
              turnInsert={turnInsert}
              bufVer={bufVer}
              playhead={playhead}
              mode={sketching ? 'mill' : mode}
              sketching={sketching}
              showArbor={showArbor}
              rotaryFrame={rotaryFrame}
              rotaryCenter={rotaryCenter}
              simFrameA={simFrameA}
              stockSolid={stockSolid}
              view={view}
              viewNonce={viewNonce}
            />
          </Content>
        </Layout>
      </Layout>
    </div>
  );
}
