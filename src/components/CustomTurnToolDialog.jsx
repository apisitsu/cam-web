/**
 * Add / edit one operator-defined turning holder.
 *
 * `STANDARD_TURN_TOOLS` (turning.js) is a fixed catalogue — real ISO holders,
 * but only the ones already typed in. An operator whose own tooling has a
 * different lead angle or insert shape had no way to make the marker match it.
 * This is a plain form over the same shape fields that catalogue entry already
 * uses (`kind`, `lead`, `sides`, `angle`, `flip`, `adjustable`, `insertTilt`,
 * `grooveW`) — camStore's `addCustomTurnTool`/`updateCustomTurnTool` just
 * append/patch `customTurnTools`, and `effectiveTurnTool` searches it
 * alongside the catalogue. No new rendering code: the preview below is the
 * exact `TurnToolGlyph` the picker and the Tool table already draw, driven by
 * the same fields, so there is nothing here that can draw a holder the marker
 * then draws differently.
 *
 * Cosmetic only, like the whole catalogue it extends — see `effectiveTurnTool`'s
 * own comment. The simulation reads cut mode from the program's tool comments,
 * never from this.
 */
import { useEffect, useState } from 'react';
import {
  Modal, Input, InputNumber, Select, Switch, Segmented, Space, Typography, Button, Tooltip,
} from 'antd';
import { useCamStore } from '../stores/camStore.js';
import { TurnToolGlyph } from './turnToolGlyph.jsx';
import { CAD } from '../theme.js';

const { Text } = Typography;

const KIND_OPTIONS = [
  { value: 'od', label: 'OD turning' },
  { value: 'boring', label: 'Boring bar (ID)' },
  { value: 'parting', label: 'Parting / grooving' },
];

// Per-kind defaults for a brand new holder, and what `setKind` resets to when
// switching type on an existing draft — a lead angle typed for an OD holder
// means nothing once the kind is Parting, same as `setCutter`'s own reasoning
// for dropping a stale thickness/shank in camStore.
const DEFAULTS = {
  od: {
    kind: 'od', lead: 93, sides: 4, angle: 35, flip: true, adjustable: false,
  },
  boring: {
    kind: 'boring', lead: 93, sides: 4, angle: 35, insertTilt: 0, adjustable: false,
  },
  parting: {
    kind: 'parting', lead: 90, sides: 4, angle: 3, grooveW: 3,
  },
};

const field = (label, node, title) => (
  <span>
    {title ? (
      <Tooltip title={title}><Text style={{ color: CAD.label, marginRight: 6 }}>{label}</Text></Tooltip>
    ) : (
      <Text style={{ color: CAD.label, marginRight: 6 }}>{label}</Text>
    )}
    {node}
  </span>
);

