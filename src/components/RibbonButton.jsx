/**
 * One Ribbon button: a glyph with its name written underneath.
 *
 * The rest of this module follows the convention that a toolbar button is a bare
 * glyph named on hover (`CommandButton`, `engine/view/commands.js`). That is the
 * right trade on a narrow rail beside the viewport, and the wrong one on a docked
 * strip with room to spare: a row of twenty-odd small drawings has to be hovered
 * one by one before any of it can be read. SolidWorks' own CommandManager writes
 * the name under the icon for exactly that reason — so the Ribbon does too. This is
 * the agreed exception; narrow rails keep their glyph-only buttons.
 *
 * It is an antd `Button` (so hover, pressed, disabled and keyboard behaviour are
 * the ones the rest of the app has) that forwards its ref, because the Ribbon's
 * buttons are also the triggers of Popovers and Tooltips, which attach to their
 * child. The accessible name is the visible label.
 */
import { forwardRef } from 'react';
import { Button } from 'antd';
import { CAD } from '../theme.js';

const RibbonButton = forwardRef(function RibbonButton({
  icon, label, active = false, accent = false, danger = false, disabled = false, style, ...rest
}, ref) {
  let color;
  if (!disabled && !active) color = accent ? CAD.accent : CAD.icon;
  return (
    <Button
      ref={ref}
      type={active ? 'primary' : 'text'}
      danger={danger}
      disabled={disabled}
      data-ribbon-button={label}
      aria-label={typeof label === 'string' ? label : undefined}
      {...rest}
      style={{
        height: 'auto',
        minWidth: 46,
        maxWidth: 70,
        padding: '2px 4px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 1,
        lineHeight: 1.1,
        // Opt back in: the floating rail turns its own pointer events off so the
        // viewport underneath stays drawable, and each button turns them on again.
        pointerEvents: 'auto',
        color,
        ...style,
      }}
    >
      {/* Colour icons go grey when off, so a coloured one never looks ready to use. */}
      <span style={{
        fontSize: 22, display: 'inline-flex', alignItems: 'center', height: 24,
        filter: disabled ? 'grayscale(1)' : undefined, opacity: disabled ? 0.45 : 1,
      }}
      >
        {icon}
      </span>
      <span style={{ fontSize: 10.5, textAlign: 'center', whiteSpace: 'normal' }}>{label}</span>
    </Button>
  );
});

export default RibbonButton;
