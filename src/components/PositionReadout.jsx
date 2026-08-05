/**
 * POSITION — the control's position page, floated over the viewport: the
 * absolute work position per axis, and beside it the DISTANCE TO GO on the block
 * in progress, the pair a control posts together.
 *
 * Thin by design: every decision it renders (which axes, what number, whether to
 * appear at all) comes from `engine/view/dro.js`, which is tested. This file only
 * maps those rows onto JSX and styles them like a readout.
 */
import { droRows, showDro, droXNote, droFooter } from '../engine/view/dro.js';

/** Width of the distance-to-go column, wide enough for -1234.567. */
const DTG_W = 74;

const PANEL = {
  position: 'absolute', top: 12, right: 12, zIndex: 5,
  background: 'rgba(15,23,42,0.82)', border: '1px solid #334155',
  borderRadius: 8, padding: '8px 12px 6px',
  minWidth: 262, pointerEvents: 'none',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

const HEADING = {
  display: 'flex', alignItems: 'baseline', gap: 8,
  color: '#64748b', fontSize: 10, letterSpacing: 0.8,
  textTransform: 'uppercase', marginBottom: 6, whiteSpace: 'nowrap',
};

const ROW = {
  display: 'flex', alignItems: 'baseline', gap: 8,
  lineHeight: 1.45,
};

const LABEL = { color: '#38bdf8', fontSize: 13, fontWeight: 700, width: 22 };

const VALUE = {
  color: '#e2e8f0', fontSize: 16, flex: 1, textAlign: 'right',
  // A live readout whose digits are different widths visibly shimmers as it
  // counts; tabular figures keep the columns still.
  fontVariantNumeric: 'tabular-nums',
};

// Dimmer and a size down: the absolute position is what the eye should land on
// first, with the countdown beside it as support.
const DTG = {
  color: '#94a3b8', fontSize: 14, width: DTG_W, textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};

const UNIT = { color: '#475569', fontSize: 10, width: 22 };

const FOOTER = {
  display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6, paddingTop: 5,
  borderTop: '1px solid #1e293b', color: '#64748b', fontSize: 11,
};

// The tool's own name, one step brighter than the rest of the footer: it is the
// only line on the panel that cannot be checked against the machine by eye.
const TOOL_NAME = {
  color: '#cbd5e1', flex: 1, overflow: 'hidden',
  textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

// Feed and speed sit on their own row, read as a pair, and are laid out as one:
// a letter, the number right-aligned under the position column above it, then
// the unit — so F and S line up with each other and with the axes.
const RATES = {
  display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 3,
  color: '#64748b', fontSize: 11,
};

const RATE_VALUE = {
  color: '#e2e8f0', fontSize: 13, fontVariantNumeric: 'tabular-nums',
};

/**
 * @param {object} props
 * @param {number[]|null} props.point tool tip in program coordinates
 * @param {number[]|null} props.target end point of the block in progress
 * @param {'mill'|'turn'} props.mode
 * @param {boolean} props.diameterMode lathe: the X word is a diameter
 * @param {{a:number,b:number}|null} props.rotary index at the playhead
 * @param {number[]} props.aIndices distinct A values in the program
 * @param {number} props.toolNumber tool in effect (0 = none stated)
 * @param {object|null} props.tool what that tool is — see `droTool`
 * @param {object|null} props.running feed/rpm at the playhead — see `runningAt`
 * @param {number} props.line 1-based source line executing
 * @param {boolean} props.sketching
 * @param {number} props.count segments in the program
 */
export default function PositionReadout({
  point = null, target = null, mode = 'mill', diameterMode = true, rotary = null,
  aIndices = null, toolNumber = 0, tool = null, running = null, line = 0,
  sketching = false, count = 0,
}) {
  if (!showDro({ sketching, count })) return null;

  const rows = droRows(point, { mode, diameterMode, rotary, aIndices, target });
  const xNote = droXNote({ mode, diameterMode });
  const foot = droFooter({ toolNumber, tool, running, line });

  return (
    <div style={PANEL} data-testid="position-readout">
      {/* Column captions live in the heading rather than a row of their own, so
          the panel still reads as one page and not two stacked tables. */}
      <div style={HEADING}>
        <span style={{ flex: 1 }}>Position (Absolute)</span>
        <span style={{ width: DTG_W, textAlign: 'right' }}>Dist to go</span>
        <span style={{ width: 22 }} />
      </div>
      {rows.map((r) => (
        <div key={r.label} style={ROW}>
          <span style={LABEL}>
            {r.label}
            {r.label === 'X' && xNote ? (
              <span style={{ color: '#475569', fontWeight: 400 }}>{xNote}</span>
            ) : null}
          </span>
          <span style={VALUE}>{r.text}</span>
          <span style={DTG} data-dtg={r.label}>{r.dtgText}</span>
          <span style={UNIT}>{r.unit}</span>
        </div>
      ))}
      <div style={FOOTER}>
        <span data-dro="tool">{foot.tool.number}</span>
        {foot.tool.name ? (
          <span style={TOOL_NAME} data-dro="toolName">{foot.tool.name}</span>
        ) : <span style={{ flex: 1 }} />}
        <span data-dro="line">{foot.line}</span>
      </div>
      <div style={RATES}>
        <span>F</span>
        <span style={{ ...RATE_VALUE, flex: 1, textAlign: 'right' }} data-dro="feed">
          {foot.feed.text}
        </span>
        <span style={{ width: 46 }}>{foot.feed.unit}</span>
        <span>S</span>
        <span style={{ ...RATE_VALUE, width: 52, textAlign: 'right' }} data-dro="spindle">
          {foot.spindle.text}
        </span>
        <span style={{ width: 22 }}>{foot.spindle.unit}</span>
      </div>
    </div>
  );
}
