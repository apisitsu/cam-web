/**
 * CommandRibbon — the tabs by task and the labelled buttons under them, the layout
 * agreed in `docs/cadcam_layout_mockup.html`.
 *
 * Sketch and CAM show the app's pages: CAM holds both machine pages, Milling and
 * Turning, picked by the switch at the head of its buttons. Features is not a page:
 * it swaps the buttons and leaves the viewport as it is, because a part is built
 * from a sketch and looked at on a machine page, and either may be what is on screen.
 *
 * The Sketch tab's buttons belong to `SketchToolbar`, which stays mounted and portals
 * them into the slot here. Hiding the slot, rather than unmounting the toolbar, is
 * what keeps a half-typed dimension alive while the operator looks at another tab.
 *
 * **Only commands that exist are here.** The mockup also draws Fillet, Pattern,
 * Section View and more, and the app has none of them. A button that does
 * nothing teaches people to stop trying the buttons.
 *
 * The four feature buttons open `BuildPanel` already set to what they name. The Sketch
 * tab's Build keeps the full panel, for New and Common, which have no button here.
 */
import { useEffect, useRef, useState } from 'react';
import { Segmented, Tooltip } from 'antd';
import { UndoOutlined, RedoOutlined } from '@ant-design/icons';
import RibbonButton from './RibbonButton.jsx';
import BuildPanel, { useHasBuiltPart } from './BuildPanel.jsx';
import HolePanel from './HolePanel.jsx';
import { glyph, INK } from './glyph.jsx';
import { useCamStore } from '../stores/camStore.js';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { useStdStore } from '../stores/stdStore.js';
import { useMeasureStore } from '../stores/measureStore.js';
import { useEdgeTreatStore } from '../stores/edgeTreatStore.js';
import { command } from '../engine/view/commands.js';
import { CAD } from '../theme.js';

const TABS = [
  { value: 'features', label: 'Features' },
  { value: 'sketch', label: 'Sketch' },
  { value: 'cam', label: 'CAM' },
];

const MACHINE_PAGES = [
  { value: 'mill', label: 'Milling' },
  { value: 'turn', label: 'Turning' },
];
const isMachinePage = (page) => page === 'mill' || page === 'turn';

