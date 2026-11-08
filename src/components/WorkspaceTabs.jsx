/**
 * WorkspaceTabs — the strip under the viewport: Model, Program, Simulation, Library.
 *
 * They are ways to reach panels that already exist, not new pages: Model and Program
 * choose what the left column shows, and Simulation and Library open the drawer. The
 * viewport stays as it is throughout, because all four are read beside the part.
 */
import { CAD } from '../theme.js';

const TABS = [
  { value: 'model', label: 'Model' },
  { value: 'program', label: 'Program' },
  { value: 'simulation', label: 'Simulation' },
  { value: 'library', label: 'Library' },
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
