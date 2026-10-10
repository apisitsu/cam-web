/**
 * SketchConfirmCorner — SolidWorks' confirmation corner, scoped to what this
 * sketcher actually has.
 *
 * SolidWorks pairs the checkmark with a red X: accept the sketch, or discard
 * every edit made since it was opened. There is no second state to discard
 * here — every edit already lives in the sketch's own undo history
 * (`sketchStore.undo`/`redo`), so "discard and exit" is just undoing first and
 * then exiting, not a mode this corner needs to know about. One checkmark,
 * which is also why it needs no "cancel": closing it is the only action.
 *
 * It occupies the same top-right corner `PositionReadout` uses in mill/turn
 * mode — safe because `showDro` (engine/view/dro.js) hides that panel
 * whenever `sketching` is true, so the two never share the screen.
 */
import { Tooltip, Button } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import { useCamStore } from '../stores/camStore.js';
import { CAD } from '../theme.js';

export default function SketchConfirmCorner() {
  const mode = useCamStore((s) => s.mode);
  const setPage = useCamStore((s) => s.setPage);

  return (
    // `pointerEvents: 'none'` on the container, `auto` on the button alone —
    // the same rule SketchToolbar's rail follows, and for the same reason: a
    // solid hit-box in a viewport corner swallows pointer events aimed at the
    // sketch underneath it (see SketchToolbar.jsx's comment on this exact bug).
    <div data-cam-overlay="top" style={{
      position: 'absolute', top: 12, right: 12, zIndex: 6, pointerEvents: 'none',
    }}>
      <Tooltip title={`Exit sketch — back to ${mode === 'turn' ? 'Turning' : 'Milling'}`} placement="bottomLeft">
        <Button
          type="primary"
          shape="circle"
          icon={<CheckOutlined />}
          onClick={() => setPage(mode)}
          data-exit-sketch
          style={{
            pointerEvents: 'auto',
            boxShadow: '0 2px 10px rgba(23,42,66,0.18)',
            border: `2px solid ${CAD.surface}`,
          }}
        />
      </Tooltip>
    </div>
  );
}
