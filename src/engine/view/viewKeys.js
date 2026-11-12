/**
 * SolidWorks' view keys, as actions the viewport carries out.
 *
 * Read from `event.code` (the key's place on the keyboard), not `event.key`, so the
 * shortcuts still work with the Thai layout switched on, where F types "ด".
 */
const STEP = Math.PI / 12; // 15°
const QUARTER = Math.PI / 2;
const PAN_PX = 40;
const ZOOM = 1.25;

/** Ctrl+1…7, as SolidWorks numbers its standard views. Ctrl+8 (Normal To) is the sketch's. */
export const VIEW_BY_DIGIT = {
  Digit1: 'front', Digit2: 'back', Digit3: 'left', Digit4: 'right',
  Digit5: 'top', Digit6: 'bottom', Digit7: 'iso',
};

const ARROWS = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

/** True when the key belongs to whatever is being typed into. */
export function typing(e) {
  const t = e.target;
  const tag = t?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(t?.isContentEditable);
}

/**
 * What a key press asks of the view, or null when it is not a view key.
 *
 * - Ctrl+1…7: a standard view · F: zoom to fit
 * - Arrows: rotate 15° · Shift+arrows: 90° · Ctrl+arrows: pan
 * - Z: zoom out · Shift+Z: zoom in
 */
export function viewKey(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.altKey) return null;
  if (ctrl && !e.shiftKey && VIEW_BY_DIGIT[e.code]) return { type: 'view', view: VIEW_BY_DIGIT[e.code] };
  const arrow = ARROWS[e.code];
  if (arrow) {
    if (ctrl) return { type: 'pan', x: arrow[0] * PAN_PX, y: arrow[1] * PAN_PX };
    const a = e.shiftKey ? QUARTER : STEP;
    return { type: 'orbit', left: arrow[0] * a, up: arrow[1] * a };
  }
  if (ctrl) return null;
  if (e.code === 'KeyF' && !e.shiftKey) return { type: 'fit' };
  if (e.code === 'KeyZ') return { type: 'zoom', factor: e.shiftKey ? ZOOM : 1 / ZOOM };
  return null;
}

/** The letter key `k`, by place on the keyboard or by what it types. */
export const keyIs = (e, k) => e.code === `Key${k.toUpperCase()}` || e.key?.toLowerCase() === k;
