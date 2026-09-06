/**
 * BuildPanel — turn the sketch into a solid and hand it to CAM.
 *
 * This is the door between the two halves of the app. Everything above it is 2D
 * (geometry, constraints, a solver); everything below it is the CAM pipeline
 * that until now could only be fed an imported STL. The solid built here enters
 * that pipeline by the same path a file does, so pressing Build lands the
 * operator on the machine page with the part measured and ready to plan.
 *
 * The panel states **before** it is pressed whether there is anything to build
 * and, if not, which of the three reasons it is — an open profile, an ambiguous
 * junction, or an empty sketch each need something different done about them,
 * and finding that out only after pressing a button is how a tool teaches people
 * not to press it.
 */
import { useState } from 'react';
import {
  Button, Tooltip, Popover, Space, Typography, Segmented, InputNumber, Alert,
} from 'antd';
import { useSketchStore } from '../stores/sketchStore.js';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { planeLabel } from '../engine/sketch/plane.js';
import { BOOLEAN_OPS } from '../engine/solid/regionBoolean.js';
import { CAD } from '../theme.js';

const { Text } = Typography;

const COMBINE_OPTIONS = [
  { value: 'none', label: 'Keep apart' },
  ...Object.keys(BOOLEAN_OPS).map((value) => ({
    value,
    label: { union: 'Union', difference: 'Subtract', intersect: 'Intersect', xor: 'Exclude' }[value],
  })),
];

/**
 * What to do with the solid once it is built, when a part is already loaded.
 * "Replace" is first and is the default because it is what the button did
 * before there was a choice.
 */
const MERGE_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'cut', label: 'Cut' },
  { value: 'add', label: 'Add' },
  { value: 'common', label: 'Common' },
];

/** What the sketch would build right now, as a sentence. */
function describe({ regions, open, branches }, combineOp) {
  if (!regions.length && combineOp) {
    // Distinct from "nothing drawn": there *is* geometry, the operation just
    // consumed all of it — intersecting two profiles that do not overlap.
    return { ok: false, text: `Nothing is left after ${combineOp} — the profiles do not overlap the way that needs.` };
  }
  if (regions.length) {
    const holes = regions.reduce((n, r) => n + r.holes.length, 0);
    const parts = [`${regions.length} closed profile${regions.length > 1 ? 's' : ''}`];
    if (holes) parts.push(`${holes} hole${holes > 1 ? 's' : ''}`);
    // Dangling geometry does not stop a build, but it is silently left out of
    // it, which looks like a bug from the other side of the screen.
    if (open.length) parts.push(`${open.length} open chain${open.length > 1 ? 's' : ''} ignored`);
    return { ok: true, text: parts.join(' · ') };
  }
  if (open.length) {
    // Branching is no longer a reason to fail — face traversal resolves a
    // junction rather than giving up at it — so an unclosed profile is what is
    // left, and the count says how much of it is dangling.
    return {
      ok: false,
      text: branches.length
        ? 'Nothing closes. Some geometry hangs by one end, and some meets at a junction — check that the ends of the profile actually join.'
        : 'The profile is not closed — the ends of some lines do not meet.',
    };
  }
  return { ok: false, text: 'Draw a closed profile first.' };
}

