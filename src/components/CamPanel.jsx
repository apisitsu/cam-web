/**
 * CamPanel — the STL → plan → NC workflow, as UI.
 *
 * Deliberately thin. Every number shown here was computed in `engine/cam`, and
 * the component's only jobs are to render it, to dispatch the operator's edits,
 * and to hand the result on. Anything that looks like a calculation in this
 * file belongs downstairs instead.
 *
 * The workflow runs in the order the work does: **import, look, pick, cut.**
 * Importing measures the part and nothing more, so the faces and edges are
 * pickable immediately; choosing one is what creates an operation. The
 * automatic plan is still here as `Auto-plan`, but as a button rather than a
 * gate — it replaces the whole recipe, which is a fine starting point and a
 * bad thing to have happen to you.
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
  Divider, Switch, Tooltip, Empty, Dropdown, InputNumber, Collapse,
} from 'antd';
import {
  UploadOutlined, ExperimentOutlined, DownloadOutlined, SendOutlined,
  ArrowUpOutlined, ArrowDownOutlined, DeleteOutlined, PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { MATERIALS } from '../engine/cam/library.js';
import {
  machineById, machinesByBrand, axisLabel, travelLabel,
} from '../engine/cam/machines.js';
import { axisSummary, fitWarnings } from '../engine/cam/envelope.js';
import { operationKind } from '../engine/cam/recipe.js';
import { describeFace, describeEdge } from '../engine/mesh/features.js';
import { visibleFeatures, hiddenNote } from '../engine/view/featureList.js';
import { PART_ACCEPT, PART_FORMATS } from '../engine/mesh/import.js';
import { dialectFor } from '../engine/cam/post/dialect.js';

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
 * The faces and edges of the part, as a list to pick from.
 *
 * A list, not only a click target in the 3D view. Picking in 3D is faster when
 * the face is visible and useless when it is not — a pocket floor under an
 * overhang, the underside, the face that is currently pointing away. The list
 * reaches everything, and hovering a row is what highlights it in the viewport.
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
        background: selected?.id === item.id ? 'rgba(251,191,36,0.18)' : 'transparent',
      }}
    >
      <Tag style={{ margin: 0, minWidth: 34, textAlign: 'center' }}>{item.id}</Tag>
      <Text style={{ flex: 1, fontSize: 11, color: reachable ? '#cbd5e1' : '#64748b' }}>
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
      defaultActiveKey={['faces']}
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
      border: '1px solid rgba(251,191,36,0.4)', borderRadius: 6,
      padding: '8px 10px', background: 'rgba(251,191,36,0.08)',
    }}>
      <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <Space size={6}>
          <Tag color="gold" style={{ margin: 0 }}>{feature.id}</Tag>
          <Text style={{ fontSize: 11, color: '#e2e8f0' }}>
            {isEdge ? describeEdge(feature) : describeFace(feature)}
          </Text>
        </Space>
        <Button size="small" type="text" onClick={onClear}>clear</Button>
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
            <Button
              size="small" type="primary" icon={<PlusOutlined />}
              onClick={() => onAddEdge(feature.id, { depth })}
            >
              Trace this edge
            </Button>
          </>
        ) : (
          <Button
            size="small" type="primary" icon={<PlusOutlined />}
            disabled={!reachable}
            onClick={() => onAddFace(feature.id)}
          >
            Clear this face
          </Button>
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
  const status = useCamPlanStore((s) => s.status);
  const error = useCamPlanStore((s) => s.error);
  const material = useCamPlanStore((s) => s.material);
  const forceMode = useCamPlanStore((s) => s.forceMode);
  const machineId = useCamPlanStore((s) => s.machineId);
  const recipe = useCamPlanStore((s) => s.recipe);
  const partOff = useCamPlanStore((s) => s.partOff);
  const diameterMode = useCamPlanStore((s) => s.diameterMode);
  const programNumber = useCamPlanStore((s) => s.programNumber);

  const loadPart = useCamPlanStore((s) => s.loadPart);
  const makePlan = useCamPlanStore((s) => s.makePlan);
  const sendToViewport = useCamPlanStore((s) => s.sendToViewport);
  const setOption = useCamPlanStore((s) => s.setOption);
  const setMachine = useCamPlanStore((s) => s.setMachine);
  const setMode = useCamPlanStore((s) => s.setMode);
  const setStepTool = useCamPlanStore((s) => s.setStepTool);
  const toggleStep = useCamPlanStore((s) => s.toggleStep);
  const moveStep = useCamPlanStore((s) => s.moveStep);
  const removeStep = useCamPlanStore((s) => s.removeStep);
  const addStep = useCamPlanStore((s) => s.addStep);
  const resetRecipe = useCamPlanStore((s) => s.resetRecipe);
  const toolChoices = useCamPlanStore((s) => s.toolChoices);
  const addableKinds = useCamPlanStore((s) => s.addableKinds);
  const selectedFeature = useCamPlanStore((s) => s.selectedFeature);
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
  const toggleReverseX = useCamPlanStore((s) => s.toggleReverseX);

  const busy = status === 'loading' || status === 'planning';
  const machine = machineById(machineId);
  // Read once per render: `features()` is memoised on the context, but calling
  // it three times in the tree still reads better as one named value.
  const detected = features();
  const pickable = detected.faces.length > 0 || detected.edges.length > 0;
  const dialect = dialectFor(machine.controller);
  const mode = plan?.mode ?? analysis?.recommend;
  const originPoint = displayedDatumPoint() ?? [0, 0, 0];
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
        </div>
      ),
    },
    {
      title: 'Speeds',
      width: 104,
      render: (_, row) => (row.step ? (
        <div style={{ fontSize: 11, lineHeight: 1.5 }}>
          <div>{row.step.speeds.rpm} rpm</div>
          <div>
            {plan?.mode === 'turn'
              ? `${row.step.speeds.fn} mm/rev`
              : `${row.step.speeds.feed} mm/min`}
          </div>
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
          <Button
            type="text" size="small" icon={<ArrowUpOutlined />}
            disabled={row.index === 0}
            onClick={() => moveStep(row.key, -1)}
          />
          <Button
            type="text" size="small" icon={<ArrowDownOutlined />}
            disabled={row.index === recipe.length - 1}
            onClick={() => moveStep(row.key, 1)}
          />
          <Button
            type="text" size="small" danger icon={<DeleteOutlined />}
            onClick={() => removeStep(row.key)}
          />
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Title level={5} style={{ color: '#e2e8f0', margin: 0 }}>
        CAM from a model
      </Title>

      <Space wrap>
        <Upload
          accept={PART_ACCEPT}
          showUploadList={false}
          beforeUpload={(file) => { loadPart(file); return false; }}
        >
          <Button icon={<UploadOutlined />} loading={status === 'loading'}>
            Import part
          </Button>
        </Upload>
        {/* Secondary, and deliberately so. It replaces the whole recipe, which
            is fine as a starting point and wrong as a thing that happens to
            you — so it is a button you press, not a gate you pass through. */}
        <Tooltip title="Replace everything with an automatic plan for the whole part">
          <Button
            icon={<ExperimentOutlined />}
            disabled={!analysis}
            loading={status === 'planning'}
            onClick={() => makePlan()}
          >
            Auto-plan
          </Button>
        </Tooltip>
      </Space>

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
            <Text style={{ color: '#94a3b8', fontSize: 11 }}>Machine</Text>
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
                  <Text style={{ color: '#94a3b8', fontSize: 12 }}>Part off</Text>
                </Space>
                <Space size={4}>
                  <Switch size="small" checked={diameterMode} onChange={(v) => setOption({ diameterMode: v })} />
                  <Text style={{ color: '#94a3b8', fontSize: 12 }}>X = diameter</Text>
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
          <div>
            <Text style={{ color: '#94a3b8', fontSize: 11 }}>
              Origin — so a separately loaded .nc program simulates at the same X0/Y0/Z0
            </Text>
            <div style={{ marginTop: 4 }}>
              {/* One axis at a time — like touching off on the machine. Picking
                  X sets only X0 and leaves Y and Z where they are; the part is
                  never reoriented by a pick. Each axis locks independently. */}
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
                Pick one axis, click the part to set its zero, then lock the next
              </Text>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {['X', 'Y', 'Z'].map((label, i) => {
                  const armed = datumPickMode === label.toLowerCase();
                  const locked = datum.axesSet[i];
                  return (
                    <Space key={label} size={6} wrap>
                      <Tooltip title={`Click the part to set ${label}0 there — only ${label} moves, nothing rotates`}>
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
                  );
                })}
              </div>
              {datum.point && (
                <Button size="small" type="text" style={{ marginTop: 4 }} onClick={clearDatum}>
                  Reset all axes to native origin
                </Button>
              )}
              {/* Turns the whole part 180° about Z — a rotation, not a
                  mirror, so both X and Y reverse together — for when a
                  program written or posted elsewhere counts X the other way
                  along the same physical setup. */}
              {mode === 'mill' && (
                <Space size={4} style={{ marginTop: 6 }}>
                  <Switch size="small" checked={datum.reverseX} onChange={toggleReverseX} />
                  <Tooltip title="Rotate the part 180° about Z — reverses which end reads as high X (and high Y with it)">
                    <Text style={{ color: '#94a3b8', fontSize: 12 }}>Flip X</Text>
                  </Tooltip>
                </Space>
              )}
            </div>
          </div>
        </>
      )}

      {/* Picking comes before planning, because that is the order the work
          happens in: look at the part, choose the face, cut it. Gated on the
          measured geometry rather than on a plan existing — waiting for a plan
          is exactly the gate this workflow removes. */}
      {analysis && pickable && (
        <>
          <Divider style={{ margin: '4px 0' }} />
          <Text style={{ color: '#94a3b8', fontSize: 11 }}>
            Pick a face or edge — click the model, or a row below
          </Text>

          <SelectionActions
            feature={selectedFeature}
            onAddFace={(id) => addFaceStep(id)}
            onAddEdge={(id, opts) => addEdgeStep(id, opts)}
            onClear={() => selectFeature(null)}
          />

          <FeaturePicker
            features={detected}
            selected={selectedFeature}
            onSelect={selectFeature}
            onPreview={previewFeatureAt}
          />

          {machine.rotary.length > 0 ? (
            <div>
              {/* A part is rarely modelled at the angle it will actually be
                  chucked at — this turns the whole part about the rotary axis
                  so a picked face reads as A0. */}
              <div style={{ marginTop: 8 }}>
                <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                  A0 face — which way the part faces when the table reads zero
                </Text>
                <div style={{ marginTop: 4 }}>
                  <Space wrap size={6}>
                    <Tooltip title="Click the face that should be up (facing the spindle) at A0">
                      <Button
                        size="small"
                        type={datumPickMode === 'zero' ? 'primary' : 'default'}
                        onClick={() => (datumPickMode === 'zero' ? cancelPickDatum() : startPickRotaryZero())}
                      >
                        {datumPickMode === 'zero' ? 'Click the part…' : 'Pick face for A0'}
                      </Button>
                    </Tooltip>
                    {datum.rotaryZero && (
                      <Button size="small" type="text" onClick={clearRotaryZero}>
                        Reset to modelled A0
                      </Button>
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
                <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                  A-axis centre — where the rotary physically pivots
                </Text>
                <div style={{ marginTop: 4 }}>
                  <Space wrap size={6}>
                    <Tooltip title="Click a point on the part that sits on the rotary's centreline">
                      <Button
                        size="small"
                        type={datumPickMode === 'rotary' ? 'primary' : 'default'}
                        onClick={() => (datumPickMode === 'rotary' ? cancelPickDatum() : startPickRotaryCenter())}
                      >
                        {datumPickMode === 'rotary' ? 'Click the part…' : 'Pick A-axis centre on part'}
                      </Button>
                    </Tooltip>
                    {datum.rotaryCenter && (
                      <Button size="small" type="text" onClick={clearRotaryCenter}>
                        Reset to frame origin
                      </Button>
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
              <Text style={{ color: '#94a3b8', fontSize: 12 }}>
                {plan.steps.length} operations · ~{plan.totalMinutes.toFixed(1)} min cutting
              </Text>
              {edited && <Tag color="cyan">edited</Tag>}
            </Space>
            <Space size={4}>
              <Dropdown
                trigger={['click']}
                menu={{
                  items: addableKinds().map((k) => ({
                    key: k.kind,
                    label: (
                      <div>
                        <div>{k.label}</div>
                        <Text type="secondary" style={{ fontSize: 11 }}>{k.hint}</Text>
                      </div>
                    ),
                  })),
                  onClick: ({ key }) => addStep(key),
                }}
              >
                <Button size="small" icon={<PlusOutlined />}>Add operation</Button>
              </Dropdown>
              <Tooltip title="Discard the edits and take the planner's proposal again">
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  disabled={!edited}
                  onClick={() => resetRecipe()}
                />
              </Tooltip>
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
                  <Text style={{ color: '#cbd5e1' }}>{row.step?.why ?? row.warning}</Text>
                  {row.step?.notes?.length > 0 && (
                    <ul style={{ margin: '6px 0 0 16px', color: '#64748b' }}>
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

          <Alert
            type="info"
            showIcon
            message="Speeds and feeds are starting points"
            description="No collision or holder check is performed. Dry run with the tool clear of the part before cutting."
          />

          <Space wrap>
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              disabled={!nc}
              onClick={() => downloadNc(nc, `${(stlName || 'part').replace(/\.[^.]+$/, '')}.nc`)}
            >
              Export NC
            </Button>
            <Tooltip title="Load the generated program into the backplot and simulator">
              <Button icon={<SendOutlined />} disabled={!nc} onClick={() => sendToViewport()}>
                Verify in viewport
              </Button>
            </Tooltip>
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
              No operations yet — pick a face or edge above, or Auto-plan the whole part
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
