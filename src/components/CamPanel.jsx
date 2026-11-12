/**
 * CamPanel — the STL → plan → NC workflow, as UI.
 *
 * Deliberately thin. Every number shown here was computed in `engine/cam`, and
 * the component's only jobs are to render it, to dispatch the operator's edits,
 * and to hand the result on. Anything that looks like a calculation in this
 * file belongs downstairs instead.
 *
 * The workflow runs in the order the work does: **import, look, pick, cut.**
 * Importing measures the part and nothing more. A plan is then started one of
 * two ways, side by side: **Auto Toolpath** plans the whole part (and replaces the
 * whole recipe), **Manual Toolpath** adds one operation at a time — chosen from a
 * list, or by clicking a face or edge on the model.
 *
 * Three things the planner cannot infer from geometry are chosen here:
 *
 * - the **machine**, by make and model — which decides the process, the
 *   spindle and feed limits, and the control the program is posted for;
 * - the **material**;
 * - the **operations and their tools** — the planner proposes, the operator
 *   disposes. Every row can be re-tooled, disabled, reordered or deleted, and
 *   operations the planner did not propose can be added.
 *
 * The `why` column is not decoration: a chosen tool that cannot explain itself
 * is one an operator has no way to sanity-check, so every step carries the
 * measurement that drove it — regenerated from the tool actually in use, not
 * from the one the planner first suggested.
 */
import React from 'react';
import {
  Upload, Button, Space, Select, Table, Alert, Tag, Typography, Descriptions,
  Divider, Switch, Tooltip, Empty, InputNumber, Collapse, Modal, Segmented,
} from 'antd';
import {
  DownloadOutlined, SendOutlined, CloseOutlined,
  ArrowUpOutlined, ArrowDownOutlined, DeleteOutlined, PlusOutlined,
  ReloadOutlined, RollbackOutlined,
} from '@ant-design/icons';
import CommandButton from './CommandButton.jsx';
import {
  PartIcon, AutoPlanIcon, ClearFaceIcon, ContourIcon, A0FaceIcon, RotaryCentreIcon,
} from './glyph.jsx';
import { useFeatureStore } from '../stores/featureStore.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { MATERIALS } from '../engine/cam/library.js';
import {
  machineById, machinesByBrand, axisLabel, travelLabel,
} from '../engine/cam/machines.js';
import { axisSummary, fitWarnings } from '../engine/cam/envelope.js';
import { operationKind, CUT_SETTINGS } from '../engine/cam/recipe.js';
import { describeFace, describeEdge } from '../engine/mesh/features.js';
import { flipOf } from '../engine/mesh/datum.js';
import { visibleFeatures, hiddenNote } from '../engine/view/featureList.js';
import { PART_ACCEPT, PART_FORMATS } from '../engine/mesh/import.js';
import { dialectFor } from '../engine/cam/post/dialect.js';
import { CAD } from '../theme.js';

const { Text, Title } = Typography;

const MODE_LABEL = { turn: 'Turning', mill: 'Milling' };

/** Trigger a browser download of the NC text. */
function downloadNc(text, name) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Where on the part a check result is, in the coordinates the program uses. */
function whereAt(at) {
  if (!at) return '';
  return at.length === 1
    ? ` near Z${at[0].toFixed(1)}`
    : ` near X${at[0].toFixed(1)} Y${at[1].toFixed(1)}`;
}

/**
 * The result of checking the program against the part (`verifyCut`).
 *
 * Shown under every plan, so a program that cuts into the part says so before
 * anyone exports it.
 */
function CutCheck({ verification }) {
  if (!verification) {
    return <Text type="secondary" style={{ fontSize: 11 }} data-cut-check="pending">Checking the cut against the part…</Text>;
  }
  if (verification.ok === null) {
    return (
      <Alert type="info" showIcon data-cut-check="skipped" message="Cut not checked" description={verification.skipped} />
    );
  }
  const { gouge, excess, cellSize } = verification;
  const grid = `Checked on a ${cellSize} mm grid.`;
  if (!verification.ok) {
    return (
      <Alert
        type="error"
        showIcon
        data-cut-check="gouge"
        message={`Cuts into the part: up to ${gouge.max} mm${whereAt(gouge.at)}`}
        description={`${gouge.volume} mm³ of the part is removed. Find the step that does it before cutting. ${grid}`}
      />
    );
  }
  return (
    <Alert
      type="success"
      showIcon
      data-cut-check="ok"
      message="No cut into the part"
      description={excess.max > 0
        ? `Up to ${excess.max} mm is left on${whereAt(excess.at)}: finishing allowance, or what a round cutter cannot reach. ${grid}`
        : `Nothing is left on. ${grid}`}
    />
  );
}

/** Operations aimed by picking on the model, below, rather than chosen from the list. */
const PICKED_ON_MODEL = new Set(['face', 'edge']);

/**
 * Manual Toolpath: add operations one at a time, each aimed at what it asks for —
 * a group of holes, a sketch and a depth, or a face or edge clicked on the model.
 * The other way to start a plan is Auto Toolpath, which plans the whole part.
 */
