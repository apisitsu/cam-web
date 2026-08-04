/**
 * Milling tool-marker geometry — the numbers behind the cutter, shank and arbor
 * drawn at the tool tip.
 *
 * This arithmetic used to sit inside `EndMill` in `Viewport.jsx`. It is exactly
 * the kind the project keeps out of components: four stacked cylinders whose
 * lengths and centres are derived from a gauge length that may or may not be
 * known, with clamps at both ends. A mistake here does not throw — it draws a
 * tool floating above its own tip, or a shank of negative length, and only a
 * person looking at the screen would notice.
 *
 * Everything is in the tip's local frame: **+Z runs up the tool, 0 is the tip**.
 * The caller rotates the cylinders to stand up in world Z.
 *
 * Pure. No three.js, no React.
 */

import { cutterById, defaultThickness, defaultShank } from '../cam/cutters.js';

/** Arbor (collet/holder) length in mm — a fixed lump, it is not to scale. */
export const ARBOR_LENGTH = 26;

/**
 * The four parts of the marker, as plain data.
 *
 * `length` is the gauge length from the tool table — tip to the collet face. When
 * it is known the flutes and shank span exactly that far, so the stick-out is to
 * scale; when it is not, a plausible default stands in. Below the flute length
 * there is no room for a shank at all, hence the clamp.
 *
 * `cutter` is the *type* from `cam/cutters.js`, and it changes the silhouette,
 * not just the tip: a Ø50 face mill is a wide short disc and a Ø6 slot drill is
 * a long thin stick, and a marker that draws them the same tells you nothing
 * about whether the holder will clear the fixture. `bodyRatio` on each cutter
 * is what sets the flute length when the tool table has not given a real one.
 *
 * `thickness` is the cutting body's own length along the tool, when the
 * operator knows it: a slot cutter's is the depth of cut it can take, which no
 * ratio on the diameter can imply. Without one, `bodyRatio` stands in.
 *
 * `shank` is that part's diameter. A necked slot mill runs a wide body on a
 * narrow shank so the shank clears the walls of the slot it just cut, and the
 * **holder is sized off the shank it grips** rather than off the cutter — which
 * is the whole reason a necked tool reaches where a plain one cannot.
 *
 * @param {{radius?:number, type?:'flat'|'ball'|'cone', cutter?:string,
 *   angle?:number, thickness?:number, shank?:number, length?:number,
 *   arbor?:boolean}} opts
 *   `arbor: false` omits the holder — it is the widest thing on the tool and it
 *   hides the cut it is making. See `showArbor` in camStore.
 * @returns {{nose:object|null, flutes:object, shank:object, arbor:object|null,
 *   gauge:number}} each part as `{radius|rBottom/rTop, length, z}` where `z` is
 *   the mesh centre along the tool axis. `nose.kind` is 'ball' or 'cone'.
 */
export function endMillGeometry({
  radius = 3, type = 'flat', cutter, angle, thickness, shank, length = 0, arbor = true,
} = {}) {
  const r = Math.max(radius, 1e-6);
  const spec = cutter ? cutterById(cutter) : null;
  const profile = spec ? spec.profile : type;

  // The nose occupies the bottom of the tool, so the flutes start above it: a
  // ball's hemisphere is `r` tall, a cone's point is `r / tan(half-angle)`.
  const coneRise = r / Math.tan((Math.max(1, Math.min(89.9,
    (angle ?? spec?.angle ?? 90) / 2)) * Math.PI) / 180);
  const noseOffset = profile === 'ball' ? r : (profile === 'cone' ? coneRise : 0);
  // A face mill's flutes are a shallow band; an endmill's are most of its
  // stick-out. A stated thickness beats both — it is how far up the tool the
  // operator says it actually cuts.
  const flute = thickness > 0
    ? Math.max(0.2, thickness)
    : (spec ? defaultThickness(spec.id, r * 2) : Math.max(8, r * 4));
  const gauge = Math.max(length > 0 ? length : flute + r * 3, flute + 1);
  const fluteLen = Math.min(flute, gauge - noseOffset);
  const shankR = shank > 0 ? Math.max(shank / 2, 0.05) : defaultShank(spec?.id, r * 2) / 2;
  // The collet grips the SHANK, so that is what sizes it — but only where the
  // operator has actually stated one. Left implied, the holder goes on being
  // sized off the cutter, exactly as every existing tool draws it.
  const holdR = shank > 0 ? shankR : r;
  const arborR = Math.max(holdR * 1.8, holdR + 4);
  const shankBot = noseOffset + fluteLen;
  // Never zero-length: a degenerate cylinder renders as a glitch, not as nothing.
  const shankLen = Math.max(0.01, gauge - shankBot);

  return {
    nose: profile === 'ball'
      ? { kind: 'ball', radius: r, height: r, z: r }
      : profile === 'cone'
        // Drawn as a cone standing on its point: zero radius at the tip,
        // full radius where the flutes begin.
        ? { kind: 'cone', radius: r, height: coneRise, z: coneRise / 2 }
        : null,
    flutes: { radius: r, length: fluteLen, z: noseOffset + fluteLen / 2 },
    shank: { radius: shankR, length: shankLen, z: shankBot + shankLen / 2 },
    arbor: arbor
      ? {
          rBottom: arborR,
          rTop: arborR * 0.7,
          length: ARBOR_LENGTH,
          z: gauge + ARBOR_LENGTH / 2,
        }
      : null,
    gauge,
  };
}

/**
 * Should the show/hide-arbor control be offered at all?
 *
 * Only for milling: the lathe marker is a holder drawn in the cutting plane (see
 * `latheTool.js`), not a collet above the tool, so the toggle would do nothing
 * there — and a dead control is worse than no control. The sketch page has no
 * tool at all.
 */
export function offerArborToggle({ mode = 'mill', sketching = false } = {}) {
  return !sketching && mode === 'mill';
}

/**
 * Where to park the tool marker when the machine is not running.
 *
 * With no program loaded — or with the playhead still at zero — there is no
 * tool position, so the viewport drew no tool at all. That is defensible for a
 * *position* readout and useless for a *setup*: picking a face mill and seeing
 * nothing change is indistinguishable from a picker that does not work, which
 * is exactly what it was mistaken for.
 *
 * A real machine does not make the cutter vanish between programs either; it
 * sits at the tool change position with the tool in the spindle. So the marker
 * parks over the middle of whatever it will be cutting, clear of the top of it:
 * on the stock if a blank is defined, else over the toolpath, else at the work
 * origin. The point is to have the chosen tool visible, to scale, against the
 * material it will meet.
 *
 * Clearance scales with the cutter so a Ø63 face mill does not park with its
 * flutes buried in the billet, with a floor so a Ø1 engraver is still clear.
 *
 * @param {{solid?:{center:number[], size:number[]}|null,
 *   bounds?:{min:number[], max:number[]}|null, radius?:number}} opts
 * @returns {[number,number,number]} the tool TIP, in machine coordinates
 */
export function parkedTip({ solid, bounds, radius = 3 } = {}) {
  const clear = Math.max(10, radius * 2);
  if (solid) {
    const [cx, cy, cz] = solid.center;
    return [cx, cy, cz + solid.size[2] / 2 + clear];
  }
  const known = bounds?.min && bounds?.max
    && bounds.min.every(Number.isFinite) && bounds.max.every(Number.isFinite);
  if (known) {
    return [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      bounds.max[2] + clear,
    ];
  }
  return [0, 0, clear];
}
