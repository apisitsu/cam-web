/**
 * MenuBar — the File / Edit / View / Insert / Tools / Window / Help bar a CAD
 * application carries above everything else, plus a search box over the same
 * commands.
 *
 * Every action on the viewport rails is a **command**, reachable only by
 * recognising its glyph (see `engine/view/commands.js`). A menu bar is the other,
 * text-first door to the same actions — the one an operator who does not yet know
 * the glyphs can read their way through. The search box is the third door: type
 * what you want ("dxf", "rebuild") and run it, the way SolidWorks' command search
 * does.
 *
 * **The menu is data, and the search reads that same data.** `buildMenuItems`
 * returns the antd `items`; `flattenMenu` turns them into a flat list of runnable
 * commands. Search is therefore never a second list that can drift from the menu:
 * whatever the menu offers, enabled, is what search finds, and what the menu
 * disables search will not offer.
 *
 * A menu item's label *is* its description, the way a native File/Edit/View menu
 * always has been, so nothing here goes through `CommandButton`/`commands.js`
 * (that pairing is for icon-only rail buttons).
 *
 * Items that only mean something on the Sketch page (undo/redo/delete, New
 * sketch, Import DXF…) are disabled outside it rather than acting on nothing.
 */
import { useEffect, useRef, useState } from 'react';
import { Menu, Modal, AutoComplete, Input, message } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import { useCamStore } from '../stores/camStore.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { useStdStore } from '../stores/stdStore.js';
import { useMachineStore } from '../stores/machineStore.js';
import { useLibraryStore } from '../stores/libraryStore.js';
import {
  saveProject, saveProjectAs, canPickSaveLocation, currentProjectFileName, openProjectFile, openProgramFile,
  exportSketchDxf,
} from '../lib/projectIO.js';
import { keyIs } from '../engine/view/viewKeys.js';
import { CAD } from '../theme.js';

const PROGRAM_ACCEPT = '.nc,.gcode,.gc,.tap,.cnc,.ngc,.txt,.mpf';

const VIEW_ITEMS = [
  { value: 'iso', label: 'Isometric' },
  { value: 'top', label: 'Top' },
  { value: 'front', label: 'Front' },
  { value: 'back', label: 'Back' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'bottom', label: 'Bottom' },
];

/** SolidWorks' keys for the menu's commands, written beside each one. */
export const SHORTCUTS = {
  'open-project': 'Ctrl+O',
  'save-project': 'Ctrl+S',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Y',
  rebuild: 'Ctrl+B',
  delete: 'Delete',
  fit: 'F',
  'view:front': 'Ctrl+1',
  'view:back': 'Ctrl+2',
  'view:left': 'Ctrl+3',
  'view:right': 'Ctrl+4',
  'view:top': 'Ctrl+5',
  'view:bottom': 'Ctrl+6',
  'view:iso': 'Ctrl+7',
};

/** The mouse and keys, for Help, in Thai and English. */
export const CONTROLS_HELP = [
  ['เมาส์ซ้าย', 'Left click', 'เลือก / Select'],
  ['กดล้อกลางค้างแล้วลาก', 'Middle drag', 'หมุนมุมมอง / Rotate'],
  ['Ctrl + ล้อกลางลาก', 'Ctrl + middle drag', 'เลื่อนภาพ / Pan'],
  ['Shift + ล้อกลางลาก', 'Shift + middle drag', 'ซูม / Zoom'],
  ['หมุนล้อเมาส์', 'Wheel', 'ซูมเข้า-ออกตรงตำแหน่งเมาส์ / Zoom at cursor'],
  ['เมาส์ขวาลาก', 'Right drag', 'เลื่อนภาพ (โน้ตบุ๊ก) / Pan'],
  ['ลูกศร', 'Arrow keys', 'หมุน 15° / Rotate 15°'],
  ['Shift + ลูกศร', 'Shift + arrows', 'หมุน 90° / Rotate 90°'],
  ['Ctrl + ลูกศร', 'Ctrl + arrows', 'เลื่อนภาพ / Pan'],
  ['F', 'F', 'ดูพอดีจอ / Zoom to fit'],
  ['Z / Shift+Z', 'Z / Shift+Z', 'ซูมออก / ซูมเข้า'],
  ['Ctrl+1 … Ctrl+7', 'Ctrl+1 … Ctrl+7', 'หน้า หลัง ซ้าย ขวา บน ล่าง ไอโซ'],
  ['Ctrl+8', 'Ctrl+8', 'มองตั้งฉากกับสเก็ตช์ / Normal To'],
  ['Ctrl+S / Ctrl+O', 'Ctrl+S / Ctrl+O', 'บันทึก / เปิดโปรเจกต์'],
  ['Ctrl+B / Ctrl+Q', 'Ctrl+B / Ctrl+Q', 'สร้างชิ้นงานใหม่ / Rebuild'],
  ['Ctrl+Z / Ctrl+Y', 'Ctrl+Z / Ctrl+Y', 'ย้อนกลับ / ทำซ้ำ (สเก็ตช์)'],
  ['Delete / Esc', 'Delete / Esc', 'ลบ / ยกเลิก'],
];