function ManualToolpath({
  detected, pickable, selectedFeature, onSelect, onPreview, onAddFace, onAddEdge,
}) {
  // Re-read whenever a sketch changes.
  useSketchStore((s) => s.version);
  const addableKinds = useCamPlanStore((s) => s.addableKinds);
  const targetChoices = useCamPlanStore((s) => s.targetChoices);
  const addStep = useCamPlanStore((s) => s.addStep);
  const sketchList = useCamPlanStore((s) => s.sketchList);
  const addSketchStep = useCamPlanStore((s) => s.addSketchStep);
  const addFaceShapeStep = useCamPlanStore((s) => s.addFaceShapeStep);
  const faceDepth = useCamPlanStore((s) => s.faceDepth);
  const [kind, setKind] = React.useState(null);
  const [choice, setChoice] = React.useState(0);
  const [sketchId, setSketchId] = React.useState(null);
  const [depth, setDepth] = React.useState(5);
  const [side, setSide] = React.useState('outside');
  // Where a pocket/profile takes its shape from: a sketch, or a face clicked on the model.
  const [source, setSource] = React.useState('sketch');
  const [pass, setPass] = React.useState('rough');

  const kinds = addableKinds().filter((k) => !PICKED_ON_MODEL.has(k.needs));
  const meta = kinds.find((k) => k.kind === kind) ?? kinds[0];
  const choices = meta ? targetChoices(meta.kind) : null;
  const chosen = choices?.find((c) => c.value === choice) ?? choices?.[0];
  const sketchStep = meta?.needs === 'sketch';
  const sketches = sketchList().filter((s) => s.closed);
  const sketch = sketches.find((s) => s.id === sketchId) ?? sketches[0];
  const fromFace = sketchStep && source === 'face';
  const face = selectedFeature?.facing !== undefined ? selectedFeature : null;

  // Picking a face fills in the depth down to it; the operator can still change it.
  React.useEffect(() => {
    if (!fromFace || !face) return;
    const d = faceDepth(face.id);
    if (d > 0) setDepth(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromFace, face?.id]);

  let blocked = null;
  if (choices && !chosen) blocked = 'This part has none of these.';
  if (sketchStep && !fromFace && !sketch) blocked = 'Draw a closed profile in a sketch first — or use Face.';
  if (fromFace && !face) blocked = 'Click a flat face on the model (or pick one in the list below).';
  if (fromFace && face && face.facing !== 'up') blocked = `That face points ${face.facing} — pick one facing the spindle.`;

  const add = () => {
    if (fromFace) return addFaceShapeStep(meta.kind, face.id, { depth, side, pass });
    if (sketchStep) return addSketchStep(meta.kind, sketch.id, { depth, side, pass });
    return addStep(meta.kind, chosen?.target ?? undefined);
  };

  return (
    <div
      data-manual-toolpath
      style={{ border: `1px solid ${CAD.border}`, borderRadius: 6, padding: '8px 10px' }}
    >
      <Text style={{ color: CAD.label, fontSize: 11 }}>Manual Toolpath — one operation at a time</Text>
      <Space wrap size={6} style={{ marginTop: 6, display: 'flex' }}>
        <Select
          size="small"
          style={{ width: 170 }}
          value={meta?.kind}
          onChange={(v) => { setKind(v); setChoice(0); }}
          options={kinds.map((k) => ({ value: k.kind, label: k.label }))}
          data-manual-kind
        />
        {choices && chosen && (
          <Select
            size="small"
            style={{ width: 150 }}
            value={chosen.value}
            onChange={setChoice}
            options={choices.map((c) => ({ value: c.value, label: c.label }))}
          />
        )}
        {sketchStep && (
          <>
            <Segmented
              size="small"
              value={source}
              onChange={setSource}
              options={[{ value: 'sketch', label: 'Sketch' }, { value: 'face', label: 'Face' }]}
              data-manual-source
            />
            {!fromFace && sketch && (
              <Select
                size="small"
                style={{ width: 110 }}
                value={sketch.id}
                onChange={setSketchId}
                options={sketches.map((s) => ({ value: s.id, label: s.name }))}
              />
            )}
            {fromFace && face && <Tag style={{ margin: 0 }}>Face {face.id}</Tag>}
            <InputNumber
              size="small"
              style={{ width: 110 }}
              min={0.1}
              step={0.5}
              value={depth}
              onChange={(v) => setDepth(Number(v) || depth)}
              addonBefore="Depth"
            />
            {meta.kind === 'profile' && (
              <Segmented
                size="small"
                value={side}
                onChange={setSide}
                options={[{ value: 'outside', label: 'Outside' }, { value: 'inside', label: 'Inside' }]}
              />
            )}
            <Tooltip title="Rough leaves 0.2 mm for a finish pass (change it in the table). Rough + Finish adds both steps.">
              <Segmented
                size="small"
                value={pass}
                onChange={setPass}
                options={[
                  { value: 'rough', label: 'Rough' },
                  { value: 'finish', label: 'Finish' },
                  { value: 'both', label: 'Rough + Finish' },
                ]}
                data-manual-pass
              />
            </Tooltip>
          </>
        )}
        <CommandButton
          id="addOperation"
          size="small"
          type="primary"
          icon={<PlusOutlined />}
          disabled={!meta || Boolean(blocked)}
          onClick={add}
        />
      </Space>
      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
        {blocked ?? (sketchStep
          ? (fromFace
            ? `${meta.hint} Depth is measured from the top of the stock.`
            : `${meta.hint} The sketch must lie flat on top of the setup.`)
          : meta?.hint)}
      </Text>

      {pickable && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <Text style={{ color: CAD.label, fontSize: 11 }}>
            Pick a face or edge — click the model, or a row below
          </Text>
          <div style={{ marginTop: 6 }}>
            <SelectionActions
              feature={selectedFeature}
              onAddFace={onAddFace}
              onAddEdge={onAddEdge}
              onClear={() => onSelect(null)}
            />
          </div>
          <FeaturePicker
            features={detected}
            selected={selectedFeature}
            onSelect={onSelect}
            onPreview={onPreview}
          />
        </>
      )}
    </div>
  );
}

/**
 * A number the planner works out but the operator may overrule: shows the value
 * in use, commits on Enter / leaving the box (each change rebuilds the program),
 * and an emptied box goes back to automatic.
 */
function StepNumber({ label, value, own, onCommit, title }) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => { setDraft(value); }, [value]);
  const commit = () => {
    if (draft === value && own) return;
    if (draft == null) { if (own) onCommit(null); return; }
    if (draft !== value) onCommit(draft);
  };
  return (
    <Tooltip title={`${title} ${own ? 'Set by you — clear the box to go back to automatic.' : 'Automatic from the tool and material — type a number to change it.'}`}>
      <Space.Compact size="small">
        <span className="ant-input-group-addon" style={{ fontSize: 11, padding: '0 4px', whiteSpace: 'nowrap', width: 70, textAlign: 'left' }}>{label}</span>
        <InputNumber
          size="small"
          controls={false}
          min={0}
          step={0.1}
          value={draft}
          onChange={setDraft}
          onBlur={commit}
          onPressEnter={commit}
          style={{ width: 52, fontWeight: own ? 600 : 400, color: own ? undefined : CAD.muted }}
        />
      </Space.Compact>
    </Tooltip>
  );
}

const round2 = (v) => (Number.isFinite(v) ? Number(v.toFixed(2)) : null);

