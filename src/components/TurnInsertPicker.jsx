import { Button, Tooltip, Popconfirm } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { STANDARD_TURN_TOOLS } from '../engine/sim/turning.js';
import { TurnToolGlyph } from './turnToolGlyph.jsx';
import { CAD } from '../theme.js';

/**
 * Icon picker for a tool's turning insert/holder — a row of glyph buttons (one per
 * catalogue holder), replacing the old dropdown. The selected holder is
 * highlighted; the full catalogue name is on each button's tooltip.
 *
 * `custom` (camStore's `customTurnTools`) is drawn after the catalogue, each
 * one dashed-bordered to read as operator-defined rather than a shop standard.
 * Its glyph is the same `TurnToolGlyph`, driven by the same shape fields, so a
 * custom holder looks exactly as consistent as a built-in one — there is no
 * second drawing code path to keep in step. Double-click edits; the small ×
 * deletes, behind a confirm since it is not reversible from the UI. The "+"
 * only appears when `onAdd` is given, so a read-only render of this list (were
 * one ever needed) can simply omit it.
 */
export default function TurnInsertPicker({
  value, onChange, custom = [], onAdd, onEdit, onRemove,
}) {
  return (
    <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
      {STANDARD_TURN_TOOLS.map((x) => (
        <Tooltip key={x.id} title={x.label} placement="top">
          <Button
            size="small"
            type={value === x.id ? 'primary' : 'text'}
            icon={<TurnToolGlyph tool={x} />}
            onClick={() => onChange(x.id)}
            style={{ width: 32, height: 32, padding: 0, color: value === x.id ? undefined : CAD.icon }}
          />
        </Tooltip>
      ))}
      {custom.map((x) => (
        <div key={x.id} style={{ position: 'relative' }}>
          <Tooltip title={`${x.label} — double-click to edit`} placement="top">
            <Button
              size="small"
              type={value === x.id ? 'primary' : 'text'}
              icon={<TurnToolGlyph tool={x} />}
              onClick={() => onChange(x.id)}
              onDoubleClick={() => onEdit?.(x.id)}
              style={{
                width: 32, height: 32, padding: 0, borderStyle: 'dashed',
                color: value === x.id ? undefined : CAD.icon,
              }}
            />
          </Tooltip>
          {onRemove && (
            <Popconfirm
              title={`Delete "${x.label}"?`}
              onConfirm={() => onRemove(x.id)}
              okText="Delete"
              okButtonProps={{ danger: true }}
              cancelText="Cancel"
              placement="top"
            >
              <button
                type="button"
                aria-label={`Delete ${x.label}`}
                style={{
                  position: 'absolute', top: -6, right: -6, width: 14, height: 14,
                  lineHeight: '12px', fontSize: 9, padding: 0, borderRadius: '50%',
                  background: CAD.surface, color: CAD.muted,
                  border: `1px solid ${CAD.borderSoft}`, cursor: 'pointer',
                }}
              >
                ✕
              </button>
            </Popconfirm>
          )}
        </div>
      ))}
      {onAdd && (
        <Tooltip title="Add a custom holder" placement="top">
          <Button
            size="small"
            type="dashed"
            icon={<PlusOutlined />}
            onClick={onAdd}
            style={{ width: 32, height: 32, padding: 0 }}
          />
        </Tooltip>
      )}
    </div>
  );
}
