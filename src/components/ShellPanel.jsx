/**
 * ShellPanel — hollow the part to a wall thickness. While it is open, clicking a
 * flat face of the part toggles it open (lit red); Shell then adds the feature.
 */
import { useState } from 'react';
import {
  Button, Popover, Space, Typography, InputNumber, Alert,
} from 'antd';
import { useFeatureStore } from '../stores/featureStore.js';
import { CAD } from '../theme.js';

const { Text } = Typography;

export default function ShellPanel({ trigger }) {
  const shellPick = useFeatureStore((s) => s.shellPick);
  const [thickness, setThickness] = useState(2);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const open = Boolean(shellPick);
  const n = shellPick?.faces.length ?? 0;

  // Opened from the button; closed only by Shell or Cancel — a click on the part
  // is a pick, not a click away from the panel.
  const onOpenChange = (o) => {
    if (!o || shellPick) return;
    setError(null);
    useFeatureStore.getState().startShellPick();
  };
  const cancel = () => {
    setError(null);
    useFeatureStore.getState().stopShellPick();
  };

  const apply = async () => {
    const fs = useFeatureStore.getState();
    setBusy(true);
    const openFaces = shellPick.faces.map((f) => f.ref);
    fs.stopShellPick();
    const failed = await fs.buildOnPart('shell', { thickness, openFaces });
    setBusy(false);
    if (failed) {
      setError(failed);
      fs.startShellPick();
    }
  };

  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      open={open || Boolean(error)}
      onOpenChange={onOpenChange}
      title="Shell"
      content={(
        <Space direction="vertical" size={6} style={{ width: 260 }} data-shell-panel>
          <InputNumber
            size="small"
            value={thickness}
            min={0.05}
            step={0.5}
            onChange={(v) => { if (Number(v) > 0) setThickness(Number(v)); }}
            addonBefore="Wall"
            addonAfter="mm"
            style={{ width: '100%' }}
            data-shell-thickness
          />
          <Text style={{ fontSize: 12, color: n ? CAD.text : CAD.dim }} data-shell-count>
            {n ? `${n} face${n === 1 ? '' : 's'} open — click a face again to close it` : 'Click the faces to leave open, or none for a closed hollow'}
          </Text>
          {error && <Alert type="error" showIcon message={error} style={{ fontSize: 12 }} />}
          <Space size={6} style={{ width: '100%', justifyContent: 'flex-end' }}>
            <Button size="small" onClick={cancel} data-shell-cancel>Cancel</Button>
            <Button type="primary" size="small" loading={busy} onClick={apply} data-shell-apply>Shell</Button>
          </Space>
        </Space>
      )}
    >
      {trigger}
    </Popover>
  );
}
