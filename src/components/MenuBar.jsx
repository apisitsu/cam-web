/**
 * MenuBar — the File / Edit / View / Window / Help bar a CAD application
 * carries above everything else, which this module never had: every action
 * on the viewport rails is a **command**, reachable only by recognising its
 * glyph (see `engine/view/commands.js`). A menu bar is the other, text-first
 * door to the same handful of actions — the one an operator who does not yet
 * know the glyphs can read their way through.
 *
 * It does not duplicate the catalogue: a menu item's label *is* its
 * description, the way a native File/Edit/View menu always has been, so
 * nothing here goes through `CommandButton`/`commands.js` (that pairing is
 * for icon-only rail buttons, which is not what this is).
 *
 * Deliberately thin on content. This is a first pass at the four menus that
 * cost nothing to get right — reachable actions that already exist as store
 * calls — not a push to cover every rail button. `Edit` only means anything
 * on the Sketch page (undo/redo/delete are sketchStore's alone), so its items
 * are disabled outside it rather than acting on nothing silently.
 */
import { useRef } from 'react';
import { Menu, Modal } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import { useCamStore } from '../stores/camStore.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { SAMPLE_GCODE, SAMPLE_TURNING } from '../SAMPLE_GCODE.js';
import { CAD } from '../theme.js';

const PROGRAM_ACCEPT = '.nc,.gcode,.gc,.tap,.cnc,.ngc,.txt,.mpf';

const VIEW_ITEMS = [
  { value: 'iso', label: 'Isometric' },
  { value: 'top', label: 'Top' },
  { value: 'front', label: 'Front' },
  { value: 'back', label: 'Back' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
];

export default function MenuBar({
  onExportGcode, libraryOpen, onToggleLibrary, onOpenSetup,
}) {
  const page = useCamStore((s) => s.page);
  const mode = useCamStore((s) => s.mode);
  const view = useCamStore((s) => s.view);
  const gcode = useCamStore((s) => s.gcode);
  const loadFile = useCamStore((s) => s.loadFile);
  const parse = useCamStore((s) => s.parse);
  const setViewPreset = useCamStore((s) => s.setViewPreset);

  const sketching = page === 'sketch';
  const selection = useSketchStore((s) => s.selection);
  const undo = useSketchStore((s) => s.undo);
  const redo = useSketchStore((s) => s.redo);
  const deleteSelected = useSketchStore((s) => s.deleteSelected);

  const treeOpen = useFeatureStore((s) => s.treeOpen);
  const setTreeOpen = useFeatureStore((s) => s.setTreeOpen);

  const fileInput = useRef(null);

  const items = [
    {
      key: 'file',
      label: 'File',
      children: [
        { key: 'open', label: 'Open program…' },
        { key: 'sample', label: 'Load sample' },
        { type: 'divider' },
        { key: 'library', label: libraryOpen ? 'Library ✓' : 'Library…' },
        { key: 'export', label: 'Export G-code', disabled: !gcode },
      ],
    },
    {
      key: 'edit',
      label: 'Edit',
      children: [
        { key: 'undo', label: 'Undo', disabled: !sketching },
        { key: 'redo', label: 'Redo', disabled: !sketching },
        { type: 'divider' },
        { key: 'delete', label: 'Delete', disabled: !sketching || selection.length === 0 },
      ],
    },
    {
      key: 'view',
      label: 'View',
      children: [
        { key: 'fit', label: 'Fit to view' },
        { type: 'divider' },
        ...VIEW_ITEMS.map((v) => ({
          key: `view:${v.value}`,
          label: v.value === view ? `${v.label} ✓` : v.label,
        })),
      ],
    },
    {
      key: 'window',
      label: 'Window',
      children: [
        { key: 'setup', label: 'Setup…' },
        { key: 'tree', label: treeOpen ? 'Feature tree ✓' : 'Feature tree' },
      ],
    },
    {
      key: 'help',
      label: 'Help',
      children: [
        { key: 'about', label: 'About Engineer CAD/CAM' },
      ],
    },
  ];

  const onClick = ({ key }) => {
    if (key === 'open') { fileInput.current?.click(); return; }
    if (key === 'sample') { parse(mode === 'turn' ? SAMPLE_TURNING : SAMPLE_GCODE); return; }
    if (key === 'library') { onToggleLibrary(); return; }
    if (key === 'export') { onExportGcode(); return; }
    if (key === 'undo') { undo(); return; }
    if (key === 'redo') { redo(); return; }
    if (key === 'delete') { deleteSelected(); return; }
    if (key === 'fit') { setViewPreset(view); return; }
    if (key.startsWith('view:')) { setViewPreset(key.slice(5)); return; }
    if (key === 'setup') { onOpenSetup(); return; }
    if (key === 'tree') { setTreeOpen(!treeOpen); return; }
    if (key === 'about') {
      Modal.info({
        title: 'Engineer CAD/CAM',
        icon: <ThunderboltOutlined style={{ color: CAD.accent }} />,
        content: 'Browser CAD/CAM: G-code backplot and simulation, STL toolpath planning, and a constraint-solved 2D sketcher.',
      });
    }
  };

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        accept={PROGRAM_ACCEPT}
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // allow re-opening the same file name next time
          if (file) loadFile(file);
        }}
      />
      <Menu
        mode="horizontal"
        selectable={false}
        triggerSubMenuAction="click"
        items={items}
        onClick={onClick}
        style={{
          background: 'transparent',
          borderBottom: 'none',
          lineHeight: '30px',
          fontSize: 12,
        }}
      />
    </>
  );
}
