import { Button, Space, Typography, InputNumber, Input, Tooltip, Select, Modal } from 'antd';
import { defaultThickness, defaultShank } from '../engine/cam/cutters.js';
import { CAD } from '../theme.js';
import TurnInsertPicker from './TurnInsertPicker.jsx';
import CutterPicker from './CutterPicker.jsx';
import { BORING_BAR_DIAMETERS } from '../engine/view/latheTool.js';

const { Text } = Typography;

/**
 * Everything about one Tool-table row that is not the compact glance view:
 * insert/cutter shape, diameter, angle, thickness, shank, bar diameter,
 * groove width, gauge length — and the Name field too, so renaming and the
 * rest of the setup are not two different places to look.
 *
 * One dialog shared by every row (`camStore.toolEditDialog` holds which T
 * number, if any), the same reasoning as `CustomTurnToolDialog`: a form per
 * row would mean sixteen mounted-but-hidden dialogs on a sixteen-tool
 * program. `tool` is the matching `detectedTools` row; `null` while closed or
 * for a T number no longer in the program, in which case nothing renders.
 */
export default function ToolEditDialog({
  open, tool, override, turning, eff, effSpec, holder, customTurnTools,
  addonStyle, edited,
  onClose, onOverride, onCutter, onThickness, onShank, onClearOverride,
  onAddCustom, onEditCustom, onRemoveCustom,
}) {
  if (!tool) return null;
  const t = tool;
  const ov = override || {};
  const effDia = ov.diameter ?? t.diameter;
  return (
    <Modal
      open={open}
      title={`Edit T${t.n}${t.desc ? ` — ${t.desc}` : ''}`}
      width={440}
      destroyOnHidden
      onCancel={onClose}
      footer={(
        <Space>
          <Button onClick={onClearOverride} disabled={!edited}>Reset to detected</Button>
          <Button type="primary" onClick={onClose}>Done</Button>
        </Space>
      )}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div>
          <Text style={{ color: CAD.label, display: 'block', marginBottom: 4 }}>Name</Text>
          <Input
            value={ov.label ?? ''}
            placeholder={t.type}
            aria-label={`T${t.n} name (dialog)`}
            onChange={(e) => onOverride({ label: e.target.value || undefined })}
            style={{ width: 260 }}
          />
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>
            Only changes the label shown in the Tool table and the position readout — the
            simulation still reads the program's own tool comment.
          </Text>
        </div>

        {turning ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <div>
              <Text style={{ color: CAD.label, display: 'block', marginBottom: 4 }}>Holder</Text>
              <TurnInsertPicker
                value={holder?.id}
                onChange={(id) => onOverride({ insert: id })}
                custom={customTurnTools}
                onAdd={onAddCustom}
                onEdit={onEditCustom}
                onRemove={onRemoveCustom}
              />
            </div>
            <Space wrap size={12} align="center">
              <span>
                <Text style={{ color: CAD.label, marginRight: 6 }}>⌀</Text>
                <InputNumber controls={false}
                  size="small"
                  aria-label={`T${t.n} diameter`}
                  min={0.1}
                  step={0.5}
                  value={effDia}
                  placeholder="dia"
                  onChange={(v) => onOverride({ diameter: v ?? undefined })}
                  style={{ width: 80 }}
                />
              </span>
              {holder?.adjustable && (
                <span>
                  <Text style={{ color: CAD.label, marginRight: 6 }}>Insert°</Text>
                  <InputNumber controls={false}
                    size="small"
                    min={20}
                    max={100}
                    step={5}
                    value={ov.insertAngle ?? holder.angle}
                    onChange={(v) => onOverride({ insertAngle: v ?? holder.angle })}
                    style={{ width: 72 }}
                  />
                </span>
              )}
              {holder?.kind === 'boring' && (
                <Tooltip title="Boring bar shank diameter — standard sizes only; sets the marker's bar thickness, not the bore it cuts (that's the program's own X).">
                  <Space.Compact>
                    <span className="ant-input-group-addon" style={addonStyle('left')}>bar⌀</span>
                    <Select
                      size="small"
                      value={ov.barDiameter ?? BORING_BAR_DIAMETERS[0]}
                      onChange={(v) => onOverride({ barDiameter: v })}
                      options={BORING_BAR_DIAMETERS.map((d) => ({ value: d, label: `${d}` }))}
                      style={{ width: 72 }}
                    />
                  </Space.Compact>
                </Tooltip>
              )}
              {holder?.kind === 'parting' && (
                <Tooltip title="Groove width — the blade's kerf, both drawn and cut this wide.">
                  <Space.Compact>
                    <span className="ant-input-group-addon" style={addonStyle('left')}>w</span>
                    <InputNumber controls={false}
                      size="small"
                      aria-label={`T${t.n} groove width`}
                      min={0.5}
                      step={0.5}
                      value={ov.grooveW ?? null}
                      placeholder="3"
                      onChange={(v) => onOverride({ grooveW: v ?? undefined })}
                      style={{ width: 64 }}
                    />
                  </Space.Compact>
                </Tooltip>
              )}
            </Space>
          </Space>
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <div>
              <Text style={{ color: CAD.label, display: 'block', marginBottom: 4 }}>Cutter</Text>
              {/* The type, not just flat/ball: it is what the marker draws
                  and what the carvers stamp. */}
              <CutterPicker
                box={28}
                scope={`T${t.n}`}
                value={eff?.cutter}
                onChange={onCutter}
              />
            </div>
            <Space wrap size={12} align="center">
              <span>
                <Text style={{ color: CAD.label, marginRight: 6 }}>⌀</Text>
                <InputNumber controls={false}
                  size="small"
                  min={0.1}
                  step={0.5}
                  value={effDia}
                  placeholder="dia"
                  onChange={(v) => onOverride({ diameter: v ?? undefined })}
                  style={{ width: 80 }}
                />
              </span>
              {effSpec?.angleAdjustable && eff?.cutter && (
                <Tooltip title="Included angle — the chamfer this cutter leaves. 90° gives a 45° chamfer.">
                  <Space.Compact>
                    <span className="ant-input-group-addon" style={addonStyle('left')}>∠</span>
                    <InputNumber controls={false}
                      size="small"
                      min={15}
                      max={175}
                      step={5}
                      value={eff.angle}
                      onChange={(v) => onOverride({ angle: v || 90 })}
                      style={{ width: 64 }}
                    />
                  </Space.Compact>
                </Tooltip>
              )}
              {/* Thickness: the slot this tool leaves. Only the slot cutter
                  is specified that way. */}
              {effSpec?.thicknessAdjustable && eff?.cutter && (
                <Tooltip title="Cutter thickness — the width of the slot this tool leaves.">
                  <Space.Compact>
                    <span className="ant-input-group-addon" style={addonStyle('left')}>t</span>
                    <InputNumber controls={false}
                      size="small"
                      aria-label={`T${t.n} cutter thickness`}
                      min={effSpec.thicknessRange[0]}
                      max={effSpec.thicknessRange[1]}
                      step={0.5}
                      value={eff.thickness ?? null}
                      placeholder={String(defaultThickness(eff.cutter, eff.radius * 2))}
                      onChange={(v) => onThickness(v)}
                      style={{ width: 72 }}
                    />
                  </Space.Compact>
                </Tooltip>
              )}
              {/* Shank: a necked slot mill is narrower where the holder
                  grips it than where it cuts. */}
              {effSpec?.shankAdjustable && eff?.cutter && (
                <Tooltip title="Shank diameter — the plain part above the flutes, which the holder grips.">
                  <Space.Compact>
                    <span className="ant-input-group-addon" style={addonStyle('left')}>s⌀</span>
                    <InputNumber controls={false}
                      size="small"
                      aria-label={`T${t.n} shank diameter`}
                      min={effSpec.shankRange[0]}
                      max={effSpec.shankRange[1]}
                      step={0.5}
                      value={eff.shank ?? null}
                      placeholder={String(defaultShank(eff.cutter, eff.radius * 2))}
                      onChange={(v) => onShank(v)}
                      style={{ width: 72 }}
                    />
                  </Space.Compact>
                </Tooltip>
              )}
              <span>
                <Tooltip title="Gauge length — tip to the collet face (stick-out)">
                  <Text style={{ color: CAD.label, marginRight: 6 }}>L</Text>
                </Tooltip>
                <InputNumber controls={false}
                  size="small"
                  min={0}
                  step={1}
                  value={ov.length ?? t.length ?? undefined}
                  placeholder="len"
                  onChange={(v) => onOverride({ length: v ?? undefined })}
                  style={{ width: 76 }}
                />
              </span>
            </Space>
          </Space>
        )}
      </Space>
    </Modal>
  );
}
