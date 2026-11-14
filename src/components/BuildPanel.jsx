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
import { useMemo, useState } from 'react';
import { SwapOutlined } from '@ant-design/icons';
import {
  Button, Tooltip, Popover, Space, Typography, Segmented, InputNumber, Alert,
} from 'antd';
import { useSketchStore } from '../stores/sketchStore.js';
import { useCamPlanStore, getRawMesh } from '../stores/camPlanStore.js';
import { boundsOf } from '../engine/mesh/analyze.js';
import { END_CONDITIONS, defaultReverse } from '../engine/solid/featureTree.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { planeLabel } from '../engine/sketch/plane.js';
import { centerlines } from '../engine/sketch/model.js';
import { BOOLEAN_OPS } from '../engine/solid/regionBoolean.js';
import RevolveAxis, { axisFromValue, defaultAxisValue } from './RevolveAxis.jsx';
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

/**
 * A feature already in the tree is what makes "cut this out of it" mean anything:
 * the part on the machine is whatever the tree last built.
 */
export function useHasBuiltPart() {
  const featureCount = useFeatureStore((s) => s.features.length);
  const loaded = useCamPlanStore((s) => s.status === 'ready' && Boolean(s.stlName));
  return loaded && featureCount > 0;
}

export const START_SKETCH_HINT = 'Start a sketch first: pick a plane or a face, or open one from the tree.';

/** The active sketch is closed and already built from, so it is not what a new feature means. */
export function useSketchSpent() {
  const open = useSketchStore((s) => s.sketchOpen);
  const activeId = useSketchStore((s) => s.activeId);
  const built = useFeatureStore((s) => s.features.some((f) => f.sketchId === activeId));
  return !open && built;
}

/**
 * @param {object} props
 * @param {React.ReactNode} props.trigger what opens the panel
 * @param {{name:string, op:'extrude'|'revolve', cut:boolean}} [props.preset] one
 *   named feature, as the Ribbon offers them, so the panel asks only for its sizes
 *   and not again for what the button already said. Without it the panel offers
 *   every choice, including New and Common, which have no button of their own.
 */