/** Rough / Finish, and for a rough pass its depth step, side step and stock to leave. */
function CutSettings({ row, onChange }) {
  const spec = CUT_SETTINGS[row.kind];
  const cut = row.step?.cut;
  if (!spec || !cut || !row.enabled) return null;
  const own = row.params ?? {};
  const pass = spec.pass === 'choose' ? (own.pass ?? cut.pass) : spec.pass;
  return (
    <Space direction="vertical" size={2} style={{ marginTop: 2 }} data-cut-settings>
      {spec.pass === 'choose' ? (
        <Segmented
          size="small"
          value={pass}
          onChange={(v) => onChange({ pass: v })}
          options={[{ value: 'rough', label: 'Rough' }, { value: 'finish', label: 'Finish' }]}
        />
      ) : (
        <Tag style={{ margin: 0 }}>{pass === 'rough' ? 'Rough' : 'Finish'}</Tag>
      )}
      {pass === 'rough' && (
        <>
          <StepNumber
            label="Depth step"
            value={round2(cut.stepdown)}
            own={own.stepdown != null}
            onCommit={(v) => onChange({ stepdown: v })}
            title="How deep each level cuts (mm)."
          />
          {spec.stepover && (
            <StepNumber
              label="Side step"
              value={round2(cut.stepover)}
              own={own.stepover != null}
              onCommit={(v) => onChange({ stepover: v })}
              title="How far each pass moves sideways (mm)."
            />
          )}
          {spec.leave && (
            <StepNumber
              label="Leave"
              value={round2(cut.leave ?? 0)}
              own={own.leave != null}
              onCommit={(v) => onChange({ leave: v })}
              title="Stock left on the walls and floor for the finish pass (mm)."
            />
          )}
        </>
      )}
    </Space>
  );
}

/** A skipped row has no built step to take a title from, so name it by kind. */
function titleFor(row, mode) {
  return operationKind(row.kind, mode ?? 'mill')?.label ?? row.kind;
}

/**
 * A step's tool picker.
 *
 * Tools that do not fit are shown disabled with the reason, never hidden — a
 * dropdown missing half the crib reads as broken, and "why can't I pick the
 * Ø16?" is exactly the question the planner should be answering out loud.
 */
function ToolSelect({ step, choices, onChange }) {
  const options = choices.map(({ tool, fits, reason }) => ({
    value: tool.id,
    disabled: !fits,
    label: fits
      ? tool.label
      : <Tooltip title={reason}><span>{tool.label}</span></Tooltip>,
  }));
  return (
    <Select
      size="small"
      variant="borderless"
      style={{ width: '100%', marginLeft: -8 }}
      value={step.toolId}
      options={options}
      onChange={onChange}
      popupMatchSelectWidth={280}
    />
  );
}

/**
 * The faces and edges of the part, as a list to pick from — **closed by default.**
 *
 * The model itself is now the primary way to pick: hovering it highlights what a
 * click would take, and an edge under the cursor wins over the face behind it
 * (`PartMesh` + `engine/mesh/pickEdge.js`). Two long lists open on the panel were
 * noise once that worked, so they start collapsed and the headers stay as a
 * count.
 *
 * They are collapsed and not deleted, and the distinction is the point: picking
 * in 3D is only possible for a face you can *see*. A pocket floor under an
 * overhang, the underside, the face currently pointing away from the camera —
 * none of those has a cursor position, and the list is the only thing that
 * reaches them. Hovering a row still highlights it, exactly as before.
 */
/**
 * The pickable faces and edges, as a list.
 *
 * Memoised, and deliberately: the panel re-renders on every store change —
 * including the `planning → ready` status flip each rebuild causes — while this
 * list only ever depends on the detected features and the current selection.
 * Without the memo, changing the material reconciled every row here, which is
 * what made settings feel slow on a curvy part. `features` is reference-stable
 * because `detectFeatures` caches against the mesh, so the memo actually hits.
 */
const FeaturePicker = React.memo(function FeaturePicker({ features, selected, onSelect, onPreview }) {
  const { faces = [], edges = [] } = features;
  if (faces.length === 0 && edges.length === 0) return null;

  // Only the biggest are drawn; the rest stay pickable on the model itself.
  const shownFaces = visibleFeatures(faces);
  const shownEdges = visibleFeatures(edges);
  const more = (hidden, noun) => {
    const note = hiddenNote(hidden, noun);
    return note && (
      <Text type="secondary" style={{ fontSize: 11, display: 'block', padding: '4px 4px 0' }}>
        {note}
      </Text>
    );
  };

  const row = (item, label, reachable) => (
    <div
      key={item.id}
      onClick={() => onSelect(item)}
      onMouseEnter={() => onPreview(item)}
      onMouseLeave={() => onPreview(null)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px',
        borderRadius: 4, cursor: 'pointer',
        background: selected?.id === item.id ? CAD.selected : 'transparent',
      }}
    >
      <Tag style={{ margin: 0, minWidth: 34, textAlign: 'center' }}>{item.id}</Tag>
      <Text style={{ flex: 1, fontSize: 11, color: reachable ? CAD.icon : CAD.muted }}>
        {label}
      </Text>
      {!reachable && (
        <Tooltip title="Not reachable along the tool axis from this index — turn the table first">
          <Tag color="orange" style={{ margin: 0 }}>tilt</Tag>
        </Tooltip>
      )}
    </div>
  );

  return (
    <Collapse
      size="small"
      ghost
      // Closed. The viewport is where picking happens now; this is the reach for
      // what the camera cannot see — see the note above.
      defaultActiveKey={[]}
      items={[
        {
          key: 'faces',
          label: <Text style={{ fontSize: 12 }}>{`Faces (${faces.length})`}</Text>,
          children: (
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              {shownFaces.shown.map((f) => row(f, describeFace(f), f.facing === 'up'))}
              {more(shownFaces.hidden, 'face')}
            </div>
          ),
        },
        {
          key: 'edges',
          label: <Text style={{ fontSize: 12 }}>{`Edges (${edges.length})`}</Text>,
          children: (
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              {shownEdges.shown.map((e) => row(e, describeEdge(e), true))}
              {more(shownEdges.hidden, 'edge')}
            </div>
          ),
        },
      ]}
    />
  );
});

/**
 * What to do with the thing that is selected.
 *
 * The whole workflow turns on this bar existing. Picking a face and then
 * hunting for a generic "add operation" menu is two decisions in the wrong
 * order; here the selection *is* the subject, and the only question left is
 * which cut to make on it.
 */
