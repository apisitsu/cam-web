import { Space, Typography, InputNumber, Tooltip } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import CommandButton from './CommandButton.jsx';
import { cutterById, cutterWarning, defaultThickness, defaultShank } from '../engine/cam/cutters.js';
import { CAD } from '../theme.js';
import CutterPicker from './CutterPicker.jsx';

const { Text } = Typography;

/**
 * The cutter the sim falls back to when the program never named one.
 *
 * Always collapsed to a single `+` until asked for. The first cut at this
 * opened it automatically whenever the program declared no tools — which was
 * exactly the common case, so the `+` was never seen and the row looked as
 * permanent as before. A control that is sometimes a button and sometimes a
 * form is worse than either; this is a button, and pressing it gives the form.
 */
export default function ToolFallback({
  open, onOpen, detected, diameter, cutter, flutes, angle, thickness, shank,
  onDiameter, onCutter, onFlutes, onAngle, onThickness, onShank, addonStyle,
}) {
  const spec = cutterById(cutter);
  if (!open) {
    return (
      <Space size={6} align="center">
        <CommandButton id="toolFallback" size="small" icon={<PlusOutlined />} onClick={onOpen} />
        <Text style={{ color: CAD.dim, fontSize: 11 }}>
          {detected > 0
            ? `Cutter from the program (${detected} ${detected === 1 ? 'tool' : 'tools'})`
            : `Cutter — the program names none, using ⌀${diameter} ${spec.label.toLowerCase()}`}
        </Text>
      </Space>
    );
  }
  const [loF, hiF] = spec.fluteRange;
  const advice = cutterWarning({ cutter, diameter });
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {/* The TYPE first: it decides what the other two fields mean. */}
      <CutterPicker value={cutter} onChange={onCutter} />
      <Space wrap align="center" size="small">
        <Tooltip title="Cutting diameter">
          <Space.Compact>
            <span className="ant-input-group-addon" style={addonStyle('left')}>⌀</span>
            <InputNumber controls={false}
              min={0.1} step={0.5} value={diameter} onChange={onDiameter}
              style={{ width: 74 }}
            />
            <span className="ant-input-group-addon" style={addonStyle('right')}>mm</span>
          </Space.Compact>
        </Tooltip>
        {/* Flutes are not decoration: feed = rpm x flutes x chip load, so this
            number is a term in the cycle time. Clamped to what the type is
            actually made in. */}
        <Tooltip title={`Flutes / inserts — feed is rpm x flutes x chip load, so this changes the cycle time (${loF}-${hiF} for a ${spec.label.toLowerCase()})`}>
          <Space.Compact>
            <span className="ant-input-group-addon" style={addonStyle('left')}>Z</span>
            <InputNumber controls={false}
              min={loF} max={hiF} step={1} value={flutes} onChange={onFlutes}
              style={{ width: 56 }}
            />
          </Space.Compact>
        </Tooltip>
        {spec.angleAdjustable && (
          <Tooltip title="Included angle — the chamfer this cutter leaves. 90° gives a 45° chamfer.">
            <Space.Compact>
              <span className="ant-input-group-addon" style={addonStyle('left')}>∠</span>
              <InputNumber controls={false}
                min={15} max={175} step={5} value={angle} onChange={onAngle}
                style={{ width: 62 }}
              />
              <span className="ant-input-group-addon" style={addonStyle('right')}>°</span>
            </Space.Compact>
          </Tooltip>
        )}
        {/* A slot cutter's cutting body and its shank are both numbers the
            diameter cannot imply — a necked tool is wide where it cuts and
            narrow where the holder grips it. */}
        {spec.thicknessAdjustable && (
          <Tooltip title="Cutter thickness — the width of the slot this tool leaves.">
            <Space.Compact>
              <span className="ant-input-group-addon" style={addonStyle('left')}>t</span>
              <InputNumber controls={false}
                aria-label="Cutter thickness"
                min={spec.thicknessRange[0]}
                max={spec.thicknessRange[1]}
                step={0.5}
                // Empty means "not measured": the marker falls back to what the
                // type implies and the cut is not capped. Showing that default
                // as a VALUE read as a setting that was already in force, so
                // pressing Simulate changed nothing and looked broken.
                value={thickness ?? null}
                placeholder={String(defaultThickness(spec.id, diameter))}
                onChange={onThickness}
                style={{ width: 66 }}
              />
              <span className="ant-input-group-addon" style={addonStyle('right')}>mm</span>
            </Space.Compact>
          </Tooltip>
        )}
        {spec.shankAdjustable && (
          <Tooltip title="Shank diameter — the plain part above the flutes, which the holder grips.">
            <Space.Compact>
              <span className="ant-input-group-addon" style={addonStyle('left')}>s⌀</span>
              <InputNumber controls={false}
                aria-label="Shank diameter"
                min={spec.shankRange[0]}
                max={spec.shankRange[1]}
                step={0.5}
                value={shank ?? null}
                placeholder={String(defaultShank(spec.id, diameter))}
                onChange={onShank}
                style={{ width: 66 }}
              />
              <span className="ant-input-group-addon" style={addonStyle('right')}>mm</span>
            </Space.Compact>
          </Tooltip>
        )}
      </Space>
      {advice && (
        <Text style={{ color: '#a16207', fontSize: 11 }}>{advice}</Text>
      )}
    </Space>
  );
}
