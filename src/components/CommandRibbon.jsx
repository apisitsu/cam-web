/**
 * CommandRibbon — the tabs by task and the labelled buttons under them, the layout
 * agreed in `docs/cadcam_layout_mockup.html`.
 *
 * Sketch, Mill and Turn are the app's three pages. Features is not a page: it swaps
 * the buttons and leaves the viewport as it is, because a part is built from a sketch
 * and looked at on a machine page, and either may be what is on screen.
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
import { useEffect, useState } from 'react';
import { Tooltip } from 'antd';
import { SettingOutlined, ThunderboltOutlined } from '@ant-design/icons';
import RibbonButton from './RibbonButton.jsx';
import BuildPanel, { useHasBuiltPart } from './BuildPanel.jsx';
import HolePanel from './HolePanel.jsx';
import { glyph } from './glyph.jsx';
import { useCamStore } from '../stores/camStore.js';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { useStdStore } from '../stores/stdStore.js';
import { useMeasureStore } from '../stores/measureStore.js';
import { command } from '../engine/view/commands.js';
import { CAD } from '../theme.js';

const TABS = [
  { value: 'features', label: 'Features' },
  { value: 'sketch', label: 'Sketch' },
  { value: 'mill', label: 'Mill' },
  { value: 'turn', label: 'Turn' },
];

const ExtrudedBossIcon = glyph(<><path d="M4 15l8 4 8-4v-5l-8 4-8-4z" /><path d="M4 10l8-4 8 4M12 14v5" /><path d="M12 2v5M9.5 4.5L12 2l2.5 2.5" /></>);
const ExtrudedCutIcon = glyph(<><path d="M4 15l8 4 8-4v-5l-8-4-8 4z" /><path d="M4 10l8 4 8-4M12 14v5" /><path d="M9 9l3 1.5L15 9l-3-1.5z" /></>);
const RevolvedBossIcon = glyph(<><path d="M6 3v18" strokeDasharray="3 2" /><path d="M6 6h6c3.5 0 5 2.5 5 6s-1.5 6-5 6H6" /><path d="M16 3l3 2.5-3.5 1" /></>);
const RevolvedCutIcon = glyph(<><path d="M6 3v18" strokeDasharray="3 2" /><path d="M6 6h6c3.5 0 5 2.5 5 6s-1.5 6-5 6H6" /><circle cx="13" cy="12" r="2.5" /></>);
const ToolTableIcon = glyph(<><path d="M9 3h6v9l-3 4-3-4z" /><path d="M12 16v5" /></>);
const RebuildIcon = glyph(<><path d="M19 9a8 8 0 10.5 5" /><path d="M19.5 4v5h-5" /></>);
const SuppressIcon = glyph(<><path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" /><path d="M4 20L20 4" /></>);
const WorkOriginIcon = glyph(<><path d="M6 19V5M6 19h14" /><circle cx="6" cy="19" r="2.2" /></>);
const SimulateIcon = glyph(<path d="M7 5l12 7-12 7z" />);
const PostIcon = glyph(<><path d="M4 7h16M4 12h10M4 17h13" /><path d="M17 11l3 3-3 3" /></>);
const StandardVcIcon = glyph(<><path d="M4 18a8 8 0 0116 0" /><path d="M12 18l4-6.5" /></>);

const HoleIcon = glyph(<><path d="M4 9l8-4 8 4-8 4z" /><path d="M4 9v7l8 4 8-4V9" /><ellipse cx="12" cy="9" rx="3" ry="1.5" fill="currentColor" /><path d="M9 9v6M15 9v6" opacity="0.6" /></>);
const MeasureIcon = glyph(<><path d="M3 15l12-12 6 6-12 12z" /><path d="M7 11l2 2M10 8l2 2M13 5l2 2" /></>);

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
        icon={<SettingOutlined />} label="Setup" onClick={onSetup} data-open-setup
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
        icon={<ThunderboltOutlined />} label={command('parse').label} data-cmd="parse"
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
      <Sep />
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

  // A page change from anywhere else, such as opening a project, moves the tabs too.
  useEffect(() => { setOnFeatures(false); }, [page]);

  const tab = onFeatures ? 'features' : page;
  const choose = (value) => {
    if (value === 'features') { setOnFeatures(true); return; }
    setOnFeatures(false);
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
        {(tab === 'mill' || tab === 'turn') && (
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
