/**
 * HolePanel — Hole Wizard: the kind of hole, its size and depth, at the open
 * sketch's points.
 *
 * Opened from the Ribbon like the four named features. It asks only for what the
 * kind needs — a thread for a tapped hole, a counterbore's diameter and depth —
 * and says how many holes it will make and where they come from before Build.
 */
import { useMemo, useState } from 'react';
import {
  Button, Popover, Space, Typography, Segmented, InputNumber, Select, Alert,
} from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import { useSketchStore } from '../stores/sketchStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { useCamPlanStore, getRawMesh } from '../stores/camPlanStore.js';
import { boundsOf } from '../engine/mesh/analyze.js';
import { defaultReverse } from '../engine/solid/featureTree.js';
import {
  HOLE_TYPES, THREADS, holePositions, drillDiameter,
} from '../engine/solid/hole.js';
import { planeLabel } from '../engine/sketch/plane.js';
import { CAD } from '../theme.js';

const { Text } = Typography;

const mmInput = (label, value, onChange, extra = {}) => (
  <InputNumber
    size="small"
    value={value}
    min={0.1}
    step={0.5}
    onChange={(v) => onChange(Number(v) || value)}
    addonBefore={label}
    addonAfter={extra.unit ?? 'mm'}
    style={{ width: '100%' }}
    {...extra.props}
  />
);

export default function HolePanel({ trigger }) {
  useSketchStore((s) => s.version); // the count follows the points as they are drawn
  const sk = useSketchStore((s) => s.sk);
  const active = useSketchStore((s) => s.sketches.find((x) => x.id === s.activeId) ?? s.sketches[0]);
  const buildHole = useFeatureStore((s) => s.buildHole);
  const meshVer = useCamPlanStore((s) => s.meshVer);
  const partBounds = useMemo(() => {
    const { soup } = getRawMesh();
    return soup?.triangleCount ? boundsOf(soup) : null;
  }, [meshVer]); // eslint-disable-line react-hooks/exhaustive-deps

  const [holeType, setType] = useState('drill');
  const [diameter, setDiameter] = useState(6);
  const [thread, setThread] = useState('M6');
  const [threadDepth, setThreadDepth] = useState(12);
  const [cbDiameter, setCbDiameter] = useState(11);
  const [cbDepth, setCbDepth] = useState(6.5);
  const [cskDiameter, setCskDiameter] = useState(12);
  const [cskAngle, setCskAngle] = useState(90);
  const [end, setEnd] = useState('blind');
  const [depth, setDepth] = useState(15);
  const [reverseChoice, setReverse] = useState(null);
  const [busy, setBusy] = useState(false);

  const positions = holePositions(sk);
  // A hole runs against the plane's normal unless reversed — into a part the plane
  // is the top of. It needs reversing only when the part lies on the normal's side,
  // which is when a boss would (`defaultReverse` for a boss).
  const reverse = reverseChoice ?? defaultReverse(active?.plane, partBounds, false);
  const spec = {
    holeType, diameter, thread, threadDepth, cbDiameter, cbDepth, cskDiameter, cskAngle,
  };

  const onBuild = async () => {
    setBusy(true);
    try {
      await buildHole({
        ...spec, end, depth, reverse,
      });
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <Space direction="vertical" size={8} style={{ minWidth: 280 }} data-hole-panel>
      <Text style={{ color: CAD.dim, fontSize: 11 }}>
        Hole Wizard at the points of “{active?.name}” on {planeLabel(active?.plane)}
      </Text>
      <Segmented
        size="small"
        block
        value={holeType}
        onChange={setType}
        options={Object.entries(HOLE_TYPES).map(([value, label]) => ({ value, label }))}
        data-hole-type
      />

      {holeType === 'tap' ? (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Space size={4} style={{ width: '100%' }}>
            <Text style={{ fontSize: 12 }}>Thread</Text>
            <Select
              size="small"
              value={thread}
              onChange={setThread}
              options={Object.keys(THREADS).map((t) => ({ value: t, label: `${t} × ${THREADS[t].pitch}` }))}
              style={{ width: 120 }}
              data-hole-thread
            />
            <Text style={{ color: CAD.dim, fontSize: 10 }}>drill Ø{drillDiameter({ holeType: 'tap', thread })}</Text>
          </Space>
          {mmInput('Thread depth', threadDepth, setThreadDepth)}
        </Space>
      ) : mmInput('Diameter', diameter, setDiameter, { props: { 'data-hole-diameter': true } })}

      {holeType === 'cbore' && (
        <>
          {mmInput("C'bore Ø", cbDiameter, setCbDiameter)}
          {mmInput("C'bore depth", cbDepth, setCbDepth)}
        </>
      )}
      {holeType === 'csk' && (
        <>
          {mmInput("C'sink Ø", cskDiameter, setCskDiameter)}
          {mmInput('Angle', cskAngle, setCskAngle, { unit: '°' })}
        </>
      )}

      <Segmented
        size="small"
        block
        value={end}
        onChange={setEnd}
        options={[{ value: 'blind', label: 'Blind' }, { value: 'through', label: 'Through All' }]}
        data-hole-end
      />
      {end === 'blind' && mmInput('Depth', depth, setDepth)}
      <Space size={6} align="center">
        <Button
          size="small"
          type={reverse ? 'primary' : 'default'}
          icon={<SwapOutlined rotate={90} />}
          onClick={() => setReverse(!reverse)}
          data-hole-reverse
        >
          Reverse
        </Button>
        <Text style={{ color: CAD.dim, fontSize: 10 }}>
          {reverse ? 'Along' : 'Against'} the plane&apos;s normal
        </Text>
      </Space>

      <Alert
        type={positions.length ? 'info' : 'warning'}
        showIcon
        style={{ padding: '4px 8px' }}
        message={(
          <span style={{ fontSize: 11 }}>
            {positions.length
              ? `${positions.length} hole${positions.length > 1 ? 's' : ''} — one at each point of the sketch`
              : 'Put a point where each hole goes (or a circle — its centre is used).'}
          </span>
        )}
      />
      <Button
        size="small"
        type="primary"
        block
        loading={busy}
        disabled={!positions.length}
        onClick={onBuild}
        data-hole-build
      >
        Make holes
      </Button>
    </Space>
  );

  return (
    <Popover trigger="click" placement="bottomLeft" content={content}>
      {trigger}
    </Popover>
  );
}
