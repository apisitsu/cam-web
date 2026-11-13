/**
 * SweepLoftPanel — Swept / Lofted Boss and Cut, from sketches already drawn.
 *
 * A sweep takes a profile sketch (closed) and a path sketch (an open chain of
 * lines and arcs); a loft takes two or more profile sketches, in the order they
 * blend. `SweepLoftFields` is the form, shared with the feature tree.
 */
import { useState } from 'react';
import {
  Button, Popover, Space, Typography, Select, Segmented, Alert,
} from 'antd';
import { useFeatureStore } from '../stores/featureStore.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { createFeature } from '../engine/solid/featureTree.js';
import { CAD } from '../theme.js';

const { Text } = Typography;

export function SweepLoftFields({ value, onChange, sketches }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const options = sketches.map((s) => ({ value: s.id, label: s.name }));
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {value.kind === 'sweep' ? (
        <>
          <Select
            size="small"
            value={value.sketchId}
            onChange={(v) => set({ sketchId: v })}
            options={options}
            placeholder="Profile sketch (closed)"
            style={{ width: '100%' }}
            data-sweep-profile
          />
          <Select
            size="small"
            value={value.pathSketchId}
            onChange={(v) => set({ pathSketchId: v })}
            options={options}
            placeholder="Path sketch (open lines / arcs)"
            style={{ width: '100%' }}
            data-sweep-path
          />
        </>
      ) : (
        <Select
          size="small"
          mode="multiple"
          value={value.sketchIds}
          onChange={(v) => set({ sketchIds: v })}
          options={options}
          placeholder="Profile sketches, in order"
          style={{ width: '100%' }}
          data-loft-profiles
        />
      )}
      <Segmented
        size="small"
        block
        value={value.merge === 'cut' ? 'cut' : 'add'}
        onChange={(v) => set({ merge: v })}
        options={[{ value: 'add', label: 'Boss (add)' }, { value: 'cut', label: 'Cut' }]}
      />
    </Space>
  );
}

export default function SweepLoftPanel({ kind, trigger }) {
  const sketches = useSketchStore((s) => s.sketches);
  const buildOnPart = useFeatureStore((s) => s.buildOnPart);
  const hasFeatures = useFeatureStore((s) => s.features.length > 0);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const onOpenChange = async (o) => {
    setOpen(o);
    if (!o) return;
    // The sketch being drawn has to be closed for its geometry to be read.
    if (useSketchStore.getState().sketchOpen) await useFeatureStore.getState().finishSketch();
    setValue(createFeature(kind, { id: -1, merge: hasFeatures ? 'add' : 'new' }));
    setError(null);
  };

  const ready = value && (kind === 'sweep'
    ? value.sketchId != null && value.pathSketchId != null
    : value.sketchIds.length >= 2);

  const apply = async () => {
    setBusy(true);
    const { id, name, ...props } = value; // eslint-disable-line no-unused-vars
    const failed = await buildOnPart(kind, { ...props, name: kind === 'sweep' ? 'Sweep' : 'Loft' });
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
      title={kind === 'sweep' ? 'Sweep' : 'Loft'}
      content={value && (
        <div style={{ width: 300 }} data-sweeploft-panel={kind}>
          <SweepLoftFields value={value} onChange={setValue} sketches={sketches} />
          <Text style={{ display: 'block', marginTop: 4, fontSize: 11, color: CAD.dim }}>
            {kind === 'sweep'
              ? 'Draw the profile on a plane across the start of the path.'
              : 'Each profile is one closed loop; they blend in the order picked.'}
          </Text>
          {error && <Alert type="error" showIcon message={error} style={{ marginTop: 6, fontSize: 12 }} />}
          <Button
            type="primary"
            size="small"
            block
            loading={busy}
            disabled={!ready}
            onClick={apply}
            style={{ marginTop: 8 }}
            data-sweeploft-apply
          >
            {kind === 'sweep' ? 'Sweep' : 'Loft'}
          </Button>
        </div>
      )}
    >
      {trigger}
    </Popover>
  );
}
