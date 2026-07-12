/**
 * GcodePanel — G-code text with line numbers that highlights and auto-scrolls
 * to the line currently executing (driven by the playback playhead).
 *
 * Read-only while playing back; an Edit toggle swaps to a textarea so the
 * program can still be modified. Keeping them separate avoids the complexity of
 * a highlighting editable field while giving a clear "which line is running" cue.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Space } from 'antd';
import { EditOutlined, EyeOutlined } from '@ant-design/icons';

export default function GcodePanel({ gcode, activeLine, onChange }) {
  const [editing, setEditing] = useState(false);
  const activeRef = useRef(null);
  const lines = useMemo(() => gcode.split(/\r?\n/), [gcode]);

  // Keep the executing line in view while scrubbing/playing.
  useEffect(() => {
    if (!editing && activeRef.current) {
      activeRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [activeLine, editing]);

  return (
    <div>
      <Space style={{ marginBottom: 6 }}>
        <Button
          size="small"
          icon={editing ? <EyeOutlined /> : <EditOutlined />}
          onClick={() => setEditing((e) => !e)}
        >
          {editing ? 'View' : 'Edit'}
        </Button>
        {!editing && activeLine > 0 && (
          <span style={{ color: '#64748b', fontSize: 12 }}>line {activeLine}</span>
        )}
      </Space>

      {editing ? (
        <Input.TextArea
          value={gcode}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoSize={{ minRows: 10, maxRows: 20 }}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      ) : (
        <div
          style={{
            maxHeight: 320,
            overflow: 'auto',
            background: '#0b1220',
            border: '1px solid #334155',
            borderRadius: 6,
            fontFamily: 'monospace',
            fontSize: 12,
            lineHeight: '18px',
          }}
        >
          {lines.map((text, i) => {
            const lineNo = i + 1;
            const active = lineNo === activeLine;
            return (
              <div
                key={i}
                ref={active ? activeRef : null}
                style={{
                  display: 'flex',
                  background: active ? 'rgba(56,189,248,0.22)' : 'transparent',
                  borderLeft: active ? '3px solid #38bdf8' : '3px solid transparent',
                }}
              >
                <span
                  style={{
                    width: 34,
                    textAlign: 'right',
                    paddingRight: 8,
                    color: '#475569',
                    userSelect: 'none',
                    flex: '0 0 auto',
                  }}
                >
                  {lineNo}
                </span>
                <span style={{ color: active ? '#e2e8f0' : '#94a3b8', whiteSpace: 'pre' }}>
                  {text || ' '}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