const withShortcuts = (items) => items.map((top) => ({
  ...top,
  children: top.children?.map((c) => (SHORTCUTS[c.key] ? { ...c, extra: SHORTCUTS[c.key] } : c)),
}));

/**
 * The menu, as antd `items`. Pure: everything it needs arrives in `ctx`.
 *
 * @param {{libraryOpen:boolean, hasProgram:boolean, sketching:boolean,
 *   hasSelection:boolean, view:string, treeOpen:boolean, canRestore:boolean,
 *   hasFace:boolean, hasFeatures:boolean}} ctx
 */
export function buildMenuItems(ctx) {
  const {
    libraryOpen, hasProgram, sketching, hasSelection, view, treeOpen, canRestore, hasFace, hasFeatures,
  } = ctx;
  return withShortcuts([
    {
      key: 'file',
      label: 'File',
      children: [
        { key: 'open', label: 'Open program…' },
        { type: 'divider' },
        { key: 'open-project', label: 'Open project…' },
        { key: 'save-project', label: 'Save project' },
        { key: 'save-project-as', label: 'Save project as…' },
        { type: 'divider' },
        { key: 'import-dxf', label: 'Import DXF…', disabled: !sketching },
        { key: 'export-dxf', label: 'Export sketch as DXF', disabled: !sketching },
        { type: 'divider' },
        { key: 'library', label: libraryOpen ? 'Library ✓' : 'Library…' },
        { key: 'export', label: 'Export G-code', disabled: !hasProgram },
      ],
    },
    {
      key: 'edit',
      label: 'Edit',
      children: [
        { key: 'undo', label: 'Undo', disabled: !sketching },
        { key: 'redo', label: 'Redo', disabled: !sketching },
        { type: 'divider' },
        { key: 'rebuild', label: 'Rebuild', disabled: !hasFeatures },
        { type: 'divider' },
        { key: 'delete', label: 'Delete', disabled: !sketching || !hasSelection },
        { key: 'clear-sketch', label: 'Clear sketch', disabled: !sketching },
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
      key: 'insert',
      label: 'Insert',
      children: [
        { key: 'new-sketch', label: 'New sketch', disabled: !sketching },
        { key: 'sketch-on-face', label: 'Sketch on picked face', disabled: !sketching || !hasFace },
      ],
    },
    {
      key: 'tools',
      label: 'Tools',
      children: [
        { key: 'std', label: 'Standard cutting speeds…', disabled: !hasProgram },
        { key: 'std-restore', label: 'Restore program', disabled: !canRestore },
        { key: 'std-edit', label: 'Edit standard…' },
        { type: 'divider' },
        { key: 'machines', label: 'Machines…' },
        { key: 'work-offsets', label: 'Work offsets…' },
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
        { key: 'controls', label: 'Mouse & keyboard (เมาส์และคีย์ลัด)' },
        { key: 'about', label: 'About Basic CAM Lite' },
      ],
    },
  ]);
}

/** The menu as a flat list of commands, for search. Dividers are dropped; the group is the menu's name. */
export function flattenMenu(items) {
  const out = [];
  for (const top of items) {
    for (const child of top.children || []) {
      if (child.type === 'divider') continue;
      out.push({
        key: child.key,
        // The ellipsis and tick are menu punctuation, not part of the name.
        label: String(child.label).replace(/[…✓]/g, '').trim(),
        group: top.label,
        disabled: !!child.disabled,
      });
    }
  }
  return out;
}

/**
 * Commands matching what was typed: every word must appear in the name or its
 * menu ("dxf export" and "file dxf" both find Export sketch as DXF). Disabled ones
 * are left out — offering a command that then does nothing is worse than not
 * offering it. Name matches rank above menu-only matches.
 */
export function searchMenu(flat, query, limit = 8) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored = [];
  for (const c of flat) {
    if (c.disabled) continue;
    const name = c.label.toLowerCase();
    const both = `${name} ${c.group.toLowerCase()}`;
    if (!words.every((w) => both.includes(w))) continue;
    scored.push({ c, score: words.every((w) => name.includes(w)) ? 0 : 1 });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.c);
}