export default function BuildPanel({ trigger }) {
  // `version` is what the store bumps on every edit; reading it is how this
  // recomputes as the sketch is drawn rather than only when it is opened.
  const version = useSketchStore((s) => s.version);
  const regionsOf = useSketchStore((s) => s.regions);
  const build = useFeatureStore((s) => s.buildFromSketch);
  const featureCount = useFeatureStore((s) => s.features.length);
  const sketches = useSketchStore((s) => s.sketches);
  const activeId = useSketchStore((s) => s.activeId);

  const [op, setOp] = useState('extrude');
  const [depth, setDepth] = useState(10);
  const [axis, setAxis] = useState('x');
  const [angle, setAngle] = useState(360);
  const [combine, setCombine] = useState('none');
  const [merge, setMerge] = useState('new');
  const [busy, setBusy] = useState(false);
  // A feature already in the tree is what makes "cut this out of it" mean
  // anything — the part on the machine is whatever the tree last built.
  const hasPart = useCamPlanStore((s) => s.status === 'ready' && Boolean(s.stlName))
    && featureCount > 0;

  const active = sketches.find((s) => s.id === activeId) || sketches[0];
  // eslint-disable-next-line no-unused-vars
  const _ = version; // recompute per edit
  const combineOp = combine === 'none' ? null : combine;
  // The summary is computed **through** the boolean, so the count shown is what
  // will actually be built rather than what was drawn — subtracting two shapes
  // that leave nothing has to say so before the button is pressed, not after.
  const state = regionsOf(combineOp);
  const summary = describe(state, combineOp);
  const multi = regionsOf(null).regions.length > 1;

  const mergeOp = hasPart ? merge : 'new';

  const onBuild = async () => {
    setBusy(true);
    try {
      const shape = op === 'revolve'
        ? { op, axis, angle: (angle * Math.PI) / 180 }
        : { op, depth };
      await build({ ...shape, combine: combineOp, merge: mergeOp });
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <Space direction="vertical" size={8} style={{ minWidth: 260 }}>
      <Text style={{ color: CAD.dim, fontSize: 11 }}>
        Build a solid from “{active?.name}” on {planeLabel(active?.plane)}
      </Text>

      <Segmented
        size="small"
        block
        value={op}
        onChange={setOp}
        options={[{ label: 'Extrude', value: 'extrude' }, { label: 'Revolve', value: 'revolve' }]}
      />

      {op === 'extrude' ? (
        <Tooltip title="Distance along the plane's normal. Negative extrudes the other way.">
          <InputNumber
            size="small"
            value={depth}
            onChange={(v) => setDepth(Number(v) || 0)}
            addonBefore="Depth"
            addonAfter="mm"
            style={{ width: '100%' }}
          />
        </Tooltip>
      ) : (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Segmented
            size="small"
            block
            value={axis}
            onChange={setAxis}
            options={[{ label: 'About X', value: 'x' }, { label: 'About Y', value: 'y' }]}
          />
          <InputNumber
            size="small"
            value={angle}
            min={1}
            max={360}
            onChange={(v) => setAngle(Number(v) || 360)}
            addonBefore="Angle"
            addonAfter="°"
            style={{ width: '100%' }}
          />
          <Text style={{ color: CAD.dim, fontSize: 10 }}>
            The profile must sit wholly on one side of the axis — draw it against a centreline.
          </Text>
        </Space>
      )}

      {/* Only offered when there is more than one profile — with a single one
          there is nothing to combine it with, and a control that does nothing
          reads as a control that is broken. */}
      {multi && (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Text style={{ color: CAD.dim, fontSize: 11 }}>Combine the profiles</Text>
          <Segmented
            size="small"
            block
            value={combine}
            onChange={setCombine}
            options={COMBINE_OPTIONS}
          />
          {combineOp && (
            <Text style={{ color: CAD.dim, fontSize: 10 }}>{BOOLEAN_OPS[combineOp]}</Text>
          )}
        </Space>
      )}

      {/* Only when there is something on the machine to combine with. */}
      {hasPart && (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Text style={{ color: CAD.dim, fontSize: 11 }}>Against what the tree has built</Text>
          <Segmented size="small" block value={merge} onChange={setMerge} options={MERGE_OPTIONS} />
          {mergeOp !== 'new' && (
            <Text style={{ color: CAD.dim, fontSize: 10 }}>
              A boolean between solids is approximate — where both shapes share a plane,
              combining the profiles above is exact.
            </Text>
          )}
        </Space>
      )}

      <Alert
        type={summary.ok ? 'info' : 'warning'}
        showIcon
        message={<span style={{ fontSize: 11 }}>{summary.text}</span>}
        style={{ padding: '4px 8px' }}
      />

      <Button
        size="small"
        type="primary"
        block
        loading={busy}
        disabled={!summary.ok}
        onClick={onBuild}
        data-sketch-build
      >
        Build solid
      </Button>
      <Text style={{ color: CAD.dim, fontSize: 10 }}>
        {mergeOp !== 'new'
          ? `Added to the feature tree, ${mergeOp === 'cut' ? 'cutting' : mergeOp === 'add' ? 'joining' : 'intersecting'} what is already there. Editable afterwards.`
          : 'Added to the feature tree as a new body. Editable afterwards.'}
      </Text>
    </Space>
  );

  return (
    <Popover trigger="click" placement="bottomLeft" content={content}>
      {trigger}
    </Popover>
  );
}