// Yellow is a solid, red what a cut takes away, green the way it goes (`INK`).
const ExtrudedBossIcon = glyph(<>
  <path d="M4 12l8 4 8-4v5l-8 4-8-4z" fill={INK.body} />
  <path d="M4 12l8-4 8 4-8 4z" fill={INK.bodyTop} />
  <path d="M12 16v5" />
  <path d="M12 1.5v8M8.8 4.7L12 1.5l3.2 3.2" stroke={INK.go} strokeWidth="2.4" />
</>);
const ExtrudedCutIcon = glyph(<>
  <path d="M4 12l8 4 8-4v5l-8 4-8-4z" fill={INK.steel} />
  <path d="M4 12l8-4 8 4-8 4z" fill={INK.steelTop} />
  <path d="M8 12l4-2 4 2-4 2z" fill={INK.cut} stroke={INK.cut} />
  <path d="M12 16v5" />
  <path d="M12 1v8M8.8 5.8L12 9l3.2-3.2" stroke={INK.cut} strokeWidth="2.4" />
</>);
const RevolvedBossIcon = glyph(<>
  <path d="M6 4h5c4 0 6 3 6 7.5S15 19 11 19H6z" fill={INK.body} />
  <path d="M6 2v20" strokeDasharray="3 2" />
  <path d="M15.5 2.5a6 2.2 0 0 1 5 3.5" stroke={INK.go} strokeWidth="2.2" />
  <path d="M18 6.4l2.6-.4.2-2.6" stroke={INK.go} strokeWidth="2.2" />
</>);
const RevolvedCutIcon = glyph(<>
  <path d="M6 4h11v15H6z" fill={INK.steel} />
  <path d="M17 8.5a3 3 0 0 0 0 6z" fill={INK.cut} stroke={INK.cut} />
  <path d="M6 2v20" strokeDasharray="3 2" />
  <path d="M15.5 2.5a6 2.2 0 0 1 5 3.5" stroke={INK.cut} strokeWidth="2.2" />
</>);
const ToolTableIcon = glyph(<>
  <rect x="2.5" y="4" width="11" height="16" rx="1" fill={INK.paper} />
  <path d="M5 8.5h6M5 12h6M5 15.5h6" stroke={INK.sketch} />
  <path d="M16 2h4v7h-4z" fill={INK.steel} />
  <path d="M16 9h4v8l-2 3-2-3z" fill={INK.sketchSoft} />
  <path d="M16 12l4-1.5M16 15l4-1.5" />
</>);
const RebuildIcon = glyph(<>
  <path d="M19 9a8 8 0 10.5 5" stroke={INK.go} strokeWidth="2.4" />
  <path d="M19.5 3.5v5.5H14" stroke={INK.go} strokeWidth="2.4" />
</>);
const SuppressIcon = glyph(<>
  <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" fill={INK.paper} />
  <circle cx="12" cy="12" r="2.6" fill="currentColor" />
  <path d="M4 20L20 4" stroke={INK.cut} strokeWidth="2.4" />
</>);
const WorkOriginIcon = glyph(<>
  <path d="M6 18h14M17.5 15.6L20 18l-2.5 2.4" stroke={INK.x} strokeWidth="2.2" />
  <path d="M6 18V3M3.6 5.5L6 3l2.4 2.5" stroke={INK.z} strokeWidth="2.2" />
  <path d="M6 18l7-7M9.8 11h3.2v3.2" stroke={INK.y} strokeWidth="2.2" />
  <circle cx="6" cy="18" r="2.2" fill="currentColor" />
</>);
const SimulateIcon = glyph(<path d="M7 4.5l13 7.5-13 7.5z" fill={INK.go} stroke={INK.go} />);
const PostIcon = glyph(<>
  <path d="M4 2.5h10l4 4V21.5H4z" fill={INK.paper} />
  <path d="M7 9h7M7 12.5h5M7 16h6" stroke={INK.sketch} />
  <path d="M15 15.5h7M19 12.5l3 3-3 3" stroke={INK.go} strokeWidth="2.2" />
</>);
const StandardVcIcon = glyph(<>
  <path d="M4 18a8 8 0 0 1 2.3-5.7" stroke={INK.go} strokeWidth="3" />
  <path d="M6.3 12.3A8 8 0 0 1 17.7 12.3" stroke={INK.warn} strokeWidth="3" />
  <path d="M17.7 12.3A8 8 0 0 1 20 18" stroke={INK.cut} strokeWidth="3" />
  <path d="M12 18l3.5-6" strokeWidth="2.2" />
  <circle cx="12" cy="18" r="1.6" fill="currentColor" />
</>);

const HoleIcon = glyph(<>
  <path d="M3 9.5l9-4.5 9 4.5v7L12 21l-9-4.5z" fill={INK.steel} />
  <path d="M3 9.5L12 14l9-4.5-9-4.5z" fill={INK.steelTop} />
  <ellipse cx="12" cy="9.5" rx="3.6" ry="1.8" fill={INK.cut} stroke={INK.cut} />
  <path d="M8.4 9.5v6.5M15.6 9.5v6.5" stroke={INK.cut} strokeDasharray="2 1.6" />
</>);
// A block's corner seen end-on: cut off flat, and rounded — the treated face lit.
const ChamferIcon = glyph(<>
  <path d="M3 21V10l7-7h11v18z" fill={INK.steel} />
  <path d="M3 10l7-7" stroke={INK.cut} strokeWidth="2.6" />
</>);
const FilletIcon = glyph(<>
  <path d="M3 21V12a9 9 0 0 1 9-9h9v18z" fill={INK.steel} />
  <path d="M3 12a9 9 0 0 1 9-9" stroke={INK.cut} strokeWidth="2.6" />
</>);
const MeasureIcon = glyph(<>
  <path d="M3 15l12-12 6 6-12 12z" fill={INK.body} />
  <path d="M7 11l2 2M10 8l2 2M13 5l2 2" />
</>);
const ParseIcon = glyph(<path d="M13.5 2L5 13.5h6L9.5 22 19 9.5h-6.2z" fill={INK.warn} stroke={INK.warn} />);
const SetupIcon = glyph(<>
  <path d="M4 10l8-4 8 4-8 4z" fill={INK.steelTop} />
  <path d="M4 10v6l8 4 8-4v-6" fill={INK.steel} />
  <path d="M4 10l8 4 8-4" />
  <path d="M12 1.5v5M9.5 4L12 1.5 14.5 4" stroke={INK.z} strokeWidth="2" />
</>);

