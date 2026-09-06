/**
 * Symbolic glyphs, drawn rather than named.
 *
 * The sketcher's rail already worked this way; the rest of the app did not, and
 * kept its buttons legible by spelling them out. Pulling the helper out of
 * `SketchToolbar.jsx` is what lets the CAM panel, the sidebar and the viewport
 * bar drop their labels too without each inventing its own drawing conventions.
 *
 * Every glyph is a 24×24 line drawing on the same stroke weight and the same
 * cap/join, because a toolbar reads as a toolbar only when the symbols look like
 * they came from one hand. Where an antd icon already says the thing plainly
 * (save, download, undo) it is used as-is — a hand-drawn floppy disk would be
 * worse, not more consistent.
 *
 * The shapes follow SolidWorks' vocabulary where it has one: a part is an
 * isometric solid, machining a face is a swept arrow across a surface, a rotary
 * is an arrow curling about a centreline. That is not decoration — an operator
 * who knows SolidWorks should be able to read this toolbar without hovering
 * anything, and the tooltip is there for everyone else.
 */

/** Wrap an SVG path set as an antd-compatible icon. */
export const glyph = (node) => function Glyph() {
  return (
    <span role="img" className="anticon" style={{ display: 'inline-flex' }}>
      <svg
        viewBox="0 0 24 24" width="1em" height="1em" fill="none"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      >
        {node}
      </svg>
    </span>
  );
};

// ---- Parts and stock -------------------------------------------------------

/** An isometric solid — SolidWorks' part. Used for the model and for importing one. */
export const PartIcon = glyph(
  <>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5l8 4.5 8-4.5M12 12v9" opacity="0.6" />
  </>,
);

/** A plain isometric billet — the raw stock block, drawn or hidden. */
export const StockIcon = glyph(
  <>
    <path d="M4 8l8-4 8 4-8 4z" />
    <path d="M4 8v8l8 4 8-4V8" />
    <path d="M12 12v8" opacity="0.6" />
  </>,
);

/** A block with a step cut out of it — material removed, the height-field sim. */
export const StockCutIcon = glyph(
  <>
    <path d="M4 20V8h6V4h10v16z" />
    <path d="M10 8h10" opacity="0.55" />
  </>,
);

/** A cube built of cells — the voxel model, undercuts and all. */
export const VoxelIcon = glyph(
  <>
    <rect x="4" y="4" width="7.5" height="7.5" />
    <rect x="12.5" y="4" width="7.5" height="7.5" opacity="0.55" />
    <rect x="4" y="12.5" width="7.5" height="7.5" opacity="0.55" />
    <rect x="12.5" y="12.5" width="7.5" height="7.5" />
  </>,
);

/** A bar on centre with an insert at it — turning. */
export const TurningIcon = glyph(
  <>
    <path d="M3 12h18" strokeDasharray="4 3" opacity="0.6" />
    <path d="M5 7.5h11v9H5z" />
    <path d="M20 4l-3.5 3.5" />
  </>,
);

// ---- Machining a picked feature -------------------------------------------

/** A cutter sweeping across a surface — facing off the picked face. */
export const ClearFaceIcon = glyph(
  <>
    <path d="M3 17h18" />
    <path d="M7 13h6v-3H7z" />
    <path d="M15 11.5h5M18 9.5l2 2-2 2" opacity="0.8" />
  </>,
);

/** A path running round an outline — tracing the picked edge. */
export const ContourIcon = glyph(
  <>
    <path d="M5 19V9l5-5h9v15z" strokeDasharray="3 2.2" opacity="0.65" />
    <path d="M8 16V10l4-4h6" />
    <circle cx="8" cy="16" r="1.6" fill="currentColor" stroke="none" />
  </>,
);

// ---- The rotary ------------------------------------------------------------

/** An arrow curling about a centreline — the table turning the work. */
export const RotateWorkIcon = glyph(
  <>
    <path d="M3 12h18" strokeDasharray="4 3" opacity="0.6" />
    <path d="M8 7.2A6 6 0 0 1 17.6 9" />
    <path d="M17.8 5.4V9h-3.6" />
    <path d="M16 16.8A6 6 0 0 1 6.4 15" />
    <path d="M6.2 18.6V15h3.6" />
  </>,
);

