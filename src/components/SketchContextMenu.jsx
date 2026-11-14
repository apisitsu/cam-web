/**
 * SketchContextMenu — the sketch viewport's right-click menu, the way
 * SolidWorks gives one on selected geometry. Position and open/closed state
 * live in `sketchStore.contextMenu` (set by `SketchLayer`'s native
 * `contextmenu` listener, which already knows what was under the cursor);
 * this component only renders the menu and acts on `selection`, which is the
 * one thing both sides agree on. Above the edit commands it lists the relations
 * the selection can take (`relationsFor`) — Equal, Concentric, Tangent… — so a
 * relation is one right-click away, as in SolidWorks.
 *
 * A fixed full-screen catcher closes the menu on the next click or another
 * right-click anywhere else — the same job a native context menu's own
 * dismiss-on-click-away does, reimplemented because this one is just DOM.
 */
import { Menu } from 'antd';
import { DeleteOutlined, BorderOutlined } from '@ant-design/icons';
import { useSketchStore } from '../stores/sketchStore.js';
import { relationsFor } from '../engine/sketch/relations.js';
import { CAD } from '../theme.js';

export default function SketchContextMenu() {
  const at = useSketchStore((s) => s.contextMenu);
  const selection = useSketchStore((s) => s.selection);
  const sk = useSketchStore((s) => s.sk);
  const deleteSelected = useSketchStore((s) => s.deleteSelected);
  const toggleConstruction = useSketchStore((s) => s.toggleConstruction);
  const close = useSketchStore((s) => s.closeContextMenu);
  const applyRelation = useSketchStore((s) => s.applyRelation);

  if (!at) return null;

  const hasConstructible = selection.some((id) => {
    const t = sk.entities.get(id)?.type;
    return ['line', 'circle', 'arc', 'ellipse', 'spline'].includes(t);
  });

  const relations = relationsFor(sk, selection);
  // One point: it can pierce where another sketch passes through this plane.
  const pierces = selection.length === 1 ? useSketchStore.getState().pierceChoices(selection[0]).slice(0, 4) : [];
  const relationItems = [
    ...relations.map((r) => ({ key: `rel:${r.key}`, label: r.label })),
    ...pierces.map((p, i) => ({ key: `pierce:${i}`, label: `Pierce · ${p.sketchName}` })),
  ];
  const items = [
    ...(relationItems.length ? [{
      type: 'group',
      label: 'Add Relation',
      children: relationItems,
    }, { type: 'divider' }] : []),
    {
      key: 'construction',
      icon: <BorderOutlined />,
      label: 'Toggle construction',
      disabled: !hasConstructible,
    },
    { type: 'divider' },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      label: selection.length > 1 ? `Delete (${selection.length})` : 'Delete',
      danger: true,
      disabled: selection.length === 0,
    },
  ];

  const onClick = ({ key }) => {
    if (key === 'delete') deleteSelected();
    else if (key === 'construction') toggleConstruction();
    else if (key.startsWith('rel:')) {
      const r = relations.find((x) => `rel:${x.key}` === key);
      if (r) applyRelation(r.constraints);
    } else if (key.startsWith('pierce:')) {
      const p = pierces[Number(key.slice(7))];
      if (p) useSketchStore.getState().pierce(selection[0], p);
    }
    close();
  };

  return (
    <>
      <div
        onMouseDown={close}
        onContextMenu={(e) => { e.preventDefault(); close(); }}
        onWheel={close}
        style={{ position: 'fixed', inset: 0, zIndex: 50 }}
      />
      <div
        style={{ position: 'fixed', left: at.x, top: at.y, zIndex: 51 }}
        data-sketch-context-menu
      >
        <Menu
          items={items}
          onClick={onClick}
          style={{
            minWidth: 170,
            border: `1px solid ${CAD.border}`,
            borderRadius: 6,
            boxShadow: '0 4px 16px rgba(23,42,66,0.25)',
          }}
        />
      </div>
    </>
  );
}
