import { Alert, Space, Typography, InputNumber, Tooltip } from 'antd';
import { ColumnWidthOutlined } from '@ant-design/icons';
import CommandButton from './CommandButton.jsx';
import { StockCutIcon } from './glyph.jsx';
import { CAD } from '../theme.js';

const { Text } = Typography;

/**
 * The billet: how big it is, and where it sits.
 *
 * Every number here is computed in `engine/sim/billet.js` — the box, the
 * extents, whether the program fits inside, and the blank to offer. This places
 * the fields and reports what the engine said.
 *
 * The extents line under the fields is not decoration. "Origin" is ambiguous on
 * its own — a corner, a centre, the middle of the top face are all plausible
 * readings, and no label settles it as well as printing the resulting range.
 * With `X −10.0 … 70.0` on screen there is nothing left to guess at.
 */
export default function BilletBox({
  size, origin, extents, suggestion, warnings, onSize, onOrigin, onFit,
  enabled, onToggle, addonStyle,
}) {
  const field = (k, value, onChange, placeholder, allowNegative) => (
    <Space.Compact key={k}>
      <span className="ant-input-group-addon" style={addonStyle('left')}>{k.toUpperCase()}</span>
      <InputNumber controls={false}
        disabled={!enabled}
        {...(allowNegative ? {} : { min: 0 })}
        placeholder={placeholder}
        value={value[k]}
        onChange={(v) => onChange({
          // A size of 0 is not a billet; an origin of 0 is a perfectly good
          // place to put one, so only sizes treat zero as "unset".
          [k]: allowNegative
            ? (Number.isFinite(v) ? v : null)
            : (v && v > 0 ? v : null),
        })}
        style={{ width: 76 }}
      />
    </Space.Compact>
  );
  const range = ([lo, hi]) => `${lo.toFixed(1)} … ${hi.toFixed(1)}`;

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Space align="center" wrap size="small">
        {/* On/off for the whole billet. Off hands the blank back to the
            automatic fit around the toolpath and takes the preview with it. */}
        <CommandButton
          id="stockEnabled"
          size="small"
          type={enabled ? 'primary' : 'default'}
          icon={<StockCutIcon />}
          onClick={onToggle}
        />
        <Tooltip title="The blank in the vice, in mm. Leave an axis blank to wrap the toolpath instead.">
          <span style={{ color: enabled ? CAD.label : CAD.dim }}>Stock</span>
        </Tooltip>
        {['x', 'y', 'z'].map((k) => field(k, size, onSize, 'auto', false))}
        <span style={{ color: CAD.dim, fontSize: 12 }}>mm</span>
        {suggestion && enabled && (
          <CommandButton
            id="fitStock"
            size="small"
            type="text"
            icon={<ColumnWidthOutlined />}
            onClick={onFit}
          />
        )}
      </Space>
      <Space align="center" wrap size="small">
        <span style={{ width: 24, display: 'inline-block' }} />
        <Tooltip title="Where the blank's X−/Y−/Z− corner sits in work coordinates. Blank centres it on the cutting in X and Y, and puts the top face on Z0 — which is now only a default, not a rule.">
          <span style={{ color: enabled ? CAD.label : CAD.dim }}>Origin</span>
        </Tooltip>
        {['x', 'y', 'z'].map((k) => field(k, origin, onOrigin, 'auto', true))}
        <span style={{ color: CAD.dim, fontSize: 12 }}>mm</span>
      </Space>
      {enabled && extents && (
        <Text style={{ color: CAD.dim, fontSize: 11, fontFamily: 'monospace' }}>
          X {range(extents.x)} · Y {range(extents.y)} · Z {range(extents.z)}
        </Text>
      )}
      {!enabled && (
        <Text style={{ color: CAD.dim, fontSize: 11 }}>
          Stock off — the sim fits a blank around the toolpath.
        </Text>
      )}
      {enabled && warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="The program cuts outside the blank"
          description={<ul style={{ margin: 0, paddingLeft: 18 }}>
            {warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>}
        />
      )}
    </Space>
  );
}
