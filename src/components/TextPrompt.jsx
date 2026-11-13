/**
 * TextPrompt — the words for the sketch Text tool, after the click that placed them.
 */
import { useEffect, useState } from 'react';
import {
  Modal, Input, InputNumber, Space, Typography,
} from 'antd';
import { useSketchStore } from '../stores/sketchStore.js';
import { textWidth, unsupportedChars } from '../engine/sketch/text.js';

const { Text } = Typography;

export default function TextPrompt() {
  const pending = useSketchStore((s) => s.textPending);
  const placeText = useSketchStore((s) => s.placeText);
  const cancelText = useSketchStore((s) => s.cancelText);
  const [text, setText] = useState('');
  const [height, setHeight] = useState(5);
  const [angle, setAngle] = useState(0);
  useEffect(() => { if (pending) setText(''); }, [pending]);

  const bad = unsupportedChars(text);
  const ok = () => placeText({ text, height, angle });
  return (
    <Modal
      title="Text for engraving"
      open={!!pending}
      onOk={ok}
      onCancel={cancelText}
      okText="Place"
      okButtonProps={{ disabled: !text.trim(), 'data-text-place': true }}
      destroyOnHidden
      width={380}
    >
      <Input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPressEnter={ok}
        placeholder="e.g. PN 1234-A"
        maxLength={80}
        data-text-input
      />
      <Space style={{ marginTop: 10 }}>
        <InputNumber
          value={height}
          min={0.5}
          step={0.5}
          onChange={(v) => setHeight(Number(v) || height)}
          addonBefore="Height"
          addonAfter="mm"
          style={{ width: 170 }}
          data-text-height
        />
        <InputNumber
          value={angle}
          step={15}
          onChange={(v) => setAngle(Number(v) || 0)}
          addonBefore="Angle"
          addonAfter="°"
          style={{ width: 150 }}
        />
      </Space>
      <div style={{ marginTop: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {text ? `${textWidth(text, height).toFixed(1)} mm long` : 'Single-stroke letters, for a V-cutter or small endmill to follow.'}
        </Text>
        {bad.length > 0 && (
          <Text type="warning" style={{ fontSize: 12, display: 'block' }}>
            Not in the engraving font, will be left out: {bad.join(' ')}
          </Text>
        )}
      </div>
    </Modal>
  );
}