/** A face turned up to the spindle — which way the part sits at A0. */
export const A0FaceIcon = glyph(
  <>
    <path d="M4 15l8-4 8 4-8 4z" />
    <path d="M12 8V2M9.5 4.5L12 2l2.5 2.5" />
  </>,
);

/** A crosshair on a centreline — where the rotary physically pivots. */
export const RotaryCentreIcon = glyph(
  <>
    <path d="M2 12h20" strokeDasharray="4 3" opacity="0.6" />
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 5.5v13" />
  </>,
);

// ---- The tool --------------------------------------------------------------

/** A cutter in its holder — the collet that hides the cut when it is drawn. */
export const ArborIcon = glyph(
  <>
    <path d="M8 3h8l-1.5 4h-5z" />
    <path d="M10.5 7h3v6h-3z" />
    <path d="M10.5 13h3v5h-3z" opacity="0.6" />
  </>,
);

/**
 * The programmed path — a run of moves with a rapid dashing back over it. The
 * two colours the viewport draws it in cannot be used here (a glyph is one
 * `currentColor`), so the rapid is the dashed leg and the feed the solid one.
 */
export const ToolpathIcon = glyph(
  <>
    <path
      d="M4 17 L8 9 L12 15 L16 6 L20 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M4 17 L20 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeDasharray="2 2"
      opacity="0.55"
    />
  </>,
);

// ---- Planning --------------------------------------------------------------

/** A wand — the planner proposing the whole job on its own. */
export const AutoPlanIcon = glyph(
  <>
    <path d="M4 20L15 9" />
    <path d="M13 7l2-2 2 2-2 2z" />
    <path d="M19 4v3M20.5 5.5h-3M18.5 11v2M19.5 12h-2" opacity="0.8" />
  </>,
);

// ---- Milling cutter types (see engine/cam/cutters.js) ----------------------
// Each glyph is the tool's silhouette, tip down, the way it stands in the
// spindle — square end, 90° shoulder, wide shallow disc, two-flute slot drill,
// round nose, conical point. Recognisable side by side is the whole job.

/** Square-ended endmill: a plain stick with a flat bottom. */
export const EndmillIcon = glyph(
  <>
    <path d="M9 3h6v15H9z" />
    <path d="M9 9h6M9 13h6" opacity="0.5" />
  </>,
);

/** Shoulder mill: a short body cutting a true 90° corner. */
export const ShoulderMillIcon = glyph(
  <>
    <path d="M8 4h8v9H8z" />
    <path d="M3 20h5V13" />
    <path d="M16 13v7h5" opacity="0.5" />
  </>,
);

/** Face mill: a wide shallow disc on a stub arbor. */
export const FaceMillIcon = glyph(
  <>
    <path d="M10 3h4v6h-4z" />
    <path d="M3 9h18v6H3z" />
    <path d="M7 15v2M12 15v2M17 15v2" />
  </>,
);

/** Slot mill: two flutes, cutting a full-width slot. */
export const SlotMillIcon = glyph(
  <>
    <path d="M10 3h4v12h-4z" />
    <path d="M4 21v-5h16v5" opacity="0.55" />
    <path d="M12 5v10" opacity="0.5" />
  </>,
);

/** Ball nose: a stick with a hemispherical end. */
export const BallMillIcon = glyph(
  <>
    <path d="M9 3v11a3 3 0 0 0 6 0V3z" />
    <path d="M9 10h6" opacity="0.5" />
  </>,
);

/** Chamfer mill: a conical point breaking an edge. */
export const ChamferMillIcon = glyph(
  <>
    <path d="M9 3h6v8l-3 6-3-6z" />
    <path d="M4 20h4l4-3" opacity="0.55" />
  </>,
);

/**
 * Twist drill: a long body, the two helical flutes running up it, and the point
 * ground on the end. Told from the chamfer mill beside it by the flutes and by
 * how far it reaches — the two share a cone and are not remotely the same tool.
 */
export const DrillIcon = glyph(
  <>
    <path d="M9 2h6v13l-3 5-3-5z" />
    <path d="M9.6 5.5 14.4 8M9.6 10.5l4.8 2.5" opacity="0.55" />
  </>,
);

/** Icon per cutter id, for the type picker. */
export const CUTTER_ICONS = {
  endmill: EndmillIcon,
  shoulder: ShoulderMillIcon,
  face: FaceMillIcon,
  slot: SlotMillIcon,
  ball: BallMillIcon,
  chamfer: ChamferMillIcon,
  drill: DrillIcon,
};