export default function MenuBar({
  onExportGcode, libraryOpen, onToggleLibrary, onOpenSetup, brand = null,
}) {
  const page = useCamStore((s) => s.page);
  const view = useCamStore((s) => s.view);
  const gcode = useCamStore((s) => s.gcode);
  const setViewPreset = useCamStore((s) => s.setViewPreset);

  const sketching = page === 'sketch';
  const selection = useSketchStore((s) => s.selection);
  const undo = useSketchStore((s) => s.undo);
  const redo = useSketchStore((s) => s.redo);
  const deleteSelected = useSketchStore((s) => s.deleteSelected);
  const clearSketch = useSketchStore((s) => s.clear);
  const addSketch = useSketchStore((s) => s.addSketch);
  const importDxf = useSketchStore((s) => s.importDxf);
  const setError = useSketchStore((s) => s.setError);

  const treeOpen = useFeatureStore((s) => s.treeOpen);
  const setTreeOpen = useFeatureStore((s) => s.setTreeOpen);
  const features = useFeatureStore((s) => s.features);
  const rebuild = useFeatureStore((s) => s.rebuild);
  const sketchOnFace = useFeatureStore((s) => s.sketchOnFace);
  const face = useCamPlanStore((s) => s.selectedFeature);

  const canRestore = useStdStore((s) => !!s.undo);
  const checkStd = useStdStore((s) => s.check);
  const restoreStd = useStdStore((s) => s.restore);
  const openStdEditor = useStdStore((s) => s.openEditor);
  const openMachines = useMachineStore((s) => s.openEditor);

  const fileInput = useRef(null);
  const projectInput = useRef(null);
  const dxfInput = useRef(null);
  const searchRef = useRef(null);
  const [query, setQuery] = useState('');
  // Who is signed in, as the host app stores it. Empty in standalone cam-web.
  const operator = localStorage.getItem('u_code');
  // The name being typed into Save As, where the browser has no dialog of its own.
  const [saveAsName, setSaveAsName] = useState(null);

  const items = buildMenuItems({
    libraryOpen,
    hasProgram: !!gcode,
    sketching,
    hasSelection: selection.length > 0,
    view,
    treeOpen,
    canRestore,
    hasFace: !!(face?.normal && face?.centroid),
    hasFeatures: features.length > 0,
  });

  const guarded = (fn) => async () => {
    try { await fn(); } catch (e) { setError?.(e?.message || String(e)); }
  };

  /**
   * Run a save and say how it went. Saving leaves nothing else on screen to show
   * that it happened, and these can run from any page, where the sketcher's error
   * line is not showing.
   */
  const announced = async (fn) => {
    try {
      const said = await fn();
      if (said) message.success(said);
    } catch (e) {
      message.error(e?.message || String(e));
    }
  };

  // Save goes back where the project came from: over your own library item if one
  // is open, otherwise to its file.
  const saveCurrent = async () => {
    const library = useLibraryStore.getState();
    if (library.canSaveOpen()) {
      const saved = await library.saveOpen();
      return `Saved “${saved.name}” to your library`;
    }
    const name = await saveProject();
    return name && `Saved ${name}`;
  };

  // A file saved under a new name is what is open from here on, so the next Save
  // must not write back over the library item this began as.
  const saveAsFile = async (name) => {
    const saved = await saveProjectAs(name);
    if (saved) useLibraryStore.getState().setOpenItem(null);
    return saved && `Saved ${saved}`;
  };

  const run = ({ key }) => {
    if (key === 'save-project') { announced(saveCurrent); return; }
    if (key === 'save-project-as') {
      if (canPickSaveLocation()) announced(() => saveAsFile());
      else setSaveAsName(currentProjectFileName());
      return;
    }
    if (key === 'open') { fileInput.current?.click(); return; }
    if (key === 'open-project') { projectInput.current?.click(); return; }
    if (key === 'export-dxf') { guarded(exportSketchDxf)(); return; }
    if (key === 'library') { onToggleLibrary(); return; }
    if (key === 'export') { onExportGcode(); return; }
    if (key === 'undo') { undo(); return; }
    if (key === 'redo') { redo(); return; }
    if (key === 'rebuild') { rebuild(); return; }
    if (key === 'delete') { deleteSelected(); return; }
    if (key === 'clear-sketch') { clearSketch(); return; }
    if (key === 'fit') { setViewPreset(view); return; }
    if (key.startsWith('view:')) { setViewPreset(key.slice(5)); return; }
    if (key === 'new-sketch') { addSketch(); return; }
    if (key === 'sketch-on-face') { sketchOnFace(); return; }
    if (key === 'import-dxf') { dxfInput.current?.click(); return; }
    if (key === 'std') { checkStd({ manual: true }); return; }
    if (key === 'std-restore') { restoreStd(); return; }
    if (key === 'std-edit') { openStdEditor(); return; }
    if (key === 'machines') { openMachines(); return; }
    if (key === 'work-offsets') { useCamPlanStore.getState().openWorkOffsets(); return; }
    if (key === 'setup') { onOpenSetup(); return; }
    if (key === 'tree') { setTreeOpen(!treeOpen); return; }
    if (key === 'controls') {
      Modal.info({
        title: 'เมาส์และคีย์ลัด (แบบ SolidWorks)',
        width: 560,
        content: (
          <table data-controls-help style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <tbody>
              {CONTROLS_HELP.map(([th, , what]) => (
                <tr key={th} style={{ borderBottom: `1px solid ${CAD.borderSoft}` }}>
                  <td style={{ padding: '4px 8px', fontWeight: 600, whiteSpace: 'nowrap' }}>{th}</td>
                  <td style={{ padding: '4px 8px' }}>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ),
      });
      return;
    }
    if (key === 'about') {
      Modal.info({
        title: 'Basic CAM Lite',
        icon: <ThunderboltOutlined style={{ color: CAD.accent }} />,
        content: 'A lightweight shop-floor tool in the browser: open and check G-code, backplot and simulate the cut, check standard cutting speeds, and sketch simple parts. It is not a full CAM system — no 3D fillets, assemblies or STEP.',
      });
    }
  };

  // Ctrl/Cmd+K jumps to the search box; Ctrl+S, Ctrl+O and Ctrl+B/Q are
  // SolidWorks' save, open and rebuild. Read from `code` so the Thai layout works too.
  const runRef = useRef(run);
  runRef.current = run;
  const hasFeaturesRef = useRef(false);
  hasFeaturesRef.current = features.length > 0;
  // Undo / Redo of the feature tree. With a sketch open the sketcher has the
  // keys for its own history (SketchLayer); typing in a field keeps the browser's.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      if (useSketchStore.getState().sketchOpen) return;
      const fs = useFeatureStore.getState();
      if (fs.building) return;
      if (keyIs(e, 'z') && !e.shiftKey) { e.preventDefault(); fs.undo(); } else if (keyIs(e, 'y') || (keyIs(e, 'z') && e.shiftKey)) { e.preventDefault(); fs.redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const go = (key) => { e.preventDefault(); runRef.current({ key }); };
      if (keyIs(e, 'k')) { e.preventDefault(); searchRef.current?.focus(); } else if (keyIs(e, 's')) go('save-project');
      else if (keyIs(e, 'o')) go('open-project');
      else if ((keyIs(e, 'b') || keyIs(e, 'q')) && hasFeaturesRef.current) go('rebuild');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const found = searchMenu(flattenMenu(items), query);
  const options = found.map((c) => ({
    value: c.key,
    label: (
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <span>{c.label}</span>
        <span style={{ color: CAD.dim, fontSize: 11 }}>{c.group}</span>
      </span>
    ),
  }));

  const hiddenInput = (ref, accept, onFile) => (
    <input
      ref={ref}
      type="file"
      accept={accept}
      style={{ display: 'none' }}
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-opening the same file name next time
        if (file) onFile(file);
      }}
    />
  );

  // Two rows: the app name with the command search on the right, and the menus
  // under it, starting at the left edge the way a desktop CAD lays out its title.
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }} data-menu-bar>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, lineHeight: 'normal' }} data-menu-title>
        {brand}
        <span style={{ flex: 1 }} />
        <AutoComplete
          ref={searchRef}
          size="small"
          value={query}
          options={options}
          onChange={setQuery}
          onSelect={(key) => { run({ key }); setQuery(''); searchRef.current?.blur(); }}
          filterOption={false}
          placeholder="Search commands (Ctrl+K)"
          allowClear
          style={{ width: 230, flex: '0 0 auto' }}
          popupMatchSelectWidth={300}
          data-menu-search
        />
        {operator && (
          <span style={{ color: CAD.label, fontSize: 12, whiteSpace: 'nowrap' }} data-menu-operator>
            {operator}
          </span>
        )}
      </div>
      {hiddenInput(fileInput, PROGRAM_ACCEPT, (file) => announced(async () => {
        if (!await openProgramFile(file)) return null;
        useLibraryStore.getState().setOpenItem(null);
        return `Opened project ${file.name}`;
      }))}
      {hiddenInput(projectInput, '.json,.camweb.json', (file) => announced(async () => {
        await openProjectFile(file);
        useLibraryStore.getState().setOpenItem(null);
        return `Opened project ${file.name}`;
      }))}
      <Modal
        open={saveAsName !== null}
        title="Save project as"
        okText="Save"
        okButtonProps={{ disabled: !saveAsName?.trim(), 'data-save-as-confirm': true }}
        onOk={() => { announced(() => saveAsFile(saveAsName)); setSaveAsName(null); }}
        onCancel={() => setSaveAsName(null)}
        destroyOnHidden
        width={420}
      >
        {/* Said here because the dialog cannot offer a folder: a page on plain
            HTTP is not allowed to open the browser's Save dialog itself. */}
        <div style={{ color: CAD.dim, fontSize: 12, marginBottom: 6 }}>
          This page is not on HTTPS, so the browser saves to its Downloads folder.
          To choose a folder, turn on “Ask where to save each file” in Chrome’s
          download settings.
        </div>
        <Input
          value={saveAsName ?? ''}
          autoFocus
          aria-label="File name"
          data-save-as-name
          onChange={(e) => setSaveAsName(e.target.value)}
          onPressEnter={() => {
            if (saveAsName?.trim()) { announced(() => saveAsFile(saveAsName)); setSaveAsName(null); }
          }}
        />
      </Modal>
      {hiddenInput(dxfInput, '.dxf', async (file) => {
        try {
          // The file's own name becomes the sketch's, so a drawing imported next
          // to two others is identifiable in the list.
          importDxf(await file.text(), { name: file.name.replace(/\.[^.]*$/, '') || 'DXF' });
        } catch (e) {
          setError?.(e?.message || String(e));
        }
      })}
      <Menu
        mode="horizontal"
        selectable={false}
        triggerSubMenuAction="click"
        items={items}
        onClick={run}
        style={{
          minWidth: 0,
          marginLeft: -12,
          background: 'transparent',
          borderBottom: 'none',
          lineHeight: '28px',
          fontSize: 12,
        }}
      />
    </div>
  );
}

