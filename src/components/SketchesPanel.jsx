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
import { PLANE_PRESETS, planeLabel } from '../engine/sketch/plane.js';
import { CAD } from '../theme.js';

const { Text } = Typography;

const PRESET_OPTIONS = Object.entries(PLANE_PRESETS)
  .map(([value, p]) => ({ value, label: p.label }));

export default function SketchesPanel({ trigger }) {
  const sketches = useSketchStore((s) => s.sketches);
  const activeId = useSketchStore((s) => s.activeId);
  const setActiveSketch = useSketchStore((s) => s.setActiveSketch);
  const addSketch = useSketchStore((s) => s.addSketch);
  const removeSketch = useSketchStore((s) => s.removeSketch);
  const renameSketch = useSketchStore((s) => s.renameSketch);
  const setSketchPlane = useSketchStore((s) => s.setSketchPlane);
  const sketchOnFace = useSketchStore((s) => s.sketchOnFace);
  // The face a click on the part selected — what "sketch on this face" acts on.
  const pickedFace = useCamPlanStore((s) => (s.selectedFeature?.normal ? s.selectedFeature : null));

  const active = sketches.find((s) => s.id === activeId) || sketches[0];
  const preset = active?.plane?.preset || 'XY';
  const offset = Number.isFinite(active?.plane?.offset) ? active.plane.offset : 0;
  const [renaming, setRenaming] = useState(null);

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
                onClick={() => setActiveSketch(s.id)}
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
      <Text style={{ color: CAD.dim, fontSize: 10 }}>
        Geometry keeps its 2D coordinates; only where the plane sits in space changes.
      </Text>
    </Space>
  );

  return (
    <Popover trigger="click" placement="bottomLeft" content={content}>
      {trigger}
    </Popover>
  );
}
