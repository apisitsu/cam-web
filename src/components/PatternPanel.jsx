/**
 * PatternPanel — Linear Pattern, Circular Pattern and Mirror of features in 3D.
 *
 * Opened from the Features Ribbon. `PatternFields` is the form itself, shared
 * with the feature tree, where the same feature is edited after it is made. The
 * features to copy default to the one selected in the tree, as SolidWorks
 * preselects; a mirror with none picked mirrors the whole body.
 */
import { useState } from 'react';
import {
  Button, Popover, Space, Typography, Segmented, InputNumber, Select, Alert,
} from 'antd';
import { useFeatureStore } from '../stores/featureStore.js';
import { createFeature, isEdgeTreatment } from '../engine/solid/featureTree.js';
import { PATTERN_TYPES } from '../engine/solid/pattern.js';
import { CAD } from '../theme.js';

const { Text } = Typography;
const AXIS_OPTIONS = ['x', 'y', 'z'].map((v) => ({ value: v, label: v.toUpperCase() }));

/** Features a pattern can copy: those built from a sketch, before `beforeId`. */
export function seedChoices(features, beforeId = null) {
  const out = [];
  for (const f of features) {
    if (f.id === beforeId) break;
    if (f.kind === 'import' || f.kind === 'pattern' || isEdgeTreatment(f)) continue;
    out.push({ value: f.id, label: f.name });
  }
  return out;
}

const num = (label, value, onChange, props = {}) => (
  <InputNumber
    size="small"
    value={value}
    onChange={(v) => { if (Number.isFinite(Number(v)) && v !== null) onChange(Number(v)); }}
    addonBefore={label}
    style={{ width: '100%' }}
    {...props}
  />
);

/** The pattern's parameters; `value` is a pattern feature (or its props). */
export function PatternFields({ value, onChange, features, selfId = null }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const seeds = (
    <Select
      size="small"
      mode="multiple"
      allowClear
      value={value.seeds}
      onChange={(v) => set({ seeds: v })}
      options={seedChoices(features, selfId)}
      placeholder={value.pattern === 'mirror' ? 'None — mirror the whole body' : 'Features to copy'}
      style={{ width: '100%' }}
      data-pattern-seeds
    />
  );
  if (value.pattern === 'mirror') {
    return (
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        {seeds}
        <Segmented
          size="small"
          block
          value={value.mirrorPlane}
          onChange={(v) => set({ mirrorPlane: v })}
          options={[{ value: 'YZ', label: 'Right (YZ)' }, { value: 'XZ', label: 'Front (XZ)' }, { value: 'XY', label: 'Top (XY)' }]}
        />
        {num('Offset', value.mirrorOffset, (v) => set({ mirrorOffset: v }), { addonAfter: 'mm' })}
      </Space>
    );
  }
  if (value.pattern === 'circular') {
    return (
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        {seeds}
        <Space size={4} style={{ width: '100%' }}>
          <Text style={{ fontSize: 12, color: CAD.label }}>Axis</Text>
          <Segmented size="small" value={value.axis} onChange={(v) => set({ axis: v })} options={AXIS_OPTIONS} />
        </Space>
        <Space size={4} style={{ width: '100%' }}>
          {['X', 'Y', 'Z'].map((l, i) => (
            <InputNumber
              key={l}
              size="small"
              value={value.center[i]}
              onChange={(v) => set({ center: value.center.map((c, k) => (k === i ? Number(v) || 0 : c)) })}
              addonBefore={l}
              style={{ width: 92 }}
            />
          ))}
        </Space>
        <Space size={4} style={{ width: '100%' }}>
          {num('Count', value.count, (v) => set({ count: v }), { min: 2, max: 500, style: { width: 120 } })}
          {num('Angle', value.angle, (v) => set({ angle: v }), { addonAfter: '°', style: { width: 150 } })}
        </Space>
      </Space>
    );
  }
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {seeds}
      <Space size={4} style={{ width: '100%' }}>
        <Segmented size="small" value={value.dir} onChange={(v) => set({ dir: v })} options={AXIS_OPTIONS} />
        {num('Count', value.count, (v) => set({ count: v }), { min: 1, max: 500, style: { width: 110 } })}
        {num('Every', value.spacing, (v) => set({ spacing: v }), { addonAfter: 'mm', style: { width: 140 } })}
      </Space>
      <Space size={4} style={{ width: '100%' }}>
        <Segmented
          size="small"
          value={value.dir2 || 'none'}
          onChange={(v) => set({ dir2: v === 'none' ? null : v })}
          options={[{ value: 'none', label: '—' }, ...AXIS_OPTIONS]}
        />
        {value.dir2 && num('Count', value.count2, (v) => set({ count2: v }), { min: 1, max: 500, style: { width: 110 } })}
        {value.dir2 && num('Every', value.spacing2, (v) => set({ spacing2: v }), { addonAfter: 'mm', style: { width: 140 } })}
      </Space>
      <Text style={{ fontSize: 11, color: CAD.dim }}>A negative spacing runs the other way.</Text>
    </Space>
  );
}

export default function PatternPanel({ pattern, trigger }) {
  const features = useFeatureStore((s) => s.features);
  const selectedId = useFeatureStore((s) => s.selectedId);
  const buildPattern = useFeatureStore((s) => s.buildPattern);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const onOpenChange = (o) => {
    setOpen(o);
    if (!o) return;
    const pre = seedChoices(features).some((c) => c.value === selectedId) ? [selectedId] : [];
    setValue(createFeature('pattern', { pattern, seeds: pre, id: -1 }));
    setError(null);
  };

  const apply = async () => {
    setBusy(true);
    const { id, name, ...props } = value; // eslint-disable-line no-unused-vars
    const failed = await buildPattern(props);
    setBusy(false);
    if (failed) setError(failed);
    else setOpen(false);
  };

  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      open={open}
      onOpenChange={onOpenChange}
      title={PATTERN_TYPES[pattern]}
      content={value && (
        <div style={{ width: 330 }} data-pattern-panel={pattern}>
          <PatternFields value={value} onChange={setValue} features={features} />
          {error && <Alert type="error" showIcon message={error} style={{ marginTop: 6, fontSize: 12 }} />}
          <Button
            type="primary"
            size="small"
            block
            loading={busy}
            disabled={pattern !== 'mirror' && !value.seeds.length}
            onClick={apply}
            style={{ marginTop: 8 }}
            data-pattern-apply
          >
            {PATTERN_TYPES[pattern]}
          </Button>
        </div>
      )}
    >
      {trigger}
    </Popover>
  );
}