function SelectionActions({ feature, onAddFace, onAddEdge, onClear }) {
  const [depth, setDepth] = React.useState(0.5);
  if (!feature) return null;

  const isEdge = Boolean(feature.points);
  const reachable = isEdge || feature.facing === 'up';

  return (
    <div style={{
      border: '1px solid rgba(180,83,9,0.35)', borderRadius: 6,
      padding: '8px 10px', background: 'rgba(251,191,36,0.16)',
    }}>
      <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <Space size={6}>
          <Tag color="gold" style={{ margin: 0 }}>{feature.id}</Tag>
          <Text style={{ fontSize: 11, color: CAD.text }}>
            {isEdge ? describeEdge(feature) : describeFace(feature)}
          </Text>
        </Space>
        <CommandButton
          id="clearSelection" size="small" type="text"
          icon={<CloseOutlined />} onClick={onClear}
        />
      </Space>

      {!reachable && (
        <Text type="warning" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
          This face points {feature.facing}. A 3-axis cutter cannot reach it —
          index the part until it faces up.
        </Text>
      )}

      <Space wrap style={{ marginTop: 8 }}>
        {isEdge ? (
          <>
            <Tooltip title="Depth below the edge">
              <InputNumber
                size="small" min={0} max={50} step={0.1} style={{ width: 82 }}
                addonAfter="mm" value={depth} onChange={(v) => setDepth(v ?? 0)}
              />
            </Tooltip>
            <CommandButton
              id="addEdgeOp"
              size="small" type="primary" icon={<ContourIcon />}
              onClick={() => onAddEdge(feature.id, { depth })}
            />
          </>
        ) : (
          <CommandButton
            id="addFaceOp"
            size="small" type="primary" icon={<ClearFaceIcon />}
            disabled={!reachable}
            onClick={() => onAddFace(feature.id)}
          />
        )}
      </Space>
    </div>
  );
}

