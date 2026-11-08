import { Button, Space, Tooltip } from 'antd';
import { CUTTER_ICONS } from './glyph.jsx';
import { CUTTERS } from '../engine/cam/cutters.js';
import { CAD } from '../theme.js';

/**
 * Pick a cutter TYPE — the six shapes in `engine/cam/cutters.js`.
 *
 * Icon-only, per the toolbar convention: the tooltip names each and says what
 * it is for. Shared by the fallback cutter and by every row of the Tool table,
 * because they are the same question asked about different tools — the table
 * used to ask a narrower one (Flat or Ball), which could not say "face mill"
 * at all, so a Ø50 face mill in the program could only ever be drawn and
 * carved as a Ø50 stick.
 */
export default function CutterPicker({ value, onChange, box = 32, scope = 'fallback' }) {
  return (
    <Space size={2} wrap>
      {CUTTERS.map((c) => {
        const Icon = CUTTER_ICONS[c.id];
        return (
          <Tooltip
            key={c.id}
            title={(
              <span>
                <b>{c.label}</b>
                <span style={{ display: 'block', opacity: 0.82, fontSize: 12, marginTop: 2 }}>
                  {c.note}
                </span>
              </span>
            )}
          >
            <Button
              size="small"
              aria-label={c.label}
              data-cutter={c.id}
              // Which tool is being typed — the fallback, or a row of the Tool
              // table. Both render the same six glyphs, so a test that asks for
              // "the face mill button" has to say whose.
              data-cutter-scope={scope}
              type={value === c.id ? 'primary' : 'text'}
              icon={<Icon />}
              onClick={() => onChange(c.id)}
              style={{
                width: box, height: box, padding: 0,
                color: value === c.id ? undefined : CAD.icon,
              }}
            />
          </Tooltip>
        );
      })}
    </Space>
  );
}
