/**
 * FeatureTree — the model's structure, docked down the left of the viewport.
 *
 * This is the tree a CAD puts there: every operation that made the part, in
 * order, with the sketch each one was built from hanging under it. It replaced a
 * popover on the rail, which held the same information and hid it — the whole
 * point of a feature tree is that the shape of the model is *visible while you
 * work*, not one click away.
 *
 * Two things follow from being docked rather than floating:
 *
 * - It declares `data-cam-overlay="left"`, so Fit frames the part in the space
 *   beside it instead of underneath it (`engine/view/camera.js`).
 * - It collapses to a strip. A viewport is small on a shop-floor tablet and a
 *   permanent panel has to be surrenderable.
 *
 * Clicking a sketch under a feature **opens that sketch for editing** — which is
 * how you get back to the geometry behind an operation, and the reason the
 * sketches are shown here at all rather than only in their own list.
 */
import { useState } from 'react';
import {
  Button, Tooltip, Space, Typography, InputNumber, Segmented, Badge, Alert,
} from 'antd';
import {
  DeleteOutlined, ArrowUpOutlined, ArrowDownOutlined,
  EyeOutlined, EyeInvisibleOutlined, ReloadOutlined,
  RightOutlined, DownOutlined, MenuOutlined,
} from '@ant-design/icons';
import { useFeatureStore, TREE_W_DEFAULT } from '../stores/featureStore.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { describeFeature } from '../engine/solid/featureTree.js';
import { planeLabel } from '../engine/sketch/plane.js';
import { CAD } from '../theme.js';

const { Text } = Typography;

const MERGE_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'cut', label: 'Cut' },
  { value: 'add', label: 'Add' },
  { value: 'common', label: 'Common' },
];

/**
 * The panel's widths, exported because the sketch rail sits beside it and has to
 * know where it ends. `TREE_W` is only the **default** open width now — the live
 * one is `useFeatureStore.treeWidth`, which the operator drags (the column also
 * holds the Program listing, and a line of G-code wants more room than the
 * tree). `TREE_STRIP` is the fixed collapsed strip.
 */
export const TREE_SIZE = { TREE_W: TREE_W_DEFAULT, TREE_STRIP: 36 };

/**
 * The tree fills the column it is given rather than floating over the viewport.
 *
 * That is the whole difference between this and an overlay: a `Sider` takes
 * layout space, so the canvas is genuinely narrower and the camera fit needs to
 * know nothing about the panel — which is why there is no `data-cam-overlay`
 * here, unlike the rails that really do sit on top of the model.
 */
const PANEL = {
  height: '100%', display: 'flex', flexDirection: 'column',
  background: CAD.panelBg,
};

/** The parameters of the selected feature. */
function FeatureEditor({ feature }) {
  const update = useFeatureStore((s) => s.updateFeature);
  if (feature.kind === 'import') {
    return (
      <Text style={{ color: CAD.dim, fontSize: 10 }}>
        The mesh this job was imported from. Its geometry cannot be edited here —
        it is the base everything else is cut from.
      </Text>
    );
  }
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {feature.kind === 'extrude' ? (
        <Space size={4} style={{ width: '100%' }}>
          <InputNumber
            size="small"
            value={feature.depth}
            onChange={(v) => update(feature.id, { depth: Number(v) || 0 })}
            addonBefore="Depth"
            style={{ width: 124 }}
            data-feature-depth
          />
          <Tooltip title="Lift the solid off its plane — a boss standing on a face, or a cut starting below one">
            <InputNumber
              size="small"
              value={feature.base}
              onChange={(v) => update(feature.id, { base: Number(v) || 0 })}
              addonBefore="From"
              style={{ width: 112 }}
            />
          </Tooltip>
        </Space>
      ) : (
        <Space size={4} style={{ width: '100%' }}>
          <Segmented
            size="small"
            value={feature.axis}
            onChange={(v) => update(feature.id, { axis: v })}
            options={[{ label: 'X', value: 'x' }, { label: 'Y', value: 'y' }]}
          />
          <InputNumber
            size="small"
            min={1}
            max={360}
            value={Math.round((feature.angle * 180) / Math.PI)}
            onChange={(v) => update(feature.id, { angle: ((Number(v) || 360) * Math.PI) / 180 })}
            addonAfter="°"
            style={{ width: 96 }}
          />
        </Space>
      )}
      <Segmented
        size="small"
        block
        value={feature.merge}
        onChange={(v) => update(feature.id, { merge: v })}
        options={MERGE_OPTIONS}
      />
    </Space>
  );
}

