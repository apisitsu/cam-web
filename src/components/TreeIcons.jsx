/**
 * The small glyphs the feature tree puts in front of each row.
 *
 * A tree of plain names reads as a list; a tree where the icon says *what kind
 * of thing* each row is — a sketch, an extrude, a revolve, an imported mesh — can
 * be scanned. That is the whole reason SolidWorks' FeatureManager does it, and it
 * is what these are for. They are inline SVG rather than antd icons because there
 * is no antd glyph for "extrude" and the rest should match it.
 *
 * Colours come from the CAD theme (`theme.js`), never literals, so a retheme moves
 * them with everything else. Decorative ones are `aria-hidden`: the row's own text
 * is the name. `LinkIcon` is the exception — it carries meaning the text does not
 * (this sketch follows a face), so it is an image with a label.
 */
import { CAD } from '../theme.js';

const base = {
  width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, style: { flex: '0 0 auto' },
};

export function SketchIcon({ active = false }) {
  return (
    <svg {...base} stroke={active ? CAD.accent : CAD.icon} strokeWidth="1.5" strokeLinecap="round">
      <rect x="2.5" y="4.5" width="9" height="7" />
      <path d="M10 13l4-6" />
    </svg>
  );
}

// `inverse` is for a row drawn on the accent colour (the selected one): the
// normal dark stroke and pale fill both vanish on it.
const ink = (inverse) => (inverse ? '#fff' : CAD.icon);
const fillOf = (inverse) => (inverse ? 'none' : CAD.panelBg);

export function ExtrudeIcon({ inverse = false }) {
  return (
    <svg {...base} stroke={ink(inverse)} strokeWidth="1.4" strokeLinejoin="round">
      <path d="M2 9l6 3 6-3V6L8 9 2 6z" fill={fillOf(inverse)} />
      <path d="M8 9v3M2 6l6-3 6 3" />
    </svg>
  );
}

export function RevolveIcon({ inverse = false }) {
  return (
    <svg {...base} stroke={ink(inverse)} strokeWidth="1.4" strokeLinecap="round">
      <path d="M4 2v12" strokeDasharray="2 1.5" />
      <path d="M4 4h4c2.5 0 4 1.7 4 4s-1.5 4-4 4H4" fill={fillOf(inverse)} />
    </svg>
  );
}

/** A hole seen from above and in section: a ring over a bore. */
export function HoleIcon({ inverse = false }) {
  return (
    <svg {...base} stroke={ink(inverse)} strokeWidth="1.4" strokeLinejoin="round">
      <path d="M2 5h12v9H2z" fill={fillOf(inverse)} />
      <path d="M6 5v6l2 2 2-2V5" />
    </svg>
  );
}

/** A corner cut off flat. */
export function ChamferIcon({ inverse = false }) {
  return (
    <svg {...base} stroke={ink(inverse)} strokeWidth="1.4" strokeLinejoin="round">
      <path d="M2 14V7l5-5h7v12z" fill={fillOf(inverse)} />
    </svg>
  );
}

/** A corner rounded. */
export function FilletIcon({ inverse = false }) {
  return (
    <svg {...base} stroke={ink(inverse)} strokeWidth="1.4" strokeLinejoin="round">
      <path d="M2 14V8a6 6 0 016-6h6v12z" fill={fillOf(inverse)} />
    </svg>
  );
}

/** A solid bent along a path. */
export function SweepIcon({ inverse = false }) {
  return (
    <svg {...base} stroke={ink(inverse)} strokeWidth="1.4" strokeLinejoin="round">
      <path d="M2 14V8a6 6 0 0 1 6-6h6v4H8a2 2 0 0 0-2 2v6z" fill={fillOf(inverse)} />
    </svg>
  );
}

/** A box hollowed out, open at the top. */
export function ShellIcon({ inverse = false }) {
  return (
    <svg {...base} stroke={ink(inverse)} strokeWidth="1.4" strokeLinejoin="round">
      <path d="M2 4v10h12V4h-2.5v7.5h-7V4z" fill={fillOf(inverse)} />
    </svg>
  );
}

/** Three copies of one block in a row. */
export function PatternIcon({ inverse = false }) {
  return (
    <svg {...base} stroke={ink(inverse)} strokeWidth="1.4" strokeLinejoin="round">
      <path d="M1.5 9h3.5v4.5H1.5zM6.25 9h3.5v4.5h-3.5zM11 9h3.5v4.5H11z" fill={fillOf(inverse)} />
      <path d="M1.5 6.5h13" strokeDasharray="1.5 1.5" />
    </svg>
  );
}

export function ImportIcon({ inverse = false }) {
  return (
    <svg {...base} stroke={ink(inverse)} strokeWidth="1.4" strokeLinejoin="round">
      <path d="M3 2h6l4 4v8H3z" fill={fillOf(inverse)} />
      <path d="M9 2v4h4" />
    </svg>
  );
}

/** The sketch is placed on a face of an earlier feature and follows it. */
export function LinkIcon({ title = 'Follows the face it was placed on' }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke={CAD.accent}
      strokeWidth="1.8"
      strokeLinecap="round"
      role="img"
      aria-label={title}
      style={{ flex: '0 0 auto' }}
      data-tree-link
    >
      <title>{title}</title>
      <path d="M7 9a3 3 0 004 0l2-2a3 3 0 00-4-4l-1 1M9 7a3 3 0 00-4 0L3 9a3 3 0 004 4l1-1" />
    </svg>
  );
}

/** The icon for a feature of this kind. */
export function FeatureIcon({ kind, inverse = false }) {
  if (kind === 'revolve') return <RevolveIcon inverse={inverse} />;
  if (kind === 'import') return <ImportIcon inverse={inverse} />;
  if (kind === 'hole') return <HoleIcon inverse={inverse} />;
  if (kind === 'chamfer') return <ChamferIcon inverse={inverse} />;
  if (kind === 'fillet') return <FilletIcon inverse={inverse} />;
  if (kind === 'pattern') return <PatternIcon inverse={inverse} />;
  if (kind === 'shell') return <ShellIcon inverse={inverse} />;
  if (kind === 'sweep' || kind === 'loft') return <SweepIcon inverse={inverse} />;
  return <ExtrudeIcon inverse={inverse} />;
}
