/**
 * The program listing's geometry: which rows are worth putting in the DOM, and
 * where the box has to sit to keep the executing line in view.
 *
 * ## Why this exists
 *
 * The listing used to render **every source line of the program**, and playback
 * re-renders it 25 times a second. On a 6,000-line program that is ~18,000 DOM
 * nodes reconciled per tick, plus a `scrollIntoView` forcing a synchronous
 * layout of the whole box on top of it — measured at ~250 ms of main thread per
 * frame against ~80 ms for the same run with the listing hidden. The result on
 * screen is the complaint that started this: the highlight does not follow what
 * is actually running, it lurches ~50 lines at a time, while single-stepping —
 * one update, nothing to keep up with — looked perfectly correct.
 *
 * So the listing draws a **window**: the rows on screen plus a few either side.
 * Cost becomes a function of the panel's height rather than the program's
 * length, which is what lets the panel be full height as well.
 *
 * Every row is exactly `lineHeight` tall — that is the whole trick, and it is
 * why `GcodePanel` states the height rather than letting the font decide it.
 */

/** Row height, in px. The panel sets this on each row; do not let them differ. */
export const LINE_H = 18;

/** Rows drawn beyond each edge, so a scroll of one row never shows a gap. */
export const OVERSCAN = 8;

/**
 * The slice of lines to render for a box scrolled to `scrollTop` and `height`
 * tall, with the padding that stands in for what is left out.
 *
 * `end` is exclusive, so it drops straight into `lines.slice(start, end)`.
 * `padTop`/`padBottom` keep the scrollbar the size the whole program deserves —
 * without them the box would shrink to the window and scrolling would stop.
 */
export function visibleRange({
  total, scrollTop = 0, height = 0, lineHeight = LINE_H, overscan = OVERSCAN,
}) {
  const empty = { start: 0, end: 0, padTop: 0, padBottom: 0 };
  if (!(total > 0) || !(height > 0) || !(lineHeight > 0)) return empty;
  const top = Math.max(0, scrollTop);
  const start = Math.max(0, Math.floor(top / lineHeight) - overscan);
  const onScreen = Math.ceil(height / lineHeight);
  const end = Math.min(total, start + onScreen + overscan * 2);
  return {
    start,
    end,
    padTop: start * lineHeight,
    padBottom: Math.max(0, (total - end) * lineHeight),
  };
}

/**
 * Where to scroll so the executing line is on screen — or `null` when it already
 * is, which is the important half: playback ticks 25 times a second and a panel
 * that re-scrolls every tick would take the box away from an operator reading
 * it.
 *
 * `line` is 1-based, the way `lineAt` reports it; 0 means nothing is running.
 *
 * Two behaviours, because a playhead moves two ways. Creeping past the edge
 * scrolls the least it can, keeping `margin` rows of context beyond the running
 * line so it is never flush against the frame. A jump of more than a screenful —
 * dragging the slider, restarting, or a fast run between two ticks — **centres**
 * instead: minimal scrolling would land the line hard against an edge with the
 * program it is about to run entirely off screen.
 */
export function followScrollTop({
  line, total, scrollTop = 0, height = 0, lineHeight = LINE_H, margin = 3,
}) {
  if (!(line > 0) || !(total > 0) || !(height > 0) || !(lineHeight > 0)) return null;
  const maxTop = Math.max(0, total * lineHeight - height);
  const clamp = (v) => Math.max(0, Math.min(maxTop, Math.round(v)));
  const rowTop = (Math.min(line, total) - 1) * lineHeight;
  const rowBottom = rowTop + lineHeight;
  const pad = margin * lineHeight;

  let next;
  if (rowBottom < scrollTop - height || rowTop > scrollTop + height * 2) {
    next = rowTop - (height - lineHeight) / 2;        // a jump: centre it
  } else if (rowTop - pad < scrollTop) {
    next = rowTop - pad;                              // crept off the top
  } else if (rowBottom + pad > scrollTop + height) {
    next = rowBottom + pad - height;                  // crept off the bottom
  } else {
    return null;                                      // already in view
  }
  const at = clamp(next);
  return at === scrollTop ? null : at;
}
