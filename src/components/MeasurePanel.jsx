/**
 * MeasurePanel — what Measure has found, floating over the viewport while it is on.
 *
 * It says what to click until something is, then reads out the measurement. The
 * picks are in the frame of the part they were clicked on, so a new part, or a
 * move between the Sketch page and a machining page, starts again.
 */
import { useEffect } from 'react';
import { Button, Typography } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import { useMeasureStore } from '../stores/measureStore.js';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { measureResult } from '../engine/mesh/measure.js';
import { CAD } from '../theme.js';

const { Text } = Typography;

export default function MeasurePanel({ sketching }) {
  const active = useMeasureStore((s) => s.active);
  const picks = useMeasureStore((s) => s.picks);
  const clear = useMeasureStore((s) => s.clear);
  const stop = useMeasureStore((s) => s.stop);
  const meshVer = useCamPlanStore((s) => s.meshVer);
  const hasPart = useCamPlanStore((s) => Boolean(s.analysis));

  useEffect(() => { clear(); }, [meshVer, sketching, clear]);
  useEffect(() => { if (!hasPart) stop(); }, [hasPart, stop]);
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') stop(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, stop]);

  if (!active) return null;
  const lines = measureResult(picks);
  return (
    <div
      data-measure-panel
      style={{
        position: 'absolute', top: 52, left: 12, zIndex: 6, minWidth: 220, maxWidth: 320,
        background: CAD.glassSolid, border: `1px solid ${CAD.border}`, borderRadius: 4,
        padding: '6px 10px', boxShadow: '0 2px 10px rgba(23,42,66,0.18)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Text strong style={{ fontSize: 12, flex: 1 }}>Measure</Text>
        {picks.length > 0 && <Button size="small" type="text" onClick={clear}>Clear</Button>}
        <Button size="small" type="text" icon={<CloseOutlined />} onClick={stop} aria-label="Close Measure" />
      </div>
      {lines.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px', marginTop: 4 }}>
          {lines.map((l) => (
            <span key={l.label} style={{ display: 'contents' }}>
              <Text style={{ color: CAD.label, fontSize: 11 }}>{l.label}</Text>
              <Text style={{ fontFamily: 'monospace', fontSize: 12 }} data-measure-value={l.label}>{l.value}</Text>
            </span>
          ))}
        </div>
      ) : null}
      <Text style={{ color: CAD.dim, fontSize: 10, display: 'block', marginTop: 4 }}>
        {picks.length === 1
          ? 'Click a second face, bore or point for the distance to it.'
          : 'Click a face, a bore or a boss on the part. Esc to finish.'}
      </Text>
    </div>
  );
}
