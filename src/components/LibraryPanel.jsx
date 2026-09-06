/**
 * The library, as a panel that drops out of the toolbar.
 *
 * Thin by the usual rule: every decision it shows — what a row says, how the
 * list is ordered, what name to offer, whether a name is allowed — comes from
 * `engine/savedWork.js`, and every action is one call into `libraryStore`. What
 * is here is the arrangement: the list of what is already kept, and above it the
 * two things worth saving.
 *
 * **Opening the library only shows the library.** It used to greet the operator
 * with a name box already filled in with a suggestion, and a press of *Project*
 * then saved under that suggestion — so a panel opened to *look something up*
 * was one click away from writing a new record nobody asked for, under a name
 * nobody chose. Naming now happens where the naming decision is made: pressing
 * Save opens a dialog with the suggested name selected, and nothing is written
 * until that dialog is confirmed.
 *
 * The rows carry words, and that is not a breach of the icon-only toolbar rule:
 * this is a menu that drops open, and SolidWorks labels those too. A saved item
 * has a name the operator typed — a list of glyphs would be unreadable.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Button, Popconfirm, Popover, Space, Tag, Typography, Input, Empty, Alert, Spin,
  Tooltip, Modal,
} from 'antd';
import {
  DeleteOutlined, FolderOpenOutlined, SaveOutlined, DownloadOutlined,
  ShareAltOutlined, RollbackOutlined, LockOutlined, TeamOutlined, FileAddOutlined,
} from '@ant-design/icons';
import { useLibraryStore } from '../stores/libraryStore.js';
import { formatBytes, formatSavedAt, namesOfKind, cleanName } from '../engine/savedWork.js';
import { CAD } from '../theme.js';

const { Text } = Typography;

const ROW = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 0', borderTop: `1px solid ${CAD.borderSoft}`,
};

const LIST = { maxHeight: 260, overflowY: 'auto', marginTop: 4 };

/**
 * The heading over one shelf, saying plainly whose it is.
 *
 * Both shelves look identical row for row, so the only thing telling an operator
 * that deleting here is safe and deleting there is not is this line. It is
 * therefore a label with an icon and a sentence, not a tab.
 */
function Shelf({ icon, title, hint, count, children }) {
  return (
    <div style={{ marginTop: 10 }}>
      <Space size={6} align="center">
        {icon}
        <Text style={{ color: CAD.label, fontSize: 12, fontWeight: 600 }}>{title}</Text>
        <Text style={{ color: CAD.dim, fontSize: 11 }}>{count}</Text>
      </Space>
      <Text style={{ color: CAD.dim, fontSize: 11, display: 'block' }}>{hint}</Text>
      {children}
    </div>
  );
}

/**
 * One saved item.
 *
 * Which buttons appear is the server's answer (`canShare` / `canUnshare` /
 * `canDelete`), not this component's opinion — the same rules are enforced on
 * the row itself, and a panel that computed its own version would eventually
 * offer a button that fails. A shared row somebody else published therefore has
 * only Open, which is the honest set.
 */