export default function CamPanel() {
  const stlName = useCamPlanStore((s) => s.stlName);
  const partFormat = useCamPlanStore((s) => s.partFormat);
  const analysis = useCamPlanStore((s) => s.analysis);
  const plan = useCamPlanStore((s) => s.plan);
  const nc = useCamPlanStore((s) => s.nc);
  const verification = useCamPlanStore((s) => s.verification);
  const status = useCamPlanStore((s) => s.status);
  const error = useCamPlanStore((s) => s.error);
  const material = useCamPlanStore((s) => s.material);
  const forceMode = useCamPlanStore((s) => s.forceMode);
  const machineId = useCamPlanStore((s) => s.machineId);
  const recipe = useCamPlanStore((s) => s.recipe);
  const partOff = useCamPlanStore((s) => s.partOff);
  const diameterMode = useCamPlanStore((s) => s.diameterMode);
  const programNumber = useCamPlanStore((s) => s.programNumber);

  // Imports go through the feature tree so the part always has a history —
  // `featureStore.importPart` calls `loadPart` and records it as the base.
  const loadPart = useFeatureStore((s) => s.importPart);
  const makePlan = useCamPlanStore((s) => s.makePlan);
  const sendToViewport = useCamPlanStore((s) => s.sendToViewport);
  const setOption = useCamPlanStore((s) => s.setOption);
  const setMachine = useCamPlanStore((s) => s.setMachine);
  const setMode = useCamPlanStore((s) => s.setMode);
  const setStepTool = useCamPlanStore((s) => s.setStepTool);
  const setStepParams = useCamPlanStore((s) => s.setStepParams);
  const toggleStep = useCamPlanStore((s) => s.toggleStep);
  const moveStep = useCamPlanStore((s) => s.moveStep);
  const removeStep = useCamPlanStore((s) => s.removeStep);
  const resetRecipe = useCamPlanStore((s) => s.resetRecipe);
  const toolChoices = useCamPlanStore((s) => s.toolChoices);
  const selectedFeature = useCamPlanStore((s) => s.selectedFeature);
  // Open from the start: with no operations yet, adding one is the next step.
  const [manualOpen, setManualOpen] = React.useState(true);
  // A face or edge clicked on the model is a Manual Toolpath pick.
  React.useEffect(() => { if (selectedFeature) setManualOpen(true); }, [selectedFeature]);
  const selectFeature = useCamPlanStore((s) => s.selectFeature);
  const features = useCamPlanStore((s) => s.features);
  const addFaceStep = useCamPlanStore((s) => s.addFaceStep);
  const previewFeatureAt = useCamPlanStore((s) => s.previewFeatureAt);
  const addEdgeStep = useCamPlanStore((s) => s.addEdgeStep);
  const datum = useCamPlanStore((s) => s.datum);
  const datumPickMode = useCamPlanStore((s) => s.datumPickMode);
  const startPickAxis = useCamPlanStore((s) => s.startPickAxis);
  const cancelPickDatum = useCamPlanStore((s) => s.cancelPickDatum);
  const setAxisOrigin = useCamPlanStore((s) => s.setAxisOrigin);
  const clearAxisOrigin = useCamPlanStore((s) => s.clearAxisOrigin);
  const clearDatum = useCamPlanStore((s) => s.clearDatum);
  const displayedDatumPoint = useCamPlanStore((s) => s.displayedDatumPoint);
  const startPickRotaryCenter = useCamPlanStore((s) => s.startPickRotaryCenter);
  const setRotaryCenter = useCamPlanStore((s) => s.setRotaryCenter);
  const clearRotaryCenter = useCamPlanStore((s) => s.clearRotaryCenter);
  const displayedRotaryCenter = useCamPlanStore((s) => s.displayedRotaryCenter);
  const startPickRotaryZero = useCamPlanStore((s) => s.startPickRotaryZero);
  const clearRotaryZero = useCamPlanStore((s) => s.clearRotaryZero);
  const rotaryZeroAngle = useCamPlanStore((s) => s.rotaryZeroAngle);
  const toggleFlip = useCamPlanStore((s) => s.toggleFlip);
  const turnPart = useCamPlanStore((s) => s.turnPart);
  const startPickCircle = useCamPlanStore((s) => s.startPickCircle);
  const datumPickHint = useCamPlanStore((s) => s.datumPickHint);
  const setAxisOffset = useCamPlanStore((s) => s.setAxisOffset);
  const displayedDatumOffset = useCamPlanStore((s) => s.displayedDatumOffset);

  const busy = status === 'loading' || status === 'planning';

  const exportNc = () => {
    const save = () => downloadNc(nc, `${(stlName || 'part').replace(/\.[^.]+$/, '')}.nc`);
    if (verification?.ok !== false) {
      save();
      return;
    }
    Modal.confirm({
      title: 'This program cuts into the part',
      content: `Up to ${verification.gouge.max} mm of the part is removed${whereAt(verification.gouge.at)}. Export it anyway?`,
      okText: 'Export anyway',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: save,
    });
  };
  const machine = machineById(machineId);
  // Read once per render: `features()` is memoised on the context, but calling
  // it three times in the tree still reads better as one named value.
  const detected = features();
  const pickable = detected.faces.length > 0 || detected.edges.length > 0;
  const dialect = dialectFor(machine.controller);
  const mode = plan?.mode ?? analysis?.recommend;
  const originPoint = displayedDatumPoint() ?? [0, 0, 0];
  const originOffset = displayedDatumOffset();
  const rotaryCenterYZ = displayedRotaryCenter() ?? [0, 0];

  // `setAxisOrigin`/`setRotaryCenter` re-measure the whole mesh (see
  // camPlanStore.js) — expensive, unlike most fields on this panel. antd's
  // `InputNumber` fires `onChange` on every keystroke, so committing straight
  // to the store there would re-run that pipeline once per character typed
  // instead of once per edit. These drafts hold the in-progress text and only
  // push to the store on blur/Enter, the same way a person touches off: type
  // the number, then commit it. Committed per axis, so one field never disturbs
  // another.
  const [originDraft, setOriginDraft] = React.useState(originPoint);
  React.useEffect(() => {
    setOriginDraft(originPoint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originPoint[0], originPoint[1], originPoint[2]]);
  const commitAxis = (i) => {
    if (originDraft[i] !== originPoint[i]) setAxisOrigin(i, originDraft[i]);
  };

  const [offsetDraft, setOffsetDraft] = React.useState(originOffset);
  React.useEffect(() => {
    setOffsetDraft(originOffset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originOffset[0], originOffset[1], originOffset[2]]);
  const commitOffset = (i) => {
    if (offsetDraft[i] !== originOffset[i]) setAxisOffset(i, offsetDraft[i]);
  };

  const [rotaryDraft, setRotaryDraft] = React.useState(rotaryCenterYZ);
  React.useEffect(() => {
    setRotaryDraft(rotaryCenterYZ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotaryCenterYZ[0], rotaryCenterYZ[1]]);
  const commitRotary = () => {
    if (rotaryDraft.some((v, i) => v !== rotaryCenterYZ[i])) setRotaryCenter(rotaryDraft);
  };

  // The recipe is the source of truth for the table: it holds the disabled rows
  // too, which the built steps by definition do not. Each row is matched to its
  // built step by key, and a row without one is a step that produced no motion.
  const stepByKey = new Map((plan?.steps ?? []).map((s) => [s.key, s]));
  const rows = recipe.map((e, i) => ({ ...e, step: stepByKey.get(e.key), index: i }));
  const edited = recipe.some((e) => !e.auto);

  const columns = [
    {
      title: '',
      width: 40,
      render: (_, row) => (
        <Tooltip title={row.enabled ? 'Skip this operation' : 'Include this operation'}>
          <Switch
            size="small"
            checked={row.enabled}
            disabled={!row.toolId}
            onChange={(v) => toggleStep(row.key, v)}
          />
        </Tooltip>
      ),
    },
    { title: '#', width: 32, render: (_, row) => row.step?.n ?? '–' },
    {
      title: 'Operation',
      render: (_, row) => (
        <div style={{ opacity: row.enabled ? 1 : 0.45 }}>
          <div>{row.step?.title ?? titleFor(row, plan?.mode)}</div>
          {row.toolId ? (
            <ToolSelect
              step={row}
              choices={toolChoices(row.key)}
              onChange={(id) => setStepTool(row.key, id)}
            />
          ) : (
            <Text type="danger" style={{ fontSize: 11 }}>no tool fits</Text>
          )}
          {plan?.mode === 'mill' && (
            <CutSettings row={row} onChange={(patch) => setStepParams(row.key, patch)} />
          )}
        </div>
      ),
    },
    {
      title: 'Speeds',
      width: 104,
      render: (_, row) => (row.step ? (
        <div style={{ fontSize: 11, lineHeight: 1.5 }}>
          <div>{row.step.speeds.rpm} rpm</div>
          {/* Turning is quoted in mm/min like everything else, with the mm/rev
              that will actually be posted under G99 beneath it — the two are the
              same feed, and only one of them can be compared with a milling
              operation two rows up. */}
          <div>
            {plan?.mode === 'turn'
              ? `${row.step.speeds.feedPerMin} mm/min`
              : `${row.step.speeds.feed} mm/min`}
          </div>
          {plan?.mode === 'turn' && (
            <div style={{ color: CAD.dim }}>{row.step.speeds.fn} mm/rev</div>
          )}
          {row.step.speeds.limitedBy && (
            <Tooltip title={`Clamped by ${machine.label}'s ${row.step.speeds.limitedBy}`}>
              <Tag color="orange" style={{ marginTop: 2 }}>clamped</Tag>
            </Tooltip>
          )}
        </div>
      ) : <Text type="secondary" style={{ fontSize: 11 }}>skipped</Text>),
    },
    { title: 'min', width: 46, render: (_, row) => row.step?.estMinutes ?? '' },
    {
      title: '',
      width: 78,
      render: (_, row) => (
        <Space size={0}>
          <CommandButton
            id="moveStepUp"
            type="text" size="small" icon={<ArrowUpOutlined />}
            disabled={row.index === 0}
            onClick={() => moveStep(row.key, -1)}
          />
          <CommandButton
            id="moveStepDown"
            type="text" size="small" icon={<ArrowDownOutlined />}
            disabled={row.index === recipe.length - 1}
            onClick={() => moveStep(row.key, 1)}
          />
          <CommandButton
            id="removeStep"
            type="text" size="small" danger icon={<DeleteOutlined />}
            onClick={() => removeStep(row.key)}
          />
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Title level={5} style={{ color: CAD.text, margin: 0 }}>
        CAM from a model
      </Title>

      <Space wrap>
        <Upload
          accept={PART_ACCEPT}
          showUploadList={false}
          beforeUpload={(file) => { loadPart(file); return false; }}
        >
          <CommandButton id="importPart" icon={<PartIcon />} loading={status === 'loading'} />
        </Upload>
        {/* Secondary, and deliberately so. It replaces the whole recipe, which
            is fine as a starting point and wrong as a thing that happens to
            you — so it is a button you press, not a gate you pass through. */}
        <CommandButton
          id="autoPlan"
          icon={<AutoPlanIcon />}
          disabled={!analysis}
          loading={status === 'planning'}
          onClick={() => makePlan()}
        />
        <CommandButton
          id="manualToolpath"
          icon={<PlusOutlined />}
          type={manualOpen && analysis ? 'primary' : 'default'}
          ghost={manualOpen && Boolean(analysis)}
          disabled={!analysis}
          onClick={() => setManualOpen(!manualOpen)}
        />
      </Space>

      {analysis && manualOpen && (
        <ManualToolpath
          detected={detected}
          pickable={pickable}
          selectedFeature={selectedFeature}
          onSelect={selectFeature}
          onPreview={previewFeatureAt}
          onAddFace={(id) => addFaceStep(id)}
          onAddEdge={(id, opts) => addEdgeStep(id, opts)}
        />
      )}

      {stlName && (
        <Space size={4}>
          <Tag color="purple" style={{ margin: 0 }}>{stlName}</Tag>
          {partFormat && <Tag style={{ margin: 0 }}>{partFormat.toUpperCase()}</Tag>}
        </Space>
      )}

      {error && <Alert type="error" showIcon message="STL / planning failed" description={error} />}

      {analysis && (
        <Descriptions
          size="small"
          column={1}
          bordered
          items={[
            {
              key: 'size',
              label: 'Size',
              children: `${analysis.bounds.size.map((v) => v.toFixed(1)).join(' × ')} mm`,
            },
            {
              key: 'vol',
              label: 'Volume',
              children: `${(analysis.volume / 1000).toFixed(2)} cm³`,
            },
            {
              key: 'tris',
              label: 'Triangles',
              children: analysis.triangleCount.toLocaleString(),
            },
            {
              key: 'rec',
              label: 'Reads as',
              children: (
                <Space>
                  <Tag color={analysis.recommend === 'turn' ? 'gold' : 'blue'}>
                    {MODE_LABEL[analysis.recommend]}
                  </Tag>
                  {analysis.axis.symmetric && (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      axis {analysis.axis.axis.toUpperCase()}
                    </Text>
                  )}
                </Space>
              ),
            },
            {
              key: 'shell',
              label: 'Mesh',
              children: analysis.shell.watertight
                ? <Tag color="green">watertight</Tag>
                : <Tag color="red">{analysis.shell.boundaryEdges} open edges</Tag>,
            },
          ]}
        />
      )}

      {analysis && (
        <>
          <Divider style={{ margin: '4px 0' }} />

          {/* The machine comes first because it decides the most: the process,
              the spindle and feed limits, and the dialect the NC is written in. */}
          <div>
            <Text style={{ color: CAD.label, fontSize: 11 }}>Machine</Text>
            <Select
              size="small"
              style={{ width: '100%' }}
              value={machineId}
              onChange={setMachine}
              showSearch
              optionFilterProp="title"
              options={['mill', 'turn'].map((kind) => ({
                label: kind === 'mill' ? 'Milling' : 'Turning',
                options: machinesByBrand(kind).flatMap((g) => g.machines.map((m) => {
                  // Whether this part fits *this* machine, worked out while the
                  // operator is choosing rather than after. It is the whole
                  // reason to keep strokes on a machine list: "which of ours
                  // can take it" should not need a tape measure.
                  const tooBig = fitWarnings(m, analysis.bounds).length > 0;
                  return {
                    value: m.id,
                    title: `${m.label} ${m.linear.map((a) => m.travel[a]).join('x')}`,
                    label: (
                      <span style={{ opacity: tooBig ? 0.55 : 1 }}>
                        {m.label}
                        <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
                          {travelLabel(m)}
                        </Text>
                        {tooBig && (
                          <Text type="warning" style={{ fontSize: 11, marginLeft: 6 }}>
                            part too big
                          </Text>
                        )}
                      </span>
                    ),
                  };
                })),
              }))}
            />
            <Text type="secondary" style={{ fontSize: 11 }}>
              {machine.note} · posts as {dialect.label}
            </Text>
            {/* Stroke and axis count are what decide whether a program can run
                at all, so they sit under the machine rather than in a warning
                the operator only meets after planning. */}
            <div style={{ marginTop: 2 }}>
              <Space size={4} wrap>
                <Tag>{axisLabel(machine)}</Tag>
                <Tooltip title={machine.linear.map((a) => `${a} ${machine.travel[a]} mm`).join(' · ')}>
                  <Tag>stroke {travelLabel(machine)}</Tag>
                </Tooltip>
                {machine.maxTurnDia && <Tag>Ø{machine.maxTurnDia} max</Tag>}
              </Space>
            </div>
          </div>

          <Space wrap>
            <Select
              size="small"
              style={{ width: 210 }}
              value={material}
              onChange={(v) => setOption({ material: v })}
              options={MATERIALS.map((m) => ({ value: m.id, label: m.label }))}
            />
            <Tooltip title="Auto follows the shape analysis; choosing a process moves the machine with it">
              <Select
                size="small"
                style={{ width: 120 }}
                value={forceMode}
                onChange={setMode}
                options={[
                  { value: 'auto', label: 'Auto route' },
                  { value: 'mill', label: 'Force mill' },
                  { value: 'turn', label: 'Force turn' },
                ]}
              />
            </Tooltip>
            <Tooltip title="Program number (O-word)">
              <InputNumber
                size="small"
                min={1}
                max={99999}
                style={{ width: 88 }}
                prefix="O"
                value={programNumber}
                onChange={(v) => v && setOption({ programNumber: v })}
              />
            </Tooltip>
          </Space>

          <Space wrap size="middle">
            {(plan?.mode ?? analysis.recommend) === 'turn' && (
              <>
                <Space size={4}>
                  <Switch size="small" checked={partOff} onChange={(v) => setOption({ partOff: v })} />
                  <Text style={{ color: CAD.label, fontSize: 12 }}>Part off</Text>
                </Space>
                <Space size={4}>
                  <Switch size="small" checked={diameterMode} onChange={(v) => setOption({ diameterMode: v })} />
                  <Text style={{ color: CAD.label, fontSize: 12 }}>X = diameter</Text>
                </Space>
              </>
            )}
          </Space>

          <Divider style={{ margin: '4px 0' }} />

          {/* Where X0/Y0/Z0 physically is. This is what lets a separately
              loaded .nc program — from a real controller, not this app's own
              post — simulate against the part correctly: the app has no G54
              table to teach the interpreter about, so instead the part itself
              is moved to sit at whatever point the operator actually touched
              off at. */}
          <div data-cam-origin>
            <Text style={{ color: CAD.label, fontSize: 11 }}>
              Origin — so a separately loaded .nc program simulates at the same X0/Y0/Z0
            </Text>
            <div style={{ marginTop: 4 }}>
              {/* One axis at a time — like touching off on the machine. Picking
                  X sets only X0 and leaves Y and Z where they are, and a flat face
                  on another axis turns square to X first. Each axis locks
                  independently. */}
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
                Pick one axis and click a face: it turns square to that axis and becomes its zero
              </Text>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {['X', 'Y', 'Z'].map((label, i) => {
                  const armed = datumPickMode === label.toLowerCase();
                  const locked = datum.axesSet[i];
                  return (
                    <div key={label}>
                    <Space size={6} wrap>
                      <Tooltip title={`Click a flat face to turn it square to ${label} and set ${label}0 on it. A face already square to ${label}, or a curved surface, only sets ${label}0.`}>
                        <Button
                          size="small"
                          style={{ width: 96 }}
                          type={armed ? 'primary' : 'default'}
                          onClick={() => (armed ? cancelPickDatum() : startPickAxis(i))}
                        >
                          {armed ? 'Click part…' : `Pick ${label}0`}
                        </Button>
                      </Tooltip>
                      <InputNumber
                        size="small"
                        addonBefore={label}
                        style={{ width: 104 }}
                        step={0.1}
                        value={originDraft[i]}
                        onChange={(v) => {
                          const next = [...originDraft];
                          next[i] = v ?? 0;
                          setOriginDraft(next);
                        }}
                        onBlur={() => commitAxis(i)}
                        onPressEnter={() => commitAxis(i)}
                      />
                      {locked ? (
                        <Tooltip title={`${label} is locked at this zero — click to release`}>
                          <Tag
                            color="green"
                            style={{ margin: 0, cursor: 'pointer' }}
                            onClick={() => clearAxisOrigin(i)}
                          >
                            locked ✕
                          </Tag>
                        </Tooltip>
                      ) : (
                        <Text type="secondary" style={{ fontSize: 11 }}>free</Text>
                      )}
                    </Space>
                    <Space size={6} wrap style={{ marginTop: 4 }}>
                      <Tooltip title={`Put ${label}0 this far from the picked plane, along +${label}. The plane then reads ${label} = minus this distance.`}>
                        <InputNumber
                          size="small"
                          addonBefore="Offset"
                          aria-label={`${label} offset`}
                          style={{ width: 132 }}
                          step={0.1}
                          value={offsetDraft[i]}
                          onChange={(v) => {
                            const next = [...offsetDraft];
                            next[i] = v ?? 0;
                            setOffsetDraft(next);
                          }}
                          onBlur={() => commitOffset(i)}
                          onPressEnter={() => commitOffset(i)}
                        />
                      </Tooltip>
                      {/* A 180° turn about the origin, not a mirror, so one other
                          axis always reverses too: the switches show that. */}
                      {mode === 'mill' && (
                        <Space size={4}>
                          <Switch
                            size="small"
                            aria-label={`Flip ${label}`}
                            checked={flipOf(datum)[i]}
                            onChange={() => toggleFlip(i)}
                          />
                          <Tooltip title={`Turn the part 180° about the origin so ${label} reads reversed. ${['X', 'Y', 'Z'][(i + 1) % 3]} reverses with it, because reversing one axis alone would mirror the part.`}>
                            <Text style={{ color: CAD.label, fontSize: 12 }}>{`Flip ${label}`}</Text>
                          </Tooltip>
                        </Space>
                      )}
                      {mode === 'mill' && (
                        <Tooltip title={datum.rotaryZero
                          ? 'Clear the A0 face first: its angle is measured from the layout this would change.'
                          : `Turn the part 90° about ${label}, through the origin, counter-clockwise looking down ${label}. Four presses come back to the start.`}
                        >
                          <Button
                            size="small"
                            aria-label={`Rotate about ${label}`}
                            disabled={Boolean(datum.rotaryZero)}
                            onClick={() => turnPart(i)}
                          >
                            {`${label} 90°`}
                          </Button>
                        </Tooltip>
                      )}
                    </Space>
                    </div>
                  );
                })}
              </div>
              {mode === 'mill' && (
                <div style={{ marginTop: 6 }}>
                  <Tooltip title="Click a round wall, or a flat face beside a circle, to put the origin on its centre. The axis along the circle stays where it is.">
                    <Button
                      size="small"
                      type={datumPickMode === 'circle' ? 'primary' : 'default'}
                      onClick={() => (datumPickMode === 'circle' ? cancelPickDatum() : startPickCircle())}
                    >
                      {datumPickMode === 'circle' ? 'Click a circle…' : 'Pick circle centre'}
                    </Button>
                  </Tooltip>
                  {datumPickMode === 'circle' && datumPickHint && (
                    <Text type="warning" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                      {datumPickHint}
                    </Text>
                  )}
                </div>
              )}
              {(datum.point || datum.axes || flipOf(datum).some(Boolean)) && (
                <CommandButton
                  id="clearDatum" size="small" type="text"
                  icon={<RollbackOutlined />}
                  style={{ marginTop: 4 }} onClick={clearDatum}
                />
              )}
            </div>
          </div>
        </>
      )}

      {/* The rotary setup, on a milling job: picking faces lives in Manual Toolpath. */}
      {analysis && pickable && (
        <>
          <Divider style={{ margin: '4px 0' }} />
          {machine.rotary.length > 0 ? (
            <div>
              {/* A part is rarely modelled at the angle it will actually be
                  chucked at — this turns the whole part about the rotary axis
                  so a picked face reads as A0. */}
              <div style={{ marginTop: 8 }}>
                <Text style={{ color: CAD.label, fontSize: 11 }}>
                  A0 face — which way the part faces when the table reads zero
                </Text>
                <div style={{ marginTop: 4 }}>
                  <Space wrap size={6}>
                    {/* Armed state shows as a pressed button; the tooltip says
                        what the next click will do, which is the one thing the
                        glyph cannot carry. */}
                    <CommandButton
                      id="pickA0Face"
                      size="small"
                      icon={<A0FaceIcon />}
                      type={datumPickMode === 'zero' ? 'primary' : 'default'}
                      title={datumPickMode === 'zero'
                        ? 'Armed — click the face on the part now, or press again to cancel'
                        : undefined}
                      onClick={() => (datumPickMode === 'zero' ? cancelPickDatum() : startPickRotaryZero())}
                    />
                    {datum.rotaryZero && (
                      <CommandButton
                        id="clearA0Face" size="small" type="text"
                        icon={<RollbackOutlined />} onClick={clearRotaryZero}
                      />
                    )}
                  </Space>
                  {datum.rotaryZero && (
                    <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                      Part turned {rotaryZeroAngle()?.toFixed(1)}° to bring that face to A0.
                    </Text>
                  )}
                </div>
              </div>

              {/* Where the physical A-axis passes through — Y/Z only, since it
                  runs the length of X. Same reasoning as the linear origin: a
                  loaded .nc program's A-word only lands where it should if the
                  simulator pivots on the same physical line the plan indexed
                  about, which `camStore.machineOpts()` reads off this. */}
              <div style={{ marginTop: 8 }}>
                <Text style={{ color: CAD.label, fontSize: 11 }}>
                  A-axis centre — where the rotary physically pivots
                </Text>
                <div style={{ marginTop: 4 }}>
                  <Space wrap size={6}>
                    <CommandButton
                      id="pickRotaryCentre"
                      size="small"
                      icon={<RotaryCentreIcon />}
                      type={datumPickMode === 'rotary' ? 'primary' : 'default'}
                      title={datumPickMode === 'rotary'
                        ? 'Armed — click the point on the part now, or press again to cancel'
                        : undefined}
                      onClick={() => (datumPickMode === 'rotary' ? cancelPickDatum() : startPickRotaryCenter())}
                    />
                    {datum.rotaryCenter && (
                      <CommandButton
                        id="clearRotaryCentre" size="small" type="text"
                        icon={<RollbackOutlined />} onClick={clearRotaryCenter}
                      />
                    )}
                  </Space>
                  <Space size={4} style={{ marginTop: 6 }}>
                    {['Y', 'Z'].map((label, i) => (
                      <InputNumber
                        key={label}
                        size="small"
                        addonBefore={label}
                        style={{ width: 96 }}
                        step={0.1}
                        value={rotaryDraft[i]}
                        onChange={(v) => {
                          const next = [...rotaryDraft];
                          next[i] = v ?? 0;
                          setRotaryDraft(next);
                        }}
                        onBlur={commitRotary}
                        onPressEnter={commitRotary}
                      />
                    ))}
                  </Space>
                </div>
              </div>
            </div>
          ) : (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {machine.label} has no rotary — pick a 4-axis machine to index the part.
            </Text>
          )}
        </>
      )}

      {plan && recipe.length > 0 && (
        <>
          <Divider style={{ margin: '4px 0' }} />
          <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
            <Space>
              <Tag color={plan.mode === 'turn' ? 'gold' : 'blue'}>{MODE_LABEL[plan.mode]}</Tag>
              <Text style={{ color: CAD.label, fontSize: 12 }}>
                {plan.steps.length} operations · ~{plan.totalMinutes.toFixed(1)} min cutting
              </Text>
              {edited && <Tag color="cyan">edited</Tag>}
            </Space>
            <Space size={4}>
              <CommandButton
                id="resetRecipe"
                size="small"
                icon={<ReloadOutlined />}
                disabled={!edited}
                onClick={() => resetRecipe()}
              />
            </Space>
          </Space>

          {/* What the program demands of the machine, as opposed to what the
              machine offers. The two lines sit apart on purpose: one describes
              the shop's equipment, this one describes this program. */}
          {plan.envelope && (
            <div style={{ fontSize: 11 }}>
              <Space size={4} wrap>
                <Tag color={plan.envelope.axes.missing.length ? 'red' : 'default'}>
                  {axisSummary(plan.envelope)}
                </Tag>
                {plan.envelope.travel.map((t) => (
                  <Tooltip
                    key={t.axis}
                    title={`${t.axis}: the toolpath spans ${t.need} mm of the machine's ${t.stroke} mm`}
                  >
                    <Tag color={t.over ? 'red' : t.used > 80 ? 'orange' : 'default'}>
                      {t.axis} {t.used}%
                    </Tag>
                  </Tooltip>
                ))}
              </Space>
            </div>
          )}

          <Table
            size="small"
            pagination={false}
            rowKey="key"
            dataSource={rows}
            columns={columns}
            expandable={{
              rowExpandable: (row) => Boolean(row.step || row.warning),
              expandedRowRender: (row) => (
                <div style={{ fontSize: 12 }}>
                  <Text style={{ color: CAD.icon }}>{row.step?.why ?? row.warning}</Text>
                  {row.step?.notes?.length > 0 && (
                    <ul style={{ margin: '6px 0 0 16px', color: CAD.muted }}>
                      {row.step.notes.map((note) => <li key={note}>{note}</li>)}
                    </ul>
                  )}
                </div>
              ),
            }}
          />

          {plan.warnings.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message="Check before cutting"
              description={
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {plan.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              }
            />
          )}

          <CutCheck verification={verification} />

          <Alert
            type="info"
            showIcon
            message="Speeds and feeds are starting points"
            description="No collision or holder check is performed. Dry run with the tool clear of the part before cutting."
          />

          <Space wrap>
            <CommandButton
              id="exportNc"
              type="primary"
              icon={<DownloadOutlined />}
              disabled={!nc}
              onClick={exportNc}
            />
            <CommandButton
              id="verifyInViewport"
              icon={<SendOutlined />}
              disabled={!nc}
              onClick={() => sendToViewport()}
            />
          </Space>
        </>
      )}

      {/* A part is loaded but nothing has been asked of it yet. Says what the
          two ways forward are, rather than showing an empty table that looks
          like a failure. */}
      {analysis && recipe.length === 0 && !busy && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={(
            <Text type="secondary" style={{ fontSize: 12 }}>
              No operations yet — Auto Toolpath plans the whole part, Manual Toolpath adds one at a time
            </Text>
          )}
        />
      )}

      {!analysis && !busy && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={(
            <Text type="secondary">
              {`Import a part to plan a job — ${PART_FORMATS.map((f) => f.label).join(', ')}`}
            </Text>
          )}
        />
      )}
    </Space>
  );
}
