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
  InputNumber, Segmented, Switch, Divider, Slider, Upload, Tag, Tooltip, Select,
} from 'antd';
import {
  ThunderboltOutlined, ReloadOutlined, ExperimentOutlined,
  PlayCircleFilled, PauseCircleFilled, UploadOutlined, StepBackwardOutlined,
  ExpandOutlined,
} from '@ant-design/icons';
import { useCamStore } from './stores/camStore.js';
import { useSketchStore } from './stores/sketchStore.js';
import { sketchBounds } from './engine/sketch/edit.js';
import { lineAt, timeAt, rotaryAt, toolAt, segmentAtTime, toolPointAt } from './engine/gcode/path.js';
import { STANDARD_TURN_TOOLS } from './engine/sim/turning.js';
import { SAMPLE_GCODE, SAMPLE_TURNING } from './SAMPLE_GCODE.js';
import Viewport from './components/Viewport.jsx';
import GcodePanel from './components/GcodePanel.jsx';
import SketchToolbar from './components/SketchToolbar.jsx';
import { invalidate } from '@react-three/fiber';
import { getBuf } from './engine/bufferCache.js';

const { Sider, Content, Header } = Layout;
const { Title, Text } = Typography;

const SPEEDS = [
  { label: '0.1×', value: 0.1 },
  { label: '0.25×', value: 0.25 },
  { label: '0.5×', value: 0.5 },
  { label: '1×', value: 1 },
  { label: '2×', value: 2 },
  { label: '4×', value: 4 },
];

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
  const cellSize  = useCamStore((s) => s.cellSize);
  const voxelSize = useCamStore((s) => s.voxelSize);
  const simMethod = useCamStore((s) => s.simMethod);
  const turnTool  = useCamStore((s) => s.turnTool);
  const stockOversize = useCamStore((s) => s.stockOversize);
  const toolOverrides = useCamStore((s) => s.toolOverrides);
  const stockTop  = useCamStore((s) => s.stockTop);
  const stockBase = useCamStore((s) => s.stockBase);
  const stockMargin = useCamStore((s) => s.stockMargin);
  const showStock = useCamStore((s) => s.showStock);
  const cutFollowsPlayback = useCamStore((s) => s.cutFollowsPlayback);
  const simReady  = useCamStore((s) => s.simReady);
  const aIndex    = useCamStore((s) => s.aIndex);
  // Actions are stable references defined once in the store.
  const setGcode = useCamStore((s) => s.setGcode);
  const parse    = useCamStore((s) => s.parse);
  const loadFile = useCamStore((s) => s.loadFile);
  const setPlayhead = useCamStore((s) => s.setPlayhead);
  const togglePlay  = useCamStore((s) => s.togglePlay);
  const simulate    = useCamStore((s) => s.simulate);
  const simulateVoxel = useCamStore((s) => s.simulateVoxel);
  const setTurnTool = useCamStore((s) => s.setTurnTool);
  const setToolOverride = useCamStore((s) => s.setToolOverride);
  const clearToolOverride = useCamStore((s) => s.clearToolOverride);
  const setTool     = useCamStore((s) => s.setTool);
  const toggleStock = useCamStore((s) => s.toggleStock);
  const setCutFollows = useCamStore((s) => s.setCutFollows);
  const setMode     = useCamStore((s) => s.setMode);
  const setPage     = useCamStore((s) => s.setPage);
  const setViewPreset = useCamStore((s) => s.setViewPreset);
  const setRapidRate = useCamStore((s) => s.setRapidRate);
  const setDiameterMode = useCamStore((s) => s.setDiameterMode);
  const setAIndex   = useCamStore((s) => s.setAIndex);

  const [speed, setSpeed] = useState(1);
  const [dragActive, setDragActive] = useState(false);
  const sketching = page === 'sketch';
  const turning = page === 'turn';

  // Open on a blank page — no sample program is loaded. The user brings their
  // own via drag-and-drop, Open file, or the (optional) Load sample button.

  // Animation loop: advance the playhead while playing. Paced by *machine time*,
  // not segment count — a helix tessellates into tens of thousands of tiny
  // segments (T3 is 91% of them) while a face mill is a few long moves, so a
  // segment-paced run parks on the helix and never shows the other tools. Time
  // pacing gives every operation screen-time proportional to how long it runs.
  const playTimeRef = useRef(0);
  useEffect(() => {
    const path = getBuf().path;
    if (!playing || !path) return undefined;
    const totalT = path.totalTime || 1;
    // Resume from wherever the playhead sits (0 after a restart).
    playTimeRef.current = timeAt(path, useCamStore.getState().playhead);
    const perTick = (totalT * 0.04 / 15) * speed; // whole program ≈ 15 s at 1×
    const id = setInterval(() => {
      playTimeRef.current += perTick;
      const k = segmentAtTime(path, playTimeRef.current);
      useCamStore.getState().setPlayhead(k);
      useCamStore.setState({ playT: playTimeRef.current }); // smooth marker interpolation
      if (k >= path.count) useCamStore.getState().pause();
      invalidate(); // wake up the demand-mode canvas
    }, 40);
    return () => clearInterval(id);
  }, [playing, bufVer, speed]);

  // Drag-and-drop a real G-code file anywhere on the window.
  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) loadFile(file);
    },
    [loadFile]
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
  // Frame the camera to the cutting geometry (the part), not the rapid retracts.
  // Deliberately NOT keyed on bufVer: the values don't change as the sim carves,
  // and refitting on every playback tick was resetting the user's zoom.
  const fitBounds = useMemo(() => {
    if (!bounds) return null;
    const has = bounds.feedMin && Number.isFinite(bounds.feedMin[0]);
    const min = [...(has ? bounds.feedMin : bounds.min)];
    const max = [...(has ? bounds.feedMax : bounds.max)];
    if (turning) {
      // Turning backplot is one-sided in X (radius ≥ 0) and the part revolves, so
      // frame it symmetric about the spindle and pull back a little toward the
      // chuck end, so the whole setup is in view rather than zoomed onto a sliver.
      const r = Math.max(max[0], 1) * 1.5;
      min[0] = -r; max[0] = r;
      min[1] = -r; max[1] = r;
      min[2] -= 10;
    }
    return { min, max };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, turning]);

  // Chuck placement uses the *real* cutting bounds (not the padded fit), so the
  // 5 mm clearance to the deepest cut is preserved regardless of framing. The
  // chuck grips the **raw bar** diameter (turned OD + oversize) — the same
  // uniform bar the sim carves — so the whole bar reads as one stock size.
  const turnChuck = useMemo(() => {
    if (!turning || !bounds?.feedMin || !Number.isFinite(bounds.feedMin[0])) return null;
    return { z: bounds.feedMin[2], od: Math.max(bounds.feedMax[0] + stockOversize / 2, 1) };
  }, [bounds, turning, stockOversize]);
  // Tools auto-detected from the program's comments, and the one cutting now.
  const detectedTools = stats?.tools ?? [];
  const currentToolNum = useMemo(() => toolAt(path, playhead), [path, playhead, bufVer]);
  const currentTool = detectedTools.find((t) => t.n === currentToolNum) || null;
  // The tool marker follows the active cutter's real size/shape when known, so
  // it visibly shrinks from a Ø32 face mill to a Ø3 reamer as the program runs;
  // the slider is the fallback for tools the program never described.
  const currentOverride = toolOverrides[currentToolNum] || {};
  const markerRadius = (currentOverride.diameter != null
    ? currentOverride.diameter / 2
    : currentTool?.radius) ?? toolRadius;
  const markerType = currentOverride.simType ?? currentTool?.simType ?? toolType;
  // Gauge length (tip to collet) drives how far the milling marker sticks out.
  const markerLength = currentOverride.length ?? currentTool?.length ?? 0;
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

  // Rotary index (A/B degrees) at the playhead, so the tool marker can stand
  // normal to the face being cut instead of always pointing straight up +Z.
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
              <Space wrap>
                <Button
                  type="primary"
                  icon={<ThunderboltOutlined />}
                  loading={status === 'parsing'}
                  onClick={() => parse()}
                >
                  Parse
                </Button>
                <Upload
                  accept=".nc,.gcode,.gc,.tap,.cnc,.ngc,.txt,.mpf"
                  showUploadList={false}
                  beforeUpload={(file) => { loadFile(file); return false; }}
                >
                  <Button icon={<UploadOutlined />}>Open file</Button>
                </Upload>
                <Button
                  icon={<ReloadOutlined />}
                  onClick={() => parse(turning ? SAMPLE_TURNING : SAMPLE_GCODE)}
                >
                  Sample
                </Button>
              </Space>

              <Text style={{ color: '#475569', fontSize: 12 }}>
                …or drag &amp; drop a .nc / .gcode / .tap file anywhere
              </Text>

              <GcodePanel gcode={gcode} activeLine={activeLine} onChange={setGcode} />

              {error && <Alert type="error" showIcon message="Parse failed" description={error} />}

              {/* ---- Machine ---- */}
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

              {stats && (
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

              {warnings.length > 0 && (
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

              {detectedTools.length > 0 && (
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
                        || ov.length != null || ov.insert != null || ov.insertAngle != null;
                      const effDia = ov.diameter ?? t.diameter;
                      const effType = ov.simType ?? t.simType;
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
                                <Select
                                  size="small"
                                  value={holderId}
                                  onChange={(id) => setToolOverride(t.n, { insert: id })}
                                  style={{ width: 150 }}
                                  options={STANDARD_TURN_TOOLS.map((x) => ({ label: x.label, value: x.id }))}
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
                              <Segmented
                                size="small"
                                value={effType}
                                onChange={(v) => setToolOverride(t.n, { simType: v })}
                                options={[{ label: 'Flat', value: 'flat' }, { label: 'Ball', value: 'ball' }]}
                              />
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
                            <Button
                              size="small"
                              type="text"
                              onClick={() => clearToolOverride(t.n)}
                              style={{ color: '#64748b', padding: '0 4px' }}
                            >
                              reset
                            </Button>
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
                    <Tooltip title="Start from a bar 1 mm over the largest turned diameter and cut down to the programmed profile (sharp corner, follows the tool path).">
                      <Button
                        type="primary"
                        ghost
                        icon={<ExperimentOutlined />}
                        loading={simStatus === 'running'}
                        onClick={() => simulate()}
                      >
                        Simulate turning
                      </Button>
                    </Tooltip>
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

                  <Space wrap align="center">
                    <span style={{ color: '#94a3b8' }}>Tool ⌀</span>
                    <Space.Compact>
                      <InputNumber controls={false}
                        min={0.1}
                        step={0.5}
                        value={toolRadius * 2}
                        onChange={(v) => setTool({ toolRadius: (v || 0.2) / 2 })}
                        style={{ width: 80 }}
                      />
                      <span className="ant-input-group-addon" style={addonStyle('right')}>mm</span>
                    </Space.Compact>
                    <Segmented
                      value={toolType}
                      onChange={(v) => setTool({ toolType: v })}
                      options={[{ label: 'Flat', value: 'flat' }, { label: 'Ball', value: 'ball' }]}
                    />
                  </Space>
                  <Space align="center" wrap>
                    <span style={{ color: '#94a3b8' }}>Grid</span>
                    <Space.Compact>
                      <InputNumber controls={false}
                        min={0.1}
                        step={0.1}
                        value={cellSize}
                        onChange={(v) => setTool({ cellSize: v || 0.5 })}
                        style={{ width: 80 }}
                      />
                      <span className="ant-input-group-addon" style={addonStyle('right')}>mm</span>
                    </Space.Compact>
                  </Space>

                  {/* Billet definition — empty = auto-derived from the toolpath. */}
                  <Space align="center" wrap size="small">
                    <span style={{ color: '#94a3b8' }}>Stock</span>
                    <Tooltip title="Billet top Z (blank = highest move)">
                      <Space.Compact>
                        <span className="ant-input-group-addon" style={addonStyle('left')}>T</span>
                        <InputNumber controls={false}
                          placeholder="top auto"
                          value={stockTop}
                          onChange={(v) => setTool({ stockTop: v ?? null })}
                          style={{ width: 80 }}
                        />
                      </Space.Compact>
                    </Tooltip>
                    <Tooltip title="Billet bottom Z (blank = below deepest cut)">
                      <Space.Compact>
                        <span className="ant-input-group-addon" style={addonStyle('left')}>B</span>
                        <InputNumber controls={false}
                          placeholder="bot auto"
                          value={stockBase}
                          onChange={(v) => setTool({ stockBase: v ?? null })}
                          style={{ width: 80 }}
                        />
                      </Space.Compact>
                    </Tooltip>
                    <Tooltip title="XY overhang around the toolpath">
                      <Space.Compact>
                        <span className="ant-input-group-addon" style={addonStyle('left')}>M</span>
                        <InputNumber controls={false}
                          min={0}
                          value={stockMargin}
                          onChange={(v) => setTool({ stockMargin: v ?? 0 })}
                          style={{ width: 76 }}
                        />
                      </Space.Compact>
                    </Tooltip>
                  </Space>

                  <Space wrap>
                    <Tooltip title={rotaryIndices.length > 1
                      ? 'Multi-axis: carves every rotary face and every tool into one voxel block (undercuts included).'
                      : 'Carves the Z-up height field — scrub-able with playback.'}>
                      <Button
                        type="primary"
                        ghost
                        icon={<ExperimentOutlined />}
                        loading={simStatus === 'running'}
                        onClick={() => simulate()}
                      >
                        {rotaryIndices.length > 1 ? 'Simulate all faces' : 'Simulate'}
                      </Button>
                    </Tooltip>
                    <Tooltip title="Force the voxel sim (all faces + undercuts) at this resolution — smaller mm = finer, slower.">
                      <Space.Compact>
                        <Button
                          icon={<ExperimentOutlined />}
                          loading={simStatus === 'running'}
                          onClick={() => simulateVoxel()}
                        >
                          Voxel
                        </Button>
                        <InputNumber controls={false}
                          min={0.5}
                          step={0.5}
                          value={voxelSize}
                          onChange={(v) => setTool({ voxelSize: v || 1 })}
                          style={{ width: 70 }}
                        />
                        <span className="ant-input-group-addon" style={addonStyle('right')}>mm</span>
                      </Space.Compact>
                    </Tooltip>
                  </Space>
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
                Drop G-code file to load
              </div>
            )}

            {/* Bottom toolbar: view/plan selector and playback controls in one row. */}
            <div style={{
              position: 'absolute', bottom: 12, left: 12, right: 12, zIndex: 5,
              display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
              background: 'rgba(15,23,42,0.82)', border: '1px solid #334155',
              padding: '6px 12px', borderRadius: 8,
            }}>
              <Segmented size="small" value={view} onChange={setViewPreset} options={VIEWS} />
              <Tooltip title={sketching ? 'Fit sketch to view' : 'Fit toolpath to view'}>
                <Button size="small" icon={<ExpandOutlined />} onClick={() => setViewPreset(view)} />
              </Tooltip>
              {!sketching && <>
              <div style={{ width: 1, alignSelf: 'stretch', background: '#334155' }} />
              <Tooltip title="Restart">
                <Button
                  size="small" shape="circle"
                  icon={<StepBackwardOutlined />}
                  onClick={() => setPlayhead(0)}
                  disabled={count === 0}
                />
              </Tooltip>
              <Button
                type="primary" shape="circle"
                icon={playing ? <PauseCircleFilled /> : <PlayCircleFilled />}
                onClick={togglePlay}
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
              sketchFit={sketchFit}
              turnChuck={turnChuck}
              showStock={showStock}
              toolPos={toolPos}
              toolRotary={toolRotary}
              toolRadius={markerRadius}
              toolType={markerType}
              toolLength={markerLength}
              turnInsert={turnInsert}
              bufVer={bufVer}
              playhead={playhead}
              mode={sketching ? 'mill' : mode}
              sketching={sketching}
              view={view}
              viewNonce={viewNonce}
            />
          </Content>
        </Layout>
      </Layout>
    </div>
  );
}
