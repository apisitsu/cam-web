/**
 * `TurnToolGlyph` — a little picture of the actual turning tool, used by both
 * the Tool table's insert picker (App.jsx) and the custom-holder dialog
 * (CustomTurnToolDialog.jsx) as its live preview. Pulled out to its own module
 * so those two can share it without an App.jsx <-> components/ import cycle.
 *
 * Modelled on the catalogue photos in image_tool/: a steel shank holding a
 * **gold rhombic insert** with a round clamp screw. The insert's nose angle is
 * the real ISO shape (V 35° narrow -> C 80° -> S 90° square), and the holder's
 * hand (`flip`) mirrors it, so MVJNR/MVVNN/DCLNR/SCLCR read as distinct real
 * tools. Boring bars reach in along the bore; the parting tool is a thin blade.
 * Driven entirely by the shape fields a `STANDARD_TURN_TOOLS` / custom-tool
 * entry already carries (`kind`, `angle`, `flip`) — there is no second,
 * independent drawing to keep in step with the marker geometry in
 * `engine/view/latheTool.js`.
 */

// Metallic palette for the realistic tool glyphs (fixed colours, like the real
// tool — the active state is shown by the button's highlighted background).
// Deliberately NOT theme tokens: these are steel and carbide, and the picture is
// only readable if it stays the colour of the thing. They are a shade deeper
// than a photograph would be because they are now drawn on a light button, where
// true bright steel would disappear into it.
const TG = {
  steel: '#b3bdcb', steelEdge: '#5d6a7c', steelHi: '#e7ecf3',
  gold: '#f0bc2c', goldEdge: '#8a5f0d', goldHi: '#fae09a',
  screw: '#5c4610',
};

export function TurnToolGlyph({ tool }) {
  // A gold ISO insert (rhombus of the given nose angle) with edge + clamp screw.
  const Insert = ({ ox, oy, p = 5.5, angle = tool.angle }) => {
    const q = p * Math.tan((angle * Math.PI) / 180 / 2);
    const d = `M${ox} ${oy - p} L${ox + q} ${oy} L${ox} ${oy + p} L${ox - q} ${oy} Z`;
    return (
      <>
        <path d={d} fill={TG.gold} stroke={TG.goldEdge} strokeWidth="0.8" strokeLinejoin="round" />
        <path d={`M${ox} ${oy - p * 0.6} L${ox + q * 0.55} ${oy}`} stroke={TG.goldHi} strokeWidth="0.7" fill="none" opacity="0.8" />
        <circle cx={ox} cy={oy} r="1.7" fill={TG.screw} />
        <circle cx={ox - 0.4} cy={oy - 0.4} r="0.7" fill={TG.goldHi} />
      </>
    );
  };
  let body;
  if (tool.kind === 'parting') {
    body = (
      <>
        <rect x="13.6" y="10" width="4.8" height="17" rx="1.2" fill={TG.steel} stroke={TG.steelEdge} strokeWidth="0.7" />
        <rect x="14.4" y="10.6" width="1" height="15" fill={TG.steelHi} opacity="0.7" />
        <rect x="12.8" y="5" width="6.4" height="6" rx="1.2" fill={TG.gold} stroke={TG.goldEdge} strokeWidth="0.8" />
        <circle cx="16" cy="8" r="1.5" fill={TG.screw} />
      </>
    );
  } else if (tool.kind === 'boring') {
    body = (
      <>
        <rect x="3" y="14.5" width="21" height="6.4" rx="3.2" fill={TG.steel} stroke={TG.steelEdge} strokeWidth="0.7" />
        <rect x="4" y="15.4" width="17" height="1.1" rx="0.5" fill={TG.steelHi} opacity="0.7" />
        <Insert ox={22} oy={11} p={4.6} />
      </>
    );
  } else {
    // OD holder: steel shank bar to the lower corner, gold insert at the tip. Drawn
    // right-handed; mirror for the other hand so the two 35° tools differ.
    body = (
      <g transform={tool.flip ? undefined : 'translate(32,0) scale(-1,1)'}>
        <path d="M12.5 12 L28 27.5" stroke={TG.steelEdge} strokeWidth="8.4" strokeLinecap="round" />
        <path d="M12.5 12 L28 27.5" stroke={TG.steel} strokeWidth="7" strokeLinecap="round" />
        <path d="M14 12.5 L26.5 25" stroke={TG.steelHi} strokeWidth="1.4" strokeLinecap="round" opacity="0.55" />
        <Insert ox={12} oy={11} p={5.6} />
      </g>
    );
  }
  return (
    <span role="img" className="anticon" style={{ display: 'inline-flex' }}>
      <svg viewBox="0 0 32 32" width="1.7em" height="1.7em" style={{ display: 'block' }}>{body}</svg>
    </span>
  );
}

export default TurnToolGlyph;
