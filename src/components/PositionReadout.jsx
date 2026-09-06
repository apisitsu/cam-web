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
import { CAD } from '../theme.js';

/**
 * Sizes below are a machine control's, not a web panel's: this is read from a
 * step or two back while your hands are elsewhere, the same way the DRO on the
 * machine is, so the position digits are deliberately large and everything else
 * is sized in proportion to them.
 */

/** Width of the distance-to-go column, wide enough for -1234.567. */
const DTG_W = 94;

const PANEL = {
  position: 'absolute', top: 12, right: 12, zIndex: 5,
  background: CAD.glass, border: `1px solid ${CAD.border}`,
  // A light panel over a light viewport needs the shadow to read as floating;
  // over the old near-black one, contrast alone did that job.
  borderRadius: 5, boxShadow: '0 3px 14px rgba(23,42,66,0.20)',
  backdropFilter: 'blur(2px)',
  padding: '11px 16px 9px',
  minWidth: 340, pointerEvents: 'none',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

const HEADING = {
  display: 'flex', alignItems: 'baseline', gap: 10,
  color: CAD.muted, fontSize: 11, letterSpacing: 0.8,
  textTransform: 'uppercase', marginBottom: 7, whiteSpace: 'nowrap',
};

const ROW = {
  display: 'flex', alignItems: 'baseline', gap: 10,
  lineHeight: 1.4,
};

const LABEL = { color: CAD.accent, fontSize: 17, fontWeight: 700, width: 30 };

const VALUE = {
  color: CAD.text, fontSize: 23, flex: 1, textAlign: 'right',
  // A live readout whose digits are different widths visibly shimmers as it
  // counts; tabular figures keep the columns still.
  fontVariantNumeric: 'tabular-nums',
};

// Dimmer and a size down: the absolute position is what the eye should land on
// first, with the countdown beside it as support.
const DTG = {
  color: CAD.label, fontSize: 18, width: DTG_W, textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};

const UNIT = { color: CAD.dim, fontSize: 12, width: 28 };

const FOOTER = {
  display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8, paddingTop: 6,
  borderTop: `1px solid ${CAD.borderSoft}`, color: CAD.muted, fontSize: 13,
};

// The tool's own name, one step brighter than the rest of the footer: it is the
// only line on the panel that cannot be checked against the machine by eye.
const TOOL_NAME = {
  color: CAD.icon, flex: 1, overflow: 'hidden',
  textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

// Feed and speed sit on their own row, read as a pair, and are laid out as one:
// a letter, the number right-aligned under the position column above it, then
// the unit — so F and S line up with each other and with the axes.
const RATES = {
  display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 4,
  color: CAD.muted, fontSize: 13,
};

const RATE_VALUE = {
  color: CAD.text, fontSize: 16, fontVariantNumeric: 'tabular-nums',
};

// The per-rev feed a lathe program actually states, under the mm/min the machine
// is running at. Small and dim on purpose: the rate above it is the number to
// read, and this is here to be checked against the program text when asked.
const FEED_NOTE = {
  color: CAD.dim, fontSize: 11, textAlign: 'right', marginTop: 1,
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
    <div style={PANEL} data-cam-overlay="right" data-testid="position-readout">
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
              <span style={{ color: CAD.dim, fontWeight: 400 }}>{xNote}</span>
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
        <span style={{ width: 54 }}>{foot.feed.unit}</span>
        <span>S</span>
        <span style={{ ...RATE_VALUE, width: 62, textAlign: 'right' }} data-dro="spindle">
          {foot.spindle.text}
        </span>
        <span style={{ width: 28 }}>{foot.spindle.unit}</span>
      </div>
      {foot.feed.note && (
        <div style={FEED_NOTE} data-dro="feedNote">
          programmed F{foot.feed.note}
        </div>
      )}
    </div>
  );
}
