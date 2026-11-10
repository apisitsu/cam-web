/**
 * WorkspaceTabs — the strip under the viewport: Model, Program, Setup.
 *
 * They choose what the left column shows. The viewport stays as it is throughout,
 * because all three are read beside the part. The library is in File → Library.
 */
import { CAD } from '../theme.js';

const TABS = [
  { value: 'model', label: 'Model' },
  { value: 'program', label: 'Program' },
  { value: 'setup', label: 'Setup' },
];

export default function WorkspaceTabs({ active, onSelect, indent = 0 }) {
  return (
    <div
      role="tablist"
      aria-label="Workspace"
      data-workspace-tabs
      style={{
        flex: '0 0 auto',
        display: 'flex',
        paddingLeft: indent + 6,
        background: CAD.headerBg,
        borderTop: `1px solid ${CAD.border}`,
      }}
    >
      {TABS.map((t) => {
        const on = t.value === active;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={on}
            data-workspace-tab={t.value}
            onClick={() => onSelect(t.value)}
            style={{
              padding: '4px 12px',
              border: 0,
              borderTop: `2px solid ${on ? CAD.accent : 'transparent'}`,
              background: on ? CAD.panelBg : 'transparent',
              color: on ? CAD.text : CAD.label,
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: on ? 600 : 400,
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