const Sep = () => <div style={{ width: 1, alignSelf: 'stretch', margin: '4px 5px', background: CAD.border }} />;

/** Measure, on every tab that shows the part. On while it is lit. */
function MeasureCommand() {
  const active = useMeasureStore((s) => s.active);
  const toggle = useMeasureStore((s) => s.toggle);
  const hasPart = useCamPlanStore((s) => Boolean(s.analysis));
  return (
    <Command
      icon={<MeasureIcon />} label="Measure" active={active} disabled={!hasPart} onClick={toggle}
      tip={hasPart ? 'Click a face, a bore or a boss — one for its size, two for the distance between' : 'Build or import a part first'}
    />
  );
}

function Command({ tip, ...button }) {
  return (
    <Tooltip title={tip} placement="bottom">
      <RibbonButton {...button} />
    </Tooltip>
  );
}

/** The buttons for a machine page. The two differ only in what they say about simulating. */
function MachineCommands({
  onSetup, onWorkOrigin, onToolTable, hasTools, onExportGcode,
  simulateCommand = { id: 'simulate', icon: <SimulateIcon /> },
}) {
  const gcode = useCamStore((s) => s.gcode);
  const status = useCamStore((s) => s.status);
  const simStatus = useCamStore((s) => s.simStatus);
  const parse = useCamStore((s) => s.parse);
  const simulate = useCamStore((s) => s.simulate);
  const hasPart = useCamPlanStore((s) => Boolean(s.analysis));
  const checkStd = useStdStore((s) => s.check);

  return (
    <>
      <Command
        icon={<SetupIcon />} label="Setup" onClick={onSetup} data-open-setup
        tip="Files, machine, tooling, stock and the removal simulation"
      />
      <Command
        icon={<WorkOriginIcon />} label="Work Origin" onClick={onWorkOrigin} disabled={!hasPart}
        tip={hasPart ? 'Set X0, Y0 and Z0 on the part' : 'Import a part first'}
      />
      <MeasureCommand />
      <Command
        icon={<ToolTableIcon />} label="Tool Table" onClick={onToolTable} disabled={!hasTools}
        tip={hasTools ? 'The tools this program uses, each one editable' : 'Parse a program that names its tools first'}
      />
      <Sep />
      <Command
        icon={<ParseIcon />} label={command('parse').label} data-cmd="parse"
        aria-label={command('parse').label} onClick={() => parse()} loading={status === 'parsing'} tip={command('parse').hint}
      />
      <Command
        icon={simulateCommand.icon} label={command(simulateCommand.id).label} data-cmd={simulateCommand.id}
        aria-label={command(simulateCommand.id).label} accent onClick={() => simulate()} loading={simStatus === 'running'} disabled={!gcode}
        tip={command(simulateCommand.id).hint}
      />
      <Command
        icon={<PostIcon />} label="Post G-code" onClick={onExportGcode} disabled={!gcode}
        tip="Download the program as a .nc, to hand on to a machine"
      />
      <Command
        icon={<StandardVcIcon />} label="Standard Vc" onClick={() => checkStd({ manual: true })} disabled={!gcode}
        tip="Check this program's cutting speeds against the shop's standard"
      />
    </>
  );
}

