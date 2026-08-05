/**
 * The library, as a panel that drops out of the toolbar.
 *
 * Thin by the usual rule: every decision it shows — what a row says, how the
 * list is ordered, what name to offer, whether a name is allowed — comes from
 * `engine/savedWork.js`, and every action is one call into `libraryStore`. What
 * is here is the arrangement: a name box with the two things worth saving, and
 * under it the list of what is already kept.
 *
 * The rows carry words, and that is not a breach of the icon-only toolbar rule:
 * this is a menu that drops open, and SolidWorks labels those too. A saved item
 * has a name the operator typed — a list of glyphs would be unreadable.
 */
import { useEffect, useState } from 'react';
import {
  Button, Popconfirm, Popover, Space, Tag, Typography, Input, Empty, Alert, Spin,
} from 'antd';
import { DeleteOutlined, FolderOpenOutlined, SaveOutlined, DownloadOutlined } from '@ant-design/icons';
import { useLibraryStore } from '../stores/libraryStore.js';
import { formatBytes, formatSavedAt } from '../engine/savedWork.js';

const { Text } = Typography;

const ROW = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 0', borderTop: '1px solid #1f2937',
};

const LIST = { maxHeight: 320, overflowY: 'auto', marginTop: 8 };

/** One saved item. */
function Row({ item, onOpen, onRemove, busy }) {
  return (
    <div style={ROW} data-library-item={item.key}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: '#e2e8f0' }} ellipsis>{item.name}</Text>
          <Tag color={item.kind === 'project' ? 'blue' : 'default'} style={{ marginInlineEnd: 0 }}>
            {item.kind}
          </Tag>
        </div>
        <Text style={{ color: '#64748b', fontSize: 12 }}>
          {[item.note, formatBytes(item.bytes), formatSavedAt(item.savedAt)]
            .filter(Boolean).join(' · ')}
        </Text>
      </div>
      <Button
        size="small"
        icon={<FolderOpenOutlined />}
        aria-label={`Open ${item.name}`}
        data-library-open={item.key}
        disabled={busy}
        onClick={() => onOpen(item)}
      />
      <Popconfirm
        title="Delete this saved item?"
        okText="Delete"
        okButtonProps={{ danger: true }}
        onConfirm={() => onRemove(item)}
      >
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          aria-label={`Delete ${item.name}`}
          data-library-delete={item.key}
          disabled={busy}
        />
      </Popconfirm>
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
  const [name, setName] = useState('');
  // Has the operator typed a name of their own? Once they have, nothing may
  // overwrite it — least of all the list finishing loading a moment later.
  const [typed, setTyped] = useState(false);
  const {
    items, loaded, busy, error, available, saveProject, saveProgram,
    open: openItem, remove, nameFor,
  } = useLibraryStore();

  // Read the list when the panel is first opened, not on mount: a database read
  // on every page load costs a transaction for a panel nobody may open. The
  // name follows the list rather than racing it — offered before the names in
  // the library are known, it could look free and replace something on save.
  useEffect(() => {
    if (!open || !available || typed) return undefined;
    let live = true;
    nameFor('project').then((n) => { if (live) setName(n); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, available, typed, loaded, items]);

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

  const body = (
    <div
      style={inline ? { width: '100%' } : { width: 360 }}
      data-testid="library-panel"
    >
      {!available ? (
        <Alert
          type="warning"
          showIcon
          message="No library in this browser"
          description="Private browsing blocks the storage this needs. Saving to a file still works."
        />
      ) : (
        <>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={name}
              onChange={(e) => { setTyped(true); setName(e.target.value); }}
              placeholder="Name this work"
              aria-label="Name for the saved item"
              data-library-name
              onPressEnter={() => run(() => saveProject(name), (m) => `Saved project “${m.name}”`)}
            />
            <Button
              icon={<SaveOutlined />}
              data-library-save="project"
              disabled={busy}
              onClick={() => run(() => saveProject(name), (m) => `Saved project “${m.name}”`)}
            >
              Project
            </Button>
            <Button
              icon={<DownloadOutlined />}
              data-library-save="program"
              disabled={busy}
              onClick={() => run(() => saveProgram(name), (m) => `Saved program “${m.name}”`)}
            >
              Program
            </Button>
          </Space.Compact>
          <Text style={{ color: '#64748b', fontSize: 12, display: 'block', marginTop: 4 }}>
            A project keeps the part, setup, operations and sketch. A program is
            just the G-code. Saving over a name replaces it.
          </Text>

          {error && (
            <Alert type="error" showIcon style={{ marginTop: 8 }} message={error} />
          )}

          <div style={LIST}>
            {busy && !items.length && <Spin size="small" />}
            {loaded && items.length === 0 && !busy && (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={<Text style={{ color: '#64748b' }}>Nothing saved yet</Text>}
              />
            )}
            {items.map((item) => (
              <Row
                key={item.key}
                item={item}
                busy={busy}
                onOpen={(it) => run(
                  () => openItem(it.key).then(() => it),
                  (m) => `Opened “${m.name}”`,
                ).then((ok) => { if (ok) setOpen(false); })}
                onRemove={(it) => run(() => remove(it.key).then(() => it), (m) => `Deleted “${m.name}”`)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );

  if (inline) {
    if (!open) return null;
    return (
      <div style={{
        border: '1px solid #1f2937', borderRadius: 8, padding: 10,
        background: '#0b1220',
      }}>
        <Text style={{ color: '#64748b', fontSize: 11, letterSpacing: 0.6 }}>
          LIBRARY — SAVED IN THIS BROWSER
        </Text>
        <div style={{ marginTop: 6 }}>{body}</div>
      </div>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomLeft"
      title={<span style={{ color: '#e2e8f0' }}>Library — saved in this browser</span>}
      content={body}
    >
      {trigger}
    </Popover>
  );
}