export default function FeatureTree({ embedded = false }) {
  const features = useFeatureStore((s) => s.features);
  const selectedId = useFeatureStore((s) => s.selectedId);
  const dirty = useFeatureStore((s) => s.dirty);
  const building = useFeatureStore((s) => s.building);
  const errors = useFeatureStore((s) => s.errors);
  const select = useFeatureStore((s) => s.select);
  const remove = useFeatureStore((s) => s.removeFeature);
  const move = useFeatureStore((s) => s.moveFeature);
  const toggleSuppress = useFeatureStore((s) => s.toggleSuppress);
  const rebuild = useFeatureStore((s) => s.rebuild);

  const sketches = useSketchStore((s) => s.sketches);
  const activeSketchId = useSketchStore((s) => s.activeId);
  const setActiveSketch = useSketchStore((s) => s.setActiveSketch);

  const open = useFeatureStore((s) => s.treeOpen);
  const setOpen = useFeatureStore((s) => s.setTreeOpen);
  // Which features have their sketch shown. Expanded by default: the sketch is
  // the thing you come to the tree to get back to.
  const [collapsed, setCollapsed] = useState({});

  const errorOf = (id) => errors.find((e) => e.id === id);
  const usedSketchIds = new Set(features.map((f) => f.sketchId).filter(Boolean));
  const spare = sketches.filter((s) => !usedSketchIds.has(s.id));

  // Standalone, it still collapses itself; embedded in `LeftColumn` the column
  // owns that, and a second toggle in the same corner would be two controls for
  // one job.
  if (!embedded && !open) {
    return (
      <div style={{ ...PANEL, alignItems: 'center', paddingTop: 6 }}>
        <Tooltip title="Show the feature tree" placement="right">
          <Badge dot={dirty && features.length > 0} offset={[-6, 4]}>
            <Button
              type="text"
              icon={<MenuOutlined />}
              onClick={() => setOpen(true)}
              style={{ width: 34, height: 34, color: CAD.icon }}
              data-tree-toggle
            />
          </Badge>
        </Tooltip>
      </div>
    );
  }

  /** One sketch row, as a child of a feature or on its own. */
  const sketchRow = (sk, indented) => (
    <Button
      key={`sk${sk.id}`}
      size="small"
      type="text"
      onClick={() => setActiveSketch(sk.id)}
      style={{
        width: '100%',
        textAlign: 'left',
        paddingLeft: indented ? 26 : 8,
        height: 24,
        color: sk.id === activeSketchId ? CAD.accent : CAD.icon,
        fontWeight: sk.id === activeSketchId ? 600 : 400,
      }}
      data-tree-sketch={sk.id}
    >
      <span style={{ fontSize: 11 }}>✎ {sk.name}</span>
      <Text style={{ color: CAD.dim, fontSize: 10, marginLeft: 6 }}>{planeLabel(sk.plane)}</Text>
    </Button>
  );

  return (
    <div style={PANEL}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '6px 6px 6px 10px', borderBottom: `1px solid ${CAD.border}`,
      }}>
        <Text style={{ flex: 1, color: CAD.text, fontSize: 12, fontWeight: 600 }}>
          {embedded ? 'Features' : 'Feature tree'}
        </Text>
        <Tooltip title={dirty ? 'The tree or a sketch under it has changed — replay it' : 'Up to date'}>
          <Badge dot={dirty && features.length > 0} offset={[-2, 2]}>
            <Button
              size="small"
              type={dirty && features.length ? 'primary' : 'text'}
              icon={<ReloadOutlined />}
              loading={building}
              disabled={!features.length}
              onClick={() => rebuild()}
              data-feature-rebuild
            />
          </Badge>
        </Tooltip>
        {!embedded && (
          <Tooltip title="Collapse">
            <Button size="small" type="text" icon={<MenuOutlined />} onClick={() => setOpen(false)} data-tree-toggle />
          </Tooltip>
        )}
      </div>

      {/* Said in words as well as by the dot. This is the one state that has to
          be noticed from arm's length on a shop-floor tablet, and a coloured
          icon alone is not enough for it. */}
      {dirty && features.length > 0 && (
        <Text style={{
          color: CAD.accent, fontSize: 10, padding: '4px 10px',
          borderBottom: `1px solid ${CAD.border}`,
        }}
        >
          Out of date — press Rebuild
        </Text>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: 4 }}>
        {!features.length && (
          <Text style={{ color: CAD.dim, fontSize: 10, display: 'block', padding: 6 }}>
            Nothing built yet. Draw a profile and press Build — each operation
            becomes a feature here that you can come back and change.
          </Text>
        )}

        {features.map((f, i) => {
          const failed = errorOf(f.id);
          const isSel = f.id === selectedId;
          const sketch = sketches.find((s) => s.id === f.sketchId);
          const shut = collapsed[f.id];
          return (
            <div key={f.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Button
                  size="small"
                  type="text"
                  icon={shut ? <RightOutlined /> : <DownOutlined />}
                  onClick={() => setCollapsed((c) => ({ ...c, [f.id]: !c[f.id] }))}
                  style={{ width: 18, minWidth: 18, height: 24, color: CAD.dim, visibility: sketch ? 'visible' : 'hidden' }}
                  data-tree-expand={f.id}
                />
                <Button
                  size="small"
                  type={isSel ? 'primary' : 'text'}
                  onClick={() => select(isSel ? null : f.id)}
                  style={{
                    flex: 1,
                    textAlign: 'left',
                    height: 24,
                    opacity: f.suppressed ? 0.45 : 1,
                    textDecoration: f.suppressed ? 'line-through' : undefined,
                  }}
                  data-feature-item={f.id}
                >
                  {failed && <Badge status="error" style={{ marginRight: 4 }} />}
                  <span style={{ fontSize: 11 }}>{f.name}</span>
                </Button>
                <Tooltip title={f.suppressed ? 'Include again' : 'Leave out of the rebuild'}>
                  <Button
                    size="small"
                    type="text"
                    icon={f.suppressed ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                    onClick={() => toggleSuppress(f.id)}
                    style={{ width: 22, minWidth: 22, height: 24 }}
                    data-feature-suppress={f.id}
                  />
                </Tooltip>
              </div>

              {!shut && sketch && sketchRow(sketch, true)}

              {isSel && (
                <div style={{ padding: '4px 6px 8px 26px' }}>
                  <Text style={{ color: CAD.dim, fontSize: 10, display: 'block', marginBottom: 4 }}>
                    {describeFeature(f, sketch?.name)}
                  </Text>
                  <FeatureEditor feature={f} />
                  <Space size={2} style={{ marginTop: 6 }}>
                    <Tooltip title="Move earlier — order decides what cuts what">
                      <span>
                        <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => move(f.id, -1)} />
                      </span>
                    </Tooltip>
                    <Tooltip title="Move later">
                      <span>
                        <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={i === features.length - 1} onClick={() => move(f.id, 1)} />
                      </span>
                    </Tooltip>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => remove(f.id)}>
                      Delete
                    </Button>
                  </Space>
                </div>
              )}
            </div>
          );
        })}

        {/* Sketches no feature has been built from yet. A CAD shows these at tree
            level too — they are part of the model even before anything uses them,
            and hiding them makes a drawn-but-unbuilt profile look lost. */}
        {spare.length > 0 && (
          <>
            <div style={{ borderTop: `1px solid ${CAD.border}`, margin: '6px 4px 4px' }} />
            <Text style={{ color: CAD.dim, fontSize: 10, paddingLeft: 8 }}>
              {features.length ? 'Not used by a feature' : 'Sketches'}
            </Text>
            {spare.map((sk) => sketchRow(sk, false))}
          </>
        )}
      </div>

      {errors.length > 0 && (
        <div style={{ padding: 4, borderTop: `1px solid ${CAD.border}` }}>
          {errors.map((e) => (
            <Alert
              key={e.id ?? e.name}
              type="error"
              showIcon
              message={<span style={{ fontSize: 10 }}>{`${e.name}: ${e.message}`}</span>}
              style={{ padding: '2px 6px', marginBottom: 2 }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