function FeatureCommands() {
  const features = useFeatureStore((s) => s.features);
  const selectedId = useFeatureStore((s) => s.selectedId);
  const dirty = useFeatureStore((s) => s.dirty);
  const rebuild = useFeatureStore((s) => s.rebuild);
  const toggleSuppress = useFeatureStore((s) => s.toggleSuppress);
  const startEdgeTreatment = useFeatureStore((s) => s.startEdgeTreatment);
  const undo = useFeatureStore((s) => s.undo);
  const redo = useFeatureStore((s) => s.redo);
  const canUndo = useFeatureStore((s) => s.past.length > 0);
  const canRedo = useFeatureStore((s) => s.future.length > 0);
  const building = useFeatureStore((s) => s.building);
  const treating = useEdgeTreatStore((s) => s.active);
  const selected = features.find((f) => f.id === selectedId);
  const hasPart = useHasBuiltPart();

  const feature = (preset, Icon, tip) => (
    <BuildPanel
      preset={preset}
      trigger={(
        <Tooltip
          title={preset.cut && !hasPart ? 'Build a part first: a cut needs something to cut' : tip}
          placement="bottom"
        >
          <RibbonButton
            icon={<Icon />}
            label={preset.name}
            accent={!preset.cut}
            disabled={preset.cut && !hasPart}
          />
        </Tooltip>
      )}
    />
  );

  return (
    <>
      {feature(
        { name: 'Extruded Boss/Base', op: 'extrude', cut: false },
        ExtrudedBossIcon,
        'Extrude the active sketch into a solid, joined to the part if there is one',
      )}
      {feature(
        { name: 'Revolved Boss/Base', op: 'revolve', cut: false },
        RevolvedBossIcon,
        'Revolve the active sketch into a solid, joined to the part if there is one',
      )}
      <Sep />
      {feature(
        { name: 'Extruded Cut', op: 'extrude', cut: true },
        ExtrudedCutIcon,
        'Extrude the active sketch and remove it from the part',
      )}
      {feature(
        { name: 'Revolved Cut', op: 'revolve', cut: true },
        RevolvedCutIcon,
        'Revolve the active sketch and remove it from the part',
      )}
      <HolePanel
        trigger={(
          <Tooltip
            title={hasPart ? 'Drilled, tapped, counterbored or countersunk holes at the sketch\'s points' : 'Build a part first: a hole needs something to go into'}
            placement="bottom"
          >
            <RibbonButton icon={<HoleIcon />} label="Hole Wizard" disabled={!hasPart} />
          </Tooltip>
        )}
      />
      <Command
        icon={<FilletIcon />} label="Fillet" disabled={!hasPart} accent={treating === 'fillet'}
        onClick={() => startEdgeTreatment('fillet')}
        tip={hasPart ? 'Round the edges you click on the part' : 'Build a part first: a fillet needs edges'}
      />
      <Command
        icon={<ChamferIcon />} label="Chamfer" disabled={!hasPart} accent={treating === 'chamfer'}
        onClick={() => startEdgeTreatment('chamfer')}
        tip={hasPart ? 'Bevel the edges you click on the part' : 'Build a part first: a chamfer needs edges'}
      />
      <Sep />
      <Command
        icon={<UndoOutlined />} label="Undo" disabled={!canUndo || building}
        onClick={() => undo()}
        tip="Take back the last change to the feature tree (Ctrl+Z when no sketch is open)"
      />
      <Command
        icon={<RedoOutlined />} label="Redo" disabled={!canRedo || building}
        onClick={() => redo()}
        tip="Put back the change Undo took away (Ctrl+Y)"
      />
      <Command
        icon={<RebuildIcon />} label="Rebuild" accent={dirty} disabled={!features.length}
        onClick={() => rebuild()}
        tip={dirty ? 'The part is out of date: replay the tree' : 'Replay the feature tree'}
      />
      <Command
        icon={<SuppressIcon />} label={selected?.suppressed ? 'Unsuppress' : 'Suppress'}
        disabled={!selected} onClick={() => toggleSuppress(selected.id)}
        tip={selected ? `Leave ${selected.name} out of the part, or put it back` : 'Select a feature in the tree first'}
      />
      <Sep />
      <MeasureCommand />
    </>
  );
}