function Row({ item, onOpen, onRemove, onShare, onUnshare, busy }) {
  const by = item.shared && item.owner_name ? `by ${item.owner_name}` : null;
  return (
    <div style={ROW} data-library-item={item.id}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: CAD.text }} ellipsis>{item.name}</Text>
          <Tag color={item.kind === 'project' ? 'blue' : 'default'} style={{ marginInlineEnd: 0 }}>
            {item.kind}
          </Tag>
        </div>
        <Text style={{ color: CAD.muted, fontSize: 12 }}>
          {[by, item.note, formatBytes(item.bytes), formatSavedAt(item.savedAt)]
            .filter(Boolean).join(' · ')}
        </Text>
      </div>
      <Tooltip title={`Open ${item.name}`}>
        <Button
          size="small"
          icon={<FolderOpenOutlined />}
          aria-label={`Open ${item.name}`}
          data-library-open={item.id}
          disabled={busy}
          onClick={() => onOpen(item)}
        />
      </Tooltip>
      {item.canShare && (
        <Popconfirm
          title="Put this in the shared library?"
          description="Everyone will be able to open it. It leaves your own list."
          okText="Share"
          onConfirm={() => onShare(item)}
        >
          <Tooltip title="Share with everyone">
            <Button
              size="small"
              icon={<ShareAltOutlined />}
              aria-label={`Share ${item.name}`}
              data-library-share={item.id}
              disabled={busy}
            />
          </Tooltip>
        </Popconfirm>
      )}
      {item.canUnshare && (
        <Tooltip title="Take back into your own list">
          <Button
            size="small"
            icon={<RollbackOutlined />}
            aria-label={`Unshare ${item.name}`}
            data-library-unshare={item.id}
            disabled={busy}
            onClick={() => onUnshare(item)}
          />
        </Tooltip>
      )}
      {item.canDelete && (
        <Popconfirm
          title={item.shared ? 'Delete this from the shared library?' : 'Delete this saved item?'}
          okText="Delete"
          okButtonProps={{ danger: true }}
          onConfirm={() => onRemove(item)}
        >
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            aria-label={`Delete ${item.name}`}
            data-library-delete={item.id}
            disabled={busy}
          />
        </Popconfirm>
      )}
    </div>
  );
}

/**
 * The panel itself, in either of two settings.
 *
 * **Inline** (`inline`, with `open` controlled by the caller) is how the sidebar
 * shows it: the library is a place you work, not a menu you dip into — you save
 * something, look at what is there, open one, delete two — and a popover that
 * shuts when you click near its edge is the wrong container for that. It gets
 * the sidebar's own width and stays put until it is closed.
 *
 * **Popover** (`trigger`) is for the sketch rail, which has no sidebar to put a
 * panel in.
 *
 * @param {{trigger?:React.ReactNode, inline?:boolean, open?:boolean,
 *   onDone?:(msg:string)=>void}} props
 *   `onDone` reports a finished action back to the sidebar's own confirmation
 *   line, the same place saving a file reports to.
 */
