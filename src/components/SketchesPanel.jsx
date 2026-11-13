/**
 * SketchesPanel — which sketch is being drawn, and on which plane.
 *
 * There used to be exactly one sketch and it was always the machine table, so
 * there was nothing to choose and no control for it. A solid needs a profile on
 * the front, or on a face part way up the part, and more than one of them; this
 * is where that is picked.
 *
 * House style for this module: the rail carries glyphs and the detail lives in a
 * popover, so this renders a compact list rather than a panel of its own.
 */
import { useState } from 'react';
import {
  Button, Tooltip, Popover, Space, Typography, Select, InputNumber, Input, Divider,
} from 'antd';
import { PlusOutlined, DeleteOutlined, BorderOuterOutlined } from '@ant-design/icons';
import { useSketchStore } from '../stores/sketchStore.js';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import {
  PLANE_PRESETS, planeLabel, withGap, tiltPlane,
} from '../engine/sketch/plane.js';
import { CAD } from '../theme.js';

const { Text } = Typography;

const PRESET_OPTIONS = Object.entries(PLANE_PRESETS)
  .map(([value, p]) => ({ value, label: p.label }));

export default function SketchesPanel({ trigger }) {
  const sketches = useSketchStore((s) => s.sketches);
  const activeId = useSketchStore((s) => s.activeId);
  const editSketch = useFeatureStore((s) => s.editSketch);
  const addSketch = useSketchStore((s) => s.addSketch);
  const removeSketch = useSketchStore((s) => s.removeSketch);
  const renameSketch = useSketchStore((s) => s.renameSketch);
  const setSketchPlane = useSketchStore((s) => s.setSketchPlane);
  // Through the feature store, not the sketcher: it links the new plane to the
  // feature that made the face, so the sketch follows when that feature changes.
  const sketchOnFace = useFeatureStore((s) => s.sketchOnFace);
  // The face a click on the part selected — what "sketch on this face" acts on.
  const pickedFace = useCamPlanStore((s) => (s.selectedFeature?.normal ? s.selectedFeature : null));

  const active = sketches.find((s) => s.id === activeId) || sketches[0];
  const preset = active?.plane?.preset || 'XY';
  const offset = Number.isFinite(active?.plane?.offset) ? active.plane.offset : 0;
  const onFace = Number.isFinite(active?.plane?.gap);
  const gap = onFace ? active.plane.gap : 0;
  const [renaming, setRenaming] = useState(null);
  // An angled plane off this sketch's plane: the hinge axis, angle, where the
  // hinge sits across the plane, and a stand-off along the new normal.
  const [tilt, setTilt] = useState({ axis: 'x', angle: 30, pivot: 0, offset: 0 });
  const startSketch = useFeatureStore((s) => s.startSketch);

  const content = (
    <Space direction="vertical" size={6} style={{ minWidth: 250 }}>
      <Text style={{ color: CAD.dim, fontSize: 11 }}>Sketches</Text>
      {sketches.map((s) => {
        const isActive = s.id === activeId;
        return (
          <div key={s.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {renaming === s.id ? (
              <Input
                size="small"
                autoFocus
                defaultValue={s.name}
                onBlur={(e) => { renameSketch(s.id, e.target.value); setRenaming(null); }}
                onPressEnter={(e) => { renameSketch(s.id, e.target.value); setRenaming(null); }}
                style={{ flex: 1 }}
              />
            ) : (
              <Button
                size="small"
                type={isActive ? 'primary' : 'text'}
                onClick={() => editSketch(s.id)}
                onDoubleClick={() => setRenaming(s.id)}
                style={{ flex: 1, textAlign: 'left' }}
                title="Click to open · double-click to rename"
                data-sketch-item={s.id}
              >
                {s.name}
                <Text style={{ color: isActive ? undefined : CAD.dim, fontSize: 10, marginLeft: 6 }}>
                  {planeLabel(s.plane)}
                </Text>
              </Button>
            )}
            <Tooltip title={sketches.length > 1 ? 'Delete this sketch' : 'The last sketch cannot be deleted'}>
              {/* A disabled antd Button swallows its own events, so the tooltip
                  needs a wrapper to have something to hang off. */}
              <span>
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  disabled={sketches.length <= 1}
                  onClick={() => removeSketch(s.id)}
                />
              </span>
            </Tooltip>
          </div>
        );
      })}

      <Button
        size="small"
        icon={<PlusOutlined />}
        onClick={() => addSketch({ plane: active?.plane })}
        block
        data-sketch-add
      >
        New sketch on this plane
      </Button>

      {/* The second-operation route: point at a face on the part and draw on it,
          rather than working out its height and typing an offset. Only offered
          when a face is actually picked — the button cannot explain itself when
          it is the selection that is missing. */}
      <Tooltip title={pickedFace
        ? `Start a sketch on the ${pickedFace.facing} face you picked`
        : 'Click a face on the part in the viewport first'}
      >
        <span>
          <Button
            size="small"
            icon={<BorderOuterOutlined />}
            disabled={!pickedFace}
            onClick={() => sketchOnFace()}
            block
            data-sketch-on-face
          >
            New sketch on the picked face
          </Button>
        </span>
      </Tooltip>
      {pickedFace && (
        <Button
          size="small"
          type="text"
          onClick={() => sketchOnFace({ onto: activeId })}
          block
          data-sketch-move-to-face
        >
          …or move “{active?.name}” onto it
        </Button>
      )}

      <Divider style={{ margin: '2px 0' }} />
      <Text style={{ color: CAD.dim, fontSize: 11 }}>Plane of “{active?.name}”</Text>
      {/* A plane made from a face is placed by its distance off that face, the
          way SolidWorks offsets a reference plane — and it stays that far off the
          face when an edit moves it. Moving it to a standard plane is a new sketch. */}
      {onFace ? (
        <Tooltip title="Distance off the face, along its normal: positive stands the plane off the part, negative sinks it in">
          <InputNumber
            size="small"
            value={gap}
            step={1}
            onChange={(v) => setSketchPlane(activeId, withGap(active.plane, Number(v) || 0))}
            addonBefore="Offset from face"
            addonAfter="mm"
            style={{ width: 236 }}
            data-sketch-face-gap
          />
        </Tooltip>
      ) : (
        <Space size={4}>
          <Select
            size="small"
            value={preset}
            options={PRESET_OPTIONS}
            onChange={(v) => setSketchPlane(activeId, { preset: v, offset })}
            style={{ width: 132 }}
          />
          <Tooltip title="Offset along the plane's normal, in mm — a sketch on a face part way up the part">
            <InputNumber
              size="small"
              value={offset}
              step={1}
              onChange={(v) => setSketchPlane(activeId, { preset, offset: Number(v) || 0 })}
              style={{ width: 88 }}
              addonAfter="mm"
            />
          </Tooltip>
        </Space>
      )}
      <Text style={{ color: CAD.dim, fontSize: 10 }}>
        Geometry keeps its 2D coordinates; only where the plane sits in space changes.
      </Text>

      <Divider style={{ margin: '2px 0' }} />
      <Text style={{ color: CAD.dim, fontSize: 11 }}>Angled plane off “{active?.name}”</Text>
      <Space size={4} wrap style={{ width: 250 }}>
        <Tooltip title="The axis of this sketch the new plane hinges about">
          <Select
            size="small"
            value={tilt.axis}
            options={[{ value: 'x', label: 'About X' }, { value: 'y', label: 'About Y' }]}
            onChange={(axis) => setTilt({ ...tilt, axis })}
            style={{ width: 92 }}
            data-tilt-axis
          />
        </Tooltip>
        <InputNumber
          size="small"
          value={tilt.angle}
          min={-180}
          max={180}
          onChange={(v) => setTilt({ ...tilt, angle: Number(v) || 0 })}
          addonAfter="°"
          style={{ width: 92 }}
          data-tilt-angle
        />
        <Tooltip title={`Where the hinge runs: the ${tilt.axis === 'x' ? 'Y' : 'X'} coordinate, in this sketch, of the line it turns about`}>
          <InputNumber
            size="small"
            value={tilt.pivot}
            onChange={(v) => setTilt({ ...tilt, pivot: Number(v) || 0 })}
            addonBefore="at"
            addonAfter="mm"
            style={{ width: 120 }}
            data-tilt-pivot
          />
        </Tooltip>
        <Tooltip title="Stand the angled plane off along its own normal">
          <InputNumber
            size="small"
            value={tilt.offset}
            onChange={(v) => setTilt({ ...tilt, offset: Number(v) || 0 })}
            addonBefore="off"
            addonAfter="mm"
            style={{ width: 120 }}
            data-tilt-offset
          />
        </Tooltip>
      </Space>
      <Button
        size="small"
        block
        disabled={!active || !tilt.angle}
        onClick={() => startSketch(tiltPlane(active.plane, tilt))}
        data-tilt-create
      >
        New sketch on the angled plane
      </Button>
    </Space>
  );

  return (
    <Popover trigger="click" placement="bottomLeft" content={content}>
      {trigger}
    </Popover>
  );
}