export default function CommandRibbon({
  setRibbonSlot, onSetup, onWorkOrigin, onToolTable, hasTools = false, onExportGcode, simulateCommand,
}) {
  const page = useCamStore((s) => s.page);
  const setPage = useCamStore((s) => s.setPage);
  const parsing = useCamStore((s) => s.status === 'parsing');
  const [onFeatures, setOnFeatures] = useState(false);
  // CAM comes back to the machine page it was last on.
  const lastMachine = useRef(isMachinePage(page) ? page : 'mill');
  if (isMachinePage(page)) lastMachine.current = page;

  // A page change from anywhere else, such as opening a project, moves the tabs too.
  useEffect(() => { setOnFeatures(false); }, [page]);

  const pageTab = isMachinePage(page) ? 'cam' : page;
  const tab = onFeatures ? 'features' : pageTab;
  const choose = (value) => {
    if (value === 'features') { setOnFeatures(true); return; }
    setOnFeatures(false);
    if (value === 'cam') {
      if (!isMachinePage(page)) setPage(lastMachine.current);
      return;
    }
    if (value !== page) setPage(value);
  };

  return (
    <div data-cam-ribbon style={{ flex: '0 0 auto' }}>
      <div
        role="tablist"
        style={{
          display: 'flex', gap: 2, padding: '4px 10px 0',
          background: CAD.headerBg, borderBottom: `1px solid ${CAD.border}`,
        }}
      >
        {TABS.map((t) => {
          const active = t.value === tab;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              data-ribbon-tab={t.value}
              disabled={parsing && t.value !== 'features'}
              onClick={() => choose(t.value)}
              style={{
                padding: '5px 14px 6px',
                marginBottom: -1,
                fontSize: 12,
                fontFamily: 'inherit',
                cursor: 'pointer',
                color: active ? CAD.text : CAD.label,
                fontWeight: active ? 600 : 400,
                background: active ? CAD.panelBg : 'transparent',
                border: `1px solid ${active ? CAD.border : 'transparent'}`,
                borderBottomColor: active ? CAD.panelBg : 'transparent',
                borderRadius: '3px 3px 0 0',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 2, minHeight: 62,
        // The Sketch rail brings its own padding and rule along.
        padding: tab === 'sketch' ? 0 : '4px 10px',
        background: CAD.panelBg,
        borderBottom: tab === 'sketch' ? 'none' : `1px solid ${CAD.border}`,
      }}
      >
        {tab === 'features' && <FeatureCommands />}
        {tab === 'cam' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', alignSelf: 'stretch', paddingRight: 4 }}>
              <Segmented
                size="small"
                vertical
                options={MACHINE_PAGES}
                value={page}
                disabled={parsing}
                onChange={(value) => setPage(value)}
                data-cam-process
              />
            </div>
            <Sep />
          </>
        )}
        {tab === 'cam' && (
          <MachineCommands
            onSetup={onSetup}
            onWorkOrigin={onWorkOrigin}
            onToolTable={onToolTable}
            hasTools={hasTools}
            onExportGcode={onExportGcode}
            simulateCommand={simulateCommand}
          />
        )}
        <div
          ref={setRibbonSlot}
          data-ribbon-slot
          style={{ flex: '1 1 100%', minWidth: 0, display: tab === 'sketch' ? 'block' : 'none' }}
        />
      </div>
    </div>
  );
}
