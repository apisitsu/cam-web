/**
 * One button, one command, one name.
 *
 * Dropping a button's label costs it three things at once: a screen reader has
 * nothing to announce, a test has nothing to query, and a user who doesn't
 * recognise the glyph has nothing to hover for. This puts all three back from a
 * single source — `engine/view/commands.js` — so they cannot disagree:
 *
 * - `aria-label` is the command's name
 * - the tooltip is that same name, plus the line of description under it
 * - `data-cmd` is the id, which is how the component tests find the button now
 *   that there is no text in it to match on
 *
 * Passing `id` is therefore the whole API. Anything a caller supplies beyond it
 * (`icon`, `disabled`, `onClick`, `type`, `size`) goes to antd's Button
 * untouched; the label comes back automatically for the few commands the
 * catalogue marks `keepsText`.
 *
 * Written as a component rather than a helper function because antd's Tooltip
 * has to *be* the parent of the Button to position against it.
 */
import { Button, Tooltip } from 'antd';
import { command } from '../engine/view/commands.js';

/**
 * The tooltip body: name on top, description under it, the way a CAD toolbar
 * does it. Two lines rather than one sentence because the name is what you are
 * scanning for and the description is what you read once.
 */
function hintOf(cmd) {
  return (
    <span>
      <b>{cmd.label}</b>
      <span style={{ display: 'block', opacity: 0.82, fontSize: 12, marginTop: 2 }}>
        {cmd.hint}
      </span>
    </span>
  );
}

export default function CommandButton({ id, title, ...rest }) {
  const cmd = command(id);
  // Deliberately no `children`: the only text a command button may show is its
  // catalogue label, and only for the few commands marked `keepsText`. Taking a
  // child would leave the door open for a label to drift back onto a button
  // that is supposed to be a glyph — which is the exact state this replaced.
  return (
    // `title` lets a caller override the description for a button whose meaning
    // genuinely changes with state (the frame toggle says something different
    // when it is on); the name stays fixed either way.
    <Tooltip title={title ? <span><b>{cmd.label}</b><span style={{ display: 'block', opacity: 0.82, fontSize: 12, marginTop: 2 }}>{title}</span></span> : hintOf(cmd)}>
      <Button aria-label={cmd.label} data-cmd={id} {...rest}>
        {cmd.keepsText ? cmd.label : null}
      </Button>
    </Tooltip>
  );
}
