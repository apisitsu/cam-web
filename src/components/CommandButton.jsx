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

export default function CommandButton({ id, title, ...rest }) {
  const cmd = command(id);
  // Deliberately no `children`: the only text a command button may show is its
  // catalogue label, and only for the few commands marked `keepsText`. Taking a
  // child would leave the door open for a label to drift back onto a button
  // that is supposed to be a glyph — which is the exact state this replaced.
  return (
    // **The tooltip is the name and nothing else.** It used to carry the
    // catalogue's `hint` under it as a second line, the way SolidWorks does —
    // and on a rail of a dozen glyphs that turned every hover into a paragraph
    // to read past before you could act. What an operator wants from a hover is
    // *which button is this*, and they want it in the time it takes to move the
    // mouse. The `hint` is still in the catalogue, and still required of every
    // command, as the statement of what the button is for; it is documentation
    // now, not chrome.
    //
    // `title` overrides the name for a button whose meaning genuinely changes
    // with its state — the rotary frame toggle is a different command depending
    // on which way it is set, and the name should say so.
    <Tooltip title={title || cmd.label}>
      <Button aria-label={cmd.label} data-cmd={id} {...rest}>
        {cmd.keepsText ? cmd.label : null}
      </Button>
    </Tooltip>
  );
}
