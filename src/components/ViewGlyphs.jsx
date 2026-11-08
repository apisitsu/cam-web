/**
 * Isometric view-cube glyphs for the view presets (SolidWorks-style standard
 * views). The cube is drawn from the iso eye (+X, −Y, +Z) so its three visible
 * faces are Top (+Z, upper diamond), Front (−Y, lower-left) and Right (+X,
 * lower-right). Each preset highlights the face you'd be looking down:
 *   - solid accent  → that face is toward you (top / front / right / iso)
 *   - medium accent → the *opposite* (hidden) face, for back / left, which share
 *     a projected rhombus with front / right; the tooltip names the exact view.
 * Pure SVG on `currentColor`, so the glyph inherits the Segmented item's colour
 * (selected vs idle) automatically.
 */
const CUBE_FACES = {
  top: [[12, 3], [20, 7.5], [12, 12], [4, 7.5]],
  front: [[4, 7.5], [12, 12], [12, 21], [4, 16.5]],
  right: [[20, 7.5], [20, 16.5], [12, 21], [12, 12]],
};
function CubeGlyph({ face, whole = false, hollow = false }) {
  const op = (f) => {
    if (whole) return f === 'top' ? 0.42 : f === 'front' ? 0.3 : 0.18;
    if (f !== face) return 0.12;
    return hollow ? 0.45 : 0.95;
  };
  const poly = (f) => (
    <polygon
      points={CUBE_FACES[f].map((p) => p.join(',')).join(' ')}
      fill="currentColor"
      fillOpacity={op(f)}
      stroke="currentColor"
      strokeWidth="1"
      strokeLinejoin="round"
    />
  );
  return (
    <span role="img" className="anticon" style={{ display: 'inline-flex' }}>
      <svg viewBox="0 0 24 24" width="18" height="18" style={{ display: 'block' }}>
        {poly('top')}
        {poly('front')}
        {poly('right')}
      </svg>
    </span>
  );
}
const viewGlyph = (title, glyph) => ({
  title,
  label: <span title={title} style={{ display: 'inline-flex', padding: '1px 2px' }}>{glyph}</span>,
});
export const VIEWS = [
  { value: 'iso', ...viewGlyph('Isometric', <CubeGlyph whole />) },
  { value: 'top', ...viewGlyph('Top', <CubeGlyph face="top" />) },
  { value: 'front', ...viewGlyph('Front', <CubeGlyph face="front" />) },
  { value: 'back', ...viewGlyph('Back', <CubeGlyph face="front" hollow />) },
  { value: 'left', ...viewGlyph('Left', <CubeGlyph face="right" hollow />) },
  { value: 'right', ...viewGlyph('Right', <CubeGlyph face="right" />) },
];