export default function LibraryPanel({
  trigger, inline = false, open: openProp, onDone,
}) {
  const [openState, setOpenState] = useState(false);
  const open = inline ? openProp !== false : openState;
  const setOpen = inline ? () => {} : setOpenState;
  // Which kind of save is being named right now — 'project', 'program', or null
  // for "nothing is being saved", which is what opening the library means.
  const [saveKind, setSaveKind] = useState(null);
  const [name, setName] = useState('');
  // Has the operator typed a name of their own? Once they have, nothing may
  // overwrite it — least of all the suggestion arriving a moment later. A ref,
  // not state: the suggestion's `.then` closes over it and must read the value
  // as it is when it lands, not as it was when the dialog opened.
  const typed = useRef(false);
  const {
    items, loaded, busy, error, saveProject, saveProgram,
    open: openItem, remove, nameFor, mine, shared, share, unshare, refresh, setError,
    openItem: current, saveOpen, canSaveOpen, newProject,
  } = useLibraryStore();
  const myItems = mine();
  const sharedItems = shared();

  // Read the list when the panel is first opened, not on mount: a request on
  // every page load costs a round trip for a panel nobody may open. `loaded`
  // only goes true on success, so a failed read leaves the deps unchanged and
  // this does not spin.
  useEffect(() => {
    if (open && !loaded && !busy) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loaded]);

  const run = async (fn, message) => {
    try {
      const result = await fn();
      onDone?.(message(result));
      return result;
    } catch {
      // The store has already put the sentence in `error`, which is rendered
      // below — rethrowing here would only produce an unhandled rejection.
      return null;
    }
  };

  /**
   * Ask for a name. Nothing is written here — this only opens the dialog.
   *
   * The suggestion is fetched rather than held, because it depends on what is
   * already on this operator's shelf and the list is read lazily; offered before
   * the shelf is known it could look free and replace last week's work. Until it
   * lands the box is empty and Save is disabled, which is the honest state — a
   * box that fills in under the operator's fingers is how the old panel came to
   * save things nobody named.
   */
  const beginSave = (kind) => {
    typed.current = false;
    setName('');
    setError(null);
    setSaveKind(kind);
    nameFor(kind).then((n) => { if (!typed.current) setName(n); });
  };

  const clean = cleanName(name);
  // Saving over one of your own names is allowed and sometimes meant — but it
  // must be a decision, not a surprise, so the dialog says which it will be.
  const replaces = Boolean(saveKind) && namesOfKind(myItems, saveKind).has(clean);

  const confirmSave = async () => {
    const kind = saveKind;
    const save = kind === 'program' ? saveProgram : saveProject;
    const ok = await run(
      () => save(name),
      (m) => `Saved ${kind} “${m.name}”`,
    );
    // Left open on failure: the sentence explaining why is in the dialog, next
    // to the name that has to change.
    if (ok) setSaveKind(null);
  };

  const dialog = (
    <Modal
      open={Boolean(saveKind)}
      title={saveKind === 'program' ? 'Save program to your library' : 'Save project to your library'}
      okText="Save"
      okButtonProps={{ disabled: !clean || busy, loading: busy, 'data-library-confirm': true }}
      cancelButtonProps={{ 'data-library-cancel': true }}
      onOk={confirmSave}
      onCancel={() => setSaveKind(null)}
      destroyOnHidden
      zIndex={2000}
      width={420}
    >
      <Text style={{ color: CAD.muted, fontSize: 12, display: 'block', marginBottom: 6 }}>
        {saveKind === 'program'
          ? 'Just the G-code, as it stands in the editor.'
          : 'The part, setup, operations and sketch, as they stand now.'}
      </Text>
      <Input
        value={name}
        autoFocus
        onChange={(e) => { typed.current = true; setName(e.target.value); }}
        placeholder="Name this work"
        aria-label="Name for the saved item"
        data-library-name
        onPressEnter={() => { if (clean && !busy) confirmSave(); }}
      />
      <Text style={{ color: CAD.dim, fontSize: 12, display: 'block', marginTop: 6 }}>
        It goes on <b>your own</b> shelf. Share it afterwards if the shop needs it.
      </Text>
      {replaces && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          message={`You already have a ${saveKind} called “${clean}” — saving replaces it.`}
        />
      )}
      {error && <Alert type="error" showIcon style={{ marginTop: 8 }} message={error} />}
    </Modal>
  );

  const body = (
    <div
      style={inline ? { width: '100%' } : { width: 360 }}
      data-testid="library-panel"
    >
      {/* No "this browser cannot hold a library" branch any more: that was the
          IndexedDB store's, where private browsing could refuse to open the
          database before anything was attempted. The library is on the server
          now — it is either reachable or it is not, which is not knowable up
          front, so a failure lands in `error` beside the button that caused it. */}
      {/* What is open, and therefore what "Save" means right now. Saving used to
          have one shape — type a name — even when the job already had one, and
          re-typing a name you are trying *not* to change is where a typo
          becomes a second copy. */}
      {current && (
        <Text style={{ color: CAD.muted, fontSize: 12, display: 'block', marginBottom: 4 }} data-library-current>
          Open: <b>{current.name}</b>
          {current.shared && ' — shared, so saving makes your own copy'}
        </Text>
      )}

      <Space.Compact style={{ width: '100%' }}>
        <Button
          type="primary"
          style={{ flex: 1 }}
          icon={<SaveOutlined />}
          data-library-save-open
          disabled={busy || !canSaveOpen()}
          onClick={() => run(saveOpen, (m) => `Saved “${m.name}”`)}
        >
          Save
        </Button>
        <Button
          style={{ flex: 1 }}
          data-library-save="project"
          disabled={busy}
          onClick={() => beginSave('project')}
        >
          Save as…
        </Button>
      </Space.Compact>

      <Space.Compact style={{ width: '100%', marginTop: 4 }}>
        <Button
          style={{ flex: 1 }}
          icon={<DownloadOutlined />}
          data-library-save="program"
          disabled={busy}
          onClick={() => beginSave('program')}
        >
          Save program
        </Button>
        <Popconfirm
          title="Start a new project?"
          description="The part, the sketches, the feature tree and the program are all cleared. Save first if you want to keep them."
          okText="New project"
          cancelText="Cancel"
          onConfirm={() => run(newProject, () => 'Started a new project')}
        >
          <Button style={{ flex: 1 }} icon={<FileAddOutlined />} disabled={busy} data-library-new>
            New project
          </Button>
        </Popconfirm>
      </Space.Compact>
      <Text style={{ color: CAD.muted, fontSize: 12, display: 'block', marginTop: 4 }}>
        <b>Save</b> writes back over the project you have open; <b>Save as…</b>
        asks for a name. A project keeps the part, setup, operations and sketch;
        a program is just the G-code. Both go to <b>your own</b> list — nobody
        else's work is touched.
      </Text>

      {/* Not while the dialog is up: the same sentence is in there, beside the
          field the operator has to change. */}
      {error && !saveKind && (
        <Alert type="error" showIcon style={{ marginTop: 8 }} message={error} />
      )}

      {busy && !items.length && <Spin size="small" style={{ marginTop: 8 }} />}

      <Shelf
        icon={<LockOutlined style={{ color: CAD.label }} />}
        title="My work"
        hint="Only you can see, open or delete these."
        count={myItems.length ? `${myItems.length}` : ''}
      >
        <div style={LIST}>
          {loaded && !myItems.length && !busy && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={<Text style={{ color: CAD.muted }}>Nothing saved yet</Text>}
            />
          )}
          {myItems.map((item) => (
            <Row
              key={item.id}
              item={item}
              busy={busy}
              onOpen={(it) => run(
                () => openItem(it.id).then(() => it),
                (m) => `Opened “${m.name}”`,
              ).then((ok) => { if (ok) setOpen(false); })}
              onRemove={(it) => run(() => remove(it.id).then(() => it), (m) => `Deleted “${m.name}”`)}
              onShare={(it) => run(() => share(it.id).then(() => it), (m) => `Shared “${m.name}”`)}
            />
          ))}
        </div>
      </Shelf>

      <Shelf
        icon={<TeamOutlined style={{ color: CAD.label }} />}
        title="Shared library"
        hint="Everyone can open these. Only whoever shared one can remove it."
        count={sharedItems.length ? `${sharedItems.length}` : ''}
      >
        <div style={LIST}>
          {loaded && !sharedItems.length && !busy && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={<Text style={{ color: CAD.muted }}>Nothing shared yet</Text>}
            />
          )}
          {sharedItems.map((item) => (
            <Row
              key={item.id}
              item={item}
              busy={busy}
              onOpen={(it) => run(
                () => openItem(it.id).then(() => it),
                (m) => `Opened “${m.name}”`,
              ).then((ok) => { if (ok) setOpen(false); })}
              onRemove={(it) => run(() => remove(it.id).then(() => it), (m) => `Deleted “${m.name}”`)}
              onUnshare={(it) => run(
                () => unshare(it.id).then(() => it),
                (m) => `“${m.name}” is back in your own list`,
              )}
            />
          ))}
        </div>
      </Shelf>
    </div>
  );

  // The dialog is rendered outside the panel in both arrangements, so that
  // shutting the popover behind it (which clicking into a portal does) cannot
  // take the half-typed name down with it.
  if (inline) {
    if (!open) return dialog;
    return (
      <>
        <div style={{
          border: `1px solid ${CAD.borderSoft}`, borderRadius: 8, padding: 10,
          background: CAD.surface,
        }}>
          <Text style={{ color: CAD.muted, fontSize: 11, letterSpacing: 0.6 }}>
            LIBRARY — YOUR WORK, AND THE SHARED SHELF
          </Text>
          <div style={{ marginTop: 6 }}>{body}</div>
        </div>
        {dialog}
      </>
    );
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="bottomLeft"
        title={<span style={{ color: CAD.text }}>Library — your work, and the shared shelf</span>}
        content={body}
      >
        {trigger}
      </Popover>
      {dialog}
    </>
  );
}