export default function CustomTurnToolDialog() {
  const dialog = useCamStore((s) => s.customToolDialog);
  const customTurnTools = useCamStore((s) => s.customTurnTools);
  const addCustomTurnTool = useCamStore((s) => s.addCustomTurnTool);
  const updateCustomTurnTool = useCamStore((s) => s.updateCustomTurnTool);
  const removeCustomTurnTool = useCamStore((s) => s.removeCustomTurnTool);
  const close = useCamStore((s) => s.closeCustomTurnToolDialog);
  const setTurnTool = useCamStore((s) => s.setTurnTool);

  const editing = dialog?.id ? customTurnTools.find((t) => t.id === dialog.id) : null;
  const isNew = !!dialog && !editing;

  const [draft, setDraft] = useState(null);

  // Re-seed the form every time a different holder (or a fresh "add") opens —
  // not on every store update, or typing in the name field would be fighting
  // its own re-render.
  useEffect(() => {
    if (!dialog) return;
    setDraft(editing ? { ...editing } : { label: '', ...DEFAULTS.od });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog?.id]);

  if (!dialog || !draft) return null;

  const patch = (p) => setDraft((d) => ({ ...d, ...p }));
  const setKind = (kind) => setDraft((d) => ({ ...DEFAULTS[kind], label: d.label }));

  const labelOk = draft.label.trim().length > 0;

  const save = () => {
    if (!labelOk) return;
    const clean = { ...draft, label: draft.label.trim() };
    if (editing) {
      updateCustomTurnTool(editing.id, clean);
    } else {
      const id = addCustomTurnTool(clean);
      setTurnTool(id);
    }
    close();
  };

  const remove = () => {
    if (editing) removeCustomTurnTool(editing.id);
    close();
  };

  return (
    <Modal
      open={!!dialog}
      title={isNew ? 'Add a turning holder' : `Edit "${editing?.label}"`}
      width={460}
      destroyOnHidden
      onCancel={close}
      footer={(
        <Space>
          {editing && <Button danger onClick={remove}>Delete</Button>}
          <Button onClick={close}>Cancel</Button>
          <Button type="primary" onClick={save} disabled={!labelOk}>
            {isNew ? 'Add' : 'Save'}
          </Button>
        </Space>
      )}
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Space align="center" size={16}>
          <div style={{
            width: 56,
            height: 56,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: CAD.surface,
            border: `1px solid ${CAD.borderSoft}`,
            borderRadius: 6,
            flex: '0 0 auto',
          }}
          >
            <div style={{ width: 32, height: 32 }}><TurnToolGlyph tool={draft} /></div>
          </div>
          <Input
            placeholder='Holder name, e.g. "SDQCR 107.5°"'
            value={draft.label}
            onChange={(e) => patch({ label: e.target.value })}
            status={labelOk ? undefined : 'error'}
            style={{ width: 260 }}
          />
        </Space>

        <div>
          <Text style={{ color: CAD.label, display: 'block', marginBottom: 4 }}>Type</Text>
          <Segmented value={draft.kind} onChange={setKind} options={KIND_OPTIONS} block />
        </div>

        {draft.kind !== 'parting' && (
          <Space wrap size={16}>
            {draft.kind === 'od' && field('Lead angle', (
              <InputNumber
                min={10}
                max={175}
                step={0.5}
                addonAfter="°"
                value={draft.lead}
                onChange={(v) => patch({ lead: v ?? DEFAULTS.od.lead })}
                style={{ width: 112 }}
              />
            ), "The holder's own approach angle.")}
            {field('Insert shape', (
              <Select
                value={draft.sides}
                onChange={(v) => patch({ sides: v })}
                options={[
                  { value: 3, label: 'Triangle' },
                  { value: 4, label: 'Diamond / square' },
                ]}
                style={{ width: 160 }}
              />
            ))}
            {field('Nose angle', (
              <InputNumber
                min={5}
                max={89}
                step={1}
                addonAfter="°"
                value={draft.angle}
                onChange={(v) => patch({ angle: v ?? DEFAULTS[draft.kind].angle })}
                style={{ width: 96 }}
              />
            ), 'Kept under 90° — the marker geometry has a singularity at a square-on insert.')}
          </Space>
        )}

        {draft.kind === 'od' && (
          <Space wrap size={16}>
            {field('Flip hand', (
              <Switch checked={!!draft.flip} onChange={(v) => patch({ flip: v })} />
            ), 'If the holder body points the wrong way in the preview, toggle this.')}
            {field('Insert angle adjustable', (
              <Switch checked={!!draft.adjustable} onChange={(v) => patch({ adjustable: v })} />
            ), "Lets the operator override this tool's nose angle per job, in the Tool table.")}
          </Space>
        )}

        {draft.kind === 'boring' && (
          <Space wrap size={16}>
            {field('Insert tilt', (
              <InputNumber
                min={-80}
                max={80}
                step={5}
                addonAfter="°"
                value={draft.insertTilt ?? 0}
                onChange={(v) => patch({ insertTilt: v ?? 0 })}
                style={{ width: 112 }}
              />
            ), 'A tilted insert loses the cosmetic bridge to the bar face — 0° keeps a straight bar.')}
            {field('Insert angle adjustable', (
              <Switch checked={!!draft.adjustable} onChange={(v) => patch({ adjustable: v })} />
            ))}
          </Space>
        )}

        {draft.kind === 'parting' && field('Groove width', (
          <InputNumber
            min={0.5}
            max={20}
            step={0.5}
            addonAfter="mm"
            value={draft.grooveW}
            onChange={(v) => patch({ grooveW: v ?? DEFAULTS.parting.grooveW })}
            style={{ width: 112 }}
          />
        ), 'The kerf — drawn and cut this wide.')}

        <Text type="secondary" style={{ fontSize: 11 }}>
          This only changes how the tool is drawn. Cutting is always read from the
          program's own tool comments, same as a catalogue holder.
        </Text>
      </Space>
    </Modal>
  );
}
