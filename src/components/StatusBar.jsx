/**
 * The status bar — one line along the bottom that says where you are.
 *
 * A CAD keeps three facts permanently in view that are otherwise easy to lose:
 * what you are editing, what is selected, and whether the model is up to date.
 * The first two used to be implied by which panel happened to be open, and the
 * third by a small dot on a button inside the tree — so "is what I am looking at
 * current?" had no single place to be answered.
 *
 * **Only real values are shown.** No coordinates, no solve state: this module has
 * no live cursor position or constraint-state to report, and a bar that printed
 * placeholder numbers would teach people to ignore it. Every field below comes
 * from a store the app already keeps.
 *
 * It is docked *outside* the viewport (a sibling of the working area, not an
 * overlay), so the camera fit needs no knowledge of it — the same reason the
 * feature tree is a real `Sider`.
 */
import { Typography } from 'antd';
import { CAD } from '../theme.js';
import { useCamStore } from '../stores/camStore.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { planeLabel } from '../engine/sketch/plane.js';

const { Text } = Typography;

const PAGE_NAMES = { mill: 'Milling', turn: 'Turning', sketch: 'Sketch' };

/** What the operator is working on, in a few words. Exported for the tests. */
export function modeText({ page, sketchName, plane, fileName }) {
  if (page === 'sketch') {
    return sketchName ? `Editing ${sketchName}${plane ? ` · ${plane}` : ''}` : 'Sketch';
  }
  const name = PAGE_NAMES[page] || 'Ready';
  return fileName ? `${name} · ${fileName}` : name;
}

/** What is selected: a picked face first (it is what a click on the part makes), else the tree's own selection. */
export function selectionText({ face, featureName }) {
  if (face) {
    const bits = ['Face'];
    if (face.facing) bits.push(face.facing);
    if (Number.isFinite(face.area)) bits.push(`${Math.round(face.area * 10) / 10} mm²`);
    return bits.join(' · ');
  }
  return featureName || 'Nothing selected';
}

/** Whether the tree matches the part on screen — said in words, not only by colour. */
export function treeText({ count, dirty, errors }) {
  if (!count) return 'No features yet';
  const n = `${count} feature${count === 1 ? '' : 's'}`;
  if (errors) return `${n} · ${errors} failed`;
  return dirty ? `${n} · out of date — Rebuild` : `${n} · up to date`;
}

export default function StatusBar() {
  const page = useCamStore((s) => s.page);
  const fileName = useCamStore((s) => s.fileName);
  const sketches = useSketchStore((s) => s.sketches);
  const activeId = useSketchStore((s) => s.activeId);
  const features = useFeatureStore((s) => s.features);
  const dirty = useFeatureStore((s) => s.dirty);
  const errors = useFeatureStore((s) => s.errors);
  const selectedId = useFeatureStore((s) => s.selectedId);
  const face = useCamPlanStore((s) => s.selectedFeature);

  const active = sketches.find((s) => s.id === activeId);
  const mode = modeText({
    page,
    sketchName: active?.name,
    plane: active ? planeLabel(active.plane) : null,
    fileName,
  });
  const selection = selectionText({
    face,
    featureName: features.find((f) => f.id === selectedId)?.name,
  });
  const tree = treeText({ count: features.length, dirty, errors: errors.length });
  const stale = features.length > 0 && dirty;

  const cell = { fontSize: 11, color: CAD.label, whiteSpace: 'nowrap' };

  return (
    <div
      data-cam-status
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
        padding: '2px 12px', minHeight: 22,
        background: CAD.headerBg, borderTop: `1px solid ${CAD.border}`,
      }}
    >
      <Text strong style={{ ...cell, color: CAD.text }} data-status="mode">{mode}</Text>
      <Text style={cell} data-status="selection">Selected: {selection}</Text>
      <span style={{ flex: 1 }} />
      {page !== 'sketch' && (
        <Text style={cell} data-status="legend">
          Rapid <span style={{ color: CAD.rapid }}>-----</span> Feed <span style={{ color: CAD.feed }}>-----</span>
        </Text>
      )}
      <Text style={cell}>mm</Text>
      <Text
        style={{ ...cell, color: stale ? CAD.accent : CAD.label, fontWeight: stale ? 600 : 400 }}
        data-status="tree"
      >
        {tree}
      </Text>
    </div>
  );
}
