/**
 * GcodePanel — G-code text with line numbers that highlights and auto-scrolls
 * to the line currently executing (driven by the playback playhead).
 *
 * Read-only while playing back; an Edit toggle swaps to a textarea so the
 * program can still be modified. Keeping them separate avoids the complexity of
 * a highlighting editable field while giving a clear "which line is running" cue.
 *
 * ## Two things here are load-bearing
 *
 * **Only the rows on screen are in the DOM.** This listed every line of the
 * program, and playback re-renders it 25 times a second — measured at ~250 ms of
 * main thread per frame on a 6,000-line program, against ~80 ms for the same run
 * with the panel hidden. That is what "the highlight doesn't follow what is
 * actually running" was: it repainted about four times a second and lurched ~50
 * lines at a time. Single-stepping never showed it, because one update has
 * nothing to keep up with. The window comes from `engine/view/listing.js`; the
 * cost is now the panel's height, not the program's length.
 *
 * **Every row is exactly `LINE_H` tall.** The window arithmetic is row index ×
 * row height, so a row that sizes itself to its font would put the highlight on
 * the wrong line. Do not replace the explicit `height` with a `lineHeight` alone.
 *
 * The panel fills the column it is given rather than sitting in a 320 px box:
 * while a program runs, the listing is the one live thing on screen, and a
 * fixed-height box left two thirds of the column empty under it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Input, Space } from 'antd';
import { EditOutlined, EyeOutlined } from '@ant-design/icons';
import CommandButton from './CommandButton.jsx';
import { visibleRange, followScrollTop, LINE_H } from '../engine/view/listing.js';
import { CAD } from '../theme.js';

/**
 * Height assumed until the box has measured itself — and kept if it never can.
 * A `clientHeight` of 0 means "not laid out" far more often than it means a
 * zero-tall panel (it is what every environment without layout reports), and
 * believing it renders no rows at all: a listing that is simply blank.
 */
const INITIAL_H = 320;

export default function GcodePanel({ gcode, activeLine, onChange }) {
  const [editing, setEditing] = useState(false);
  const boxRef = useRef(null);
  const [box, setBox] = useState({ scrollTop: 0, height: INITIAL_H });
  const lines = useMemo(() => gcode.split(/\r?\n/), [gcode]);

  // The box's own height — it fills the column, so it changes with the window
  // and with the parse-error alert appearing above it, not just on mount.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => setBox((b) => {
      const h = el.clientHeight;
      return (h > 0 && h !== b.height) ? { ...b, height: h } : b;
    });
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [editing]);

  const onScroll = useCallback((e) => {
    const { scrollTop } = e.currentTarget;
    setBox((b) => (b.scrollTop === scrollTop ? b : { ...b, scrollTop }));
  }, []);

  // Keep the executing line in view while scrubbing/playing. Written straight to
  // `scrollTop` rather than through `scrollIntoView`, which forces a synchronous
  // layout of the whole box — and `followScrollTop` returns null far more often
  // than not, so a line already on screen costs nothing at all.
  useEffect(() => {
    if (editing) return;
    const el = boxRef.current;
    if (!el) return;
    const next = followScrollTop({
      line: activeLine, total: lines.length, scrollTop: el.scrollTop, height: el.clientHeight,
    });
    if (next == null) return;
    el.scrollTop = next;
    // Set it here as well as letting the scroll event arrive: the window has to
    // be rendered in the same commit, or the highlight lands on a row that is
    // not in the DOM yet and the panel flashes empty.
    setBox((b) => ({ ...b, scrollTop: next }));
  }, [activeLine, editing, lines.length]);

  const { start, end, padTop, padBottom } = visibleRange({
    total: lines.length, scrollTop: box.scrollTop, height: box.height,
  });

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      // Both, on purpose: `height` fills an ordinary block parent, `flex` fills a
      // flex column (which is how `LeftColumn` gives it the pane).
      height: '100%', flex: '1 1 auto', minHeight: 0,
    }}
    >
      <Space style={{ marginBottom: 6, flex: '0 0 auto' }}>
        {/* One button, two commands — the catalogue names each state rather
            than the toggle, so the tooltip says what pressing it will do. */}
        <CommandButton
          id={editing ? 'viewGcode' : 'editGcode'}
          size="small"
          icon={editing ? <EyeOutlined /> : <EditOutlined />}
          onClick={() => setEditing((e) => !e)}
        />
        {!editing && activeLine > 0 && (
          <span style={{ color: CAD.muted, fontSize: 12 }}>line {activeLine}</span>
        )}
      </Space>

      {editing ? (
        <Input.TextArea
          value={gcode}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1, minHeight: 0, resize: 'none',
            fontFamily: 'monospace', fontSize: 12,
          }}
        />
      ) : (
        <div
          ref={boxRef}
          onScroll={onScroll}
          data-gcode-listing
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            background: CAD.surface,
            border: `1px solid ${CAD.border}`,
            borderRadius: 6,
            fontFamily: 'monospace',
            fontSize: 12,
          }}
        >
          {/* The lines above and below the window, as height alone — so the
              scrollbar still measures the whole program. */}
          <div style={{ height: padTop }} />
          {lines.slice(start, end).map((text, i) => {
            const lineNo = start + i + 1;
            const active = lineNo === activeLine;
            return (
              <div
                key={lineNo}
                data-gcode-line={lineNo}
                data-gcode-active={active ? '' : undefined}
                style={{
                  display: 'flex',
                  height: LINE_H,
                  lineHeight: `${LINE_H}px`,
                  background: active ? CAD.accentSoft : 'transparent',
                  borderLeft: active ? `3px solid ${CAD.accent}` : '3px solid transparent',
                }}
              >
                <span
                  style={{
                    width: 34,
                    textAlign: 'right',
                    paddingRight: 8,
                    color: CAD.dim,
                    userSelect: 'none',
                    flex: '0 0 auto',
                  }}
                >
                  {lineNo}
                </span>
                <span style={{ color: active ? CAD.text : CAD.label, whiteSpace: 'pre' }}>
                  {text || ' '}
                </span>
              </div>
            );
          })}
          <div style={{ height: padBottom }} />
        </div>
      )}
    </div>
  );
}