export default function BuildPanel({ trigger, preset }) {
  // `version` is what the store bumps on every edit; reading it is how this
  // recomputes as the sketch is drawn rather than only when it is opened.
  const version = useSketchStore((s) => s.version);
  const regionsOf = useSketchStore((s) => s.regions);
  const build = useFeatureStore((s) => s.buildFromSketch);
  const sketches = useSketchStore((s) => s.sketches);
  const activeId = useSketchStore((s) => s.activeId);

  const [chosenOp, setOp] = useState('extrude');
  const op = preset?.op ?? chosenOp;
  const [depth, setDepth] = useState(10);
  const [end, setEnd] = useState('blind');
  const [draft, setDraft] = useState(0);
  // `null` until pressed: until then the extrude runs the way its kind wants to,
  // a cut into the part and a boss out of it (`defaultReverse`).
  const [reverseChoice, setReverse] = useState(null);
  const meshVer = useCamPlanStore((s) => s.meshVer);
  const partBounds = useMemo(() => {
    const { soup } = getRawMesh();
    return soup?.triangleCount ? boundsOf(soup) : null;
  }, [meshVer]); // eslint-disable-line react-hooks/exhaustive-deps
  const sk = useSketchStore((s) => s.sk);
  // `null` until the operator picks one: until then a centerline on the sketch is
  // the axis, and the sketch's X axis when there is none. A pick of a centerline
  // that has since been deleted falls back the same way.
  const [axisChoice, setAxis] = useState(null);
  const [angle, setAngle] = useState(360);
  const [combine, setCombine] = useState('none');
  const [merge, setMerge] = useState('new');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const hasPart = useHasBuiltPart();

  const active = sketches.find((s) => s.id === activeId) || sketches[0];
  // eslint-disable-next-line no-unused-vars
  const _ = version; // recompute per edit
  const combineOp = combine === 'none' ? null : combine;
  // The summary is computed **through** the boolean, so the count shown is what
  // will actually be built rather than what was drawn — subtracting two shapes
  // that leave nothing has to say so before the button is pressed, not after.
  const state = regionsOf(combineOp);
  const spent = useSketchSpent();
  const summary = spent ? { ok: false, text: START_SKETCH_HINT } : describe(state, combineOp);
  const multi = regionsOf(null).regions.length > 1;
  const lines = centerlines(sk);
  const choiceGone = axisChoice?.startsWith('line:') && !lines.some((l) => `line:${l.id}` === axisChoice);
  const axis = axisChoice && !choiceGone ? axisChoice : defaultAxisValue(sk);

  // A boss on an empty tree is the first body, so it has nothing to join yet.
  let mergeOp = hasPart ? merge : 'new';
  if (preset) {
    if (preset.cut) mergeOp = 'cut';
    else mergeOp = hasPart ? 'add' : 'new';
  }

  const reverse = reverseChoice ?? defaultReverse(active?.plane, partBounds, mergeOp === 'cut');

  const onBuild = async () => {
    setBusy(true);
    try {
      const shape = op === 'revolve'
        ? { op, ...axisFromValue(axis), angle: (angle * Math.PI) / 180 }
        : {
          op, depth, end, reverse, draft,
        };
      const built = await build({ ...shape, combine: combineOp, merge: mergeOp });
      if (built) setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <Space direction="vertical" size={8} style={{ minWidth: 260 }}>
      <Text style={{ color: CAD.dim, fontSize: 11 }}>
        {preset ? preset.name : 'Build a solid'} from “{active?.name}” on {planeLabel(active?.plane)}
      </Text>

      {!preset && (
        <Segmented
          size="small"
          block
          value={op}
          onChange={setOp}
          options={[{ label: 'Extrude', value: 'extrude' }, { label: 'Revolve', value: 'revolve' }]}
        />
      )}

      {op === 'extrude' ? (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Segmented
            size="small"
            block
            value={end}
            onChange={setEnd}
            options={Object.entries(END_CONDITIONS).map(([value, label]) => ({ value, label }))}
            data-extrude-end
          />
          {end !== 'through' && (
            <Tooltip title={end === 'mid' ? 'The whole depth, half each side of the plane' : 'Distance from the plane'}>
              <InputNumber
                size="small"
                value={depth}
                onChange={(v) => setDepth(Number(v) || 0)}
                addonBefore="Depth"
                addonAfter="mm"
                style={{ width: '100%' }}
              />
            </Tooltip>
          )}
          <Tooltip title="Draft: the walls lean in by this angle going away from the sketch (negative leans out)">
            <InputNumber
              size="small"
              value={draft}
              onChange={(v) => setDraft(Number(v) || 0)}
              addonBefore="Draft"
              addonAfter="°"
              min={-60}
              max={60}
              style={{ width: '100%' }}
              data-extrude-draft
            />
          </Tooltip>
          {/* A cut pointing away from the part removes nothing, so which way it
              runs is chosen for it — and said, with the button to turn it round. */}
          {end !== 'mid' && (
            <Space size={6} align="center">
              <Button
                size="small"
                type={reverse ? 'primary' : 'default'}
                icon={<SwapOutlined rotate={90} />}
                onClick={() => setReverse(!reverse)}
                data-extrude-reverse
              >
                Reverse
              </Button>
              <Text style={{ color: CAD.dim, fontSize: 10 }}>
                {end === 'through' ? 'Through the part, ' : ''}
                {reverse ? 'against' : 'along'} the plane&apos;s normal
                {mergeOp === 'cut' ? ' — into the part' : ''}
              </Text>
            </Space>
          )}
        </Space>
      ) : (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <RevolveAxis doc={sk} value={axis} onChange={setAxis} long block data-revolve-axis />
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
            {lines.length
              ? 'The profile must sit wholly on one side of the axis.'
              : 'The profile must sit wholly on one side of the axis. Draw a centerline (a Construction line) to turn about it instead.'}
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
          {!preset && (
            <>
              <Text style={{ color: CAD.dim, fontSize: 11 }}>Against what the tree has built</Text>
              <Segmented size="small" block value={merge} onChange={setMerge} options={MERGE_OPTIONS} />
            </>
          )}
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
    <Popover trigger="click" placement="bottomLeft" content={content} open={open} onOpenChange={setOpen}>
      {trigger}
    </Popover>
  );
}
