/**
 * EdgeTreatPanel — Chamfer / Fillet while edges are being picked, floating over
 * the viewport like Measure: the size, the edges clicked so far, OK and Cancel.
 */
import { useEffect, useState } from 'react';
import { Button, InputNumber, Typography } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import { useEdgeTreatStore } from '../stores/edgeTreatStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { describeEdgeRef, EDGE_TREATMENTS } from '../engine/solid/edgeTreat.js';
import { CAD } from '../theme.js';

const { Text } = Typography;

export default function EdgeTreatPanel({ sketching = true }) {
  const active = useEdgeTreatStore((s) => s.active);
  const size = useEdgeTreatStore((s) => s.size);
  const edges = useEdgeTreatStore((s) => s.edges);
  const error = useEdgeTreatStore((s) => s.error);
  const editingId = useEdgeTreatStore((s) => s.editingId);
  const setSize = useEdgeTreatStore((s) => s.setSize);
  const removeEdge = useEdgeTreatStore((s) => s.removeEdge);
  const stop = useEdgeTreatStore((s) => s.stop);
  const [busy, setBusy] = useState(false);

  // Edges are picked on the part as built; leaving that page ends the pick.
  useEffect(() => { if (!sketching) stop(); }, [sketching, stop]);
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') stop(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, stop]);

  if (!active || !sketching) return null;
  const { label, size: sizeLabel } = EDGE_TREATMENTS[active];
  const ok = async () => {
    setBusy(true);
    try {
      await useFeatureStore.getState().buildEdgeTreatment();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-edge-treat-panel
      style={{
        position: 'absolute', top: 52, left: 12, zIndex: 6, width: 240,
        background: CAD.glassSolid, border: `1px solid ${CAD.border}`, borderRadius: 4,
        padding: '6px 10px', boxShadow: '0 2px 10px rgba(23,42,66,0.18)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Text strong style={{ fontSize: 12, flex: 1 }}>{editingId != null ? `Edit ${label}` : label}</Text>
        <Button size="small" type="text" icon={<CloseOutlined />} onClick={stop} aria-label={`Cancel ${label}`} />
      </div>
      <InputNumber
        size="small"
        min={0.01}
        step={0.5}
        value={size}
        onChange={(v) => { if (Number(v) > 0) setSize(Number(v)); }}
        addonBefore={sizeLabel}
        addonAfter="mm"
        style={{ width: '100%', marginTop: 4 }}
        data-edge-treat-size
      />
      <div style={{ marginTop: 6, maxHeight: 140, overflowY: 'auto' }}>
        {edges.map((e, i) => (
          <div key={`${i}-${describeEdgeRef(e)}`} style={{ display: 'flex', alignItems: 'center' }} data-edge-treat-edge>
            <Text style={{ fontSize: 11, flex: 1 }}>{describeEdgeRef(e)}</Text>
            <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => removeEdge(i)} aria-label="Remove edge" />
          </div>
        ))}
      </div>
      {error && <Text type="danger" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>{error}</Text>}
      <Text style={{ color: CAD.dim, fontSize: 10, display: 'block', marginTop: 4 }}>
        Click straight edges or round rims on the part; click again to drop one. Esc to cancel.
      </Text>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
        <Button size="small" onClick={stop}>Cancel</Button>
        <Button size="small" type="primary" loading={busy} disabled={!edges.length} onClick={ok} data-edge-treat-ok>
          OK
        </Button>
      </div>
    </div>
  );
}
