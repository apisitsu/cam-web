/**
 * Which axis a revolve turns about: the sketch's own X or Y, or a centerline
 * drawn on it (a construction line), the way SolidWorks takes a centerline.
 *
 * One control for the Build panel and the feature tree, so the two cannot offer
 * different choices for the same feature. The value is a string — `'x'`, `'y'`
 * or `'line:<id>'` — and `axisFromValue` turns it back into the feature's
 * `{ axis, axisLine }`.
 */
import { Segmented } from 'antd';
import { centerlines } from '../engine/sketch/model.js';

/** The control's value for a feature's `{ axis, axisLine }`. */
export const axisValueOf = (axis, axisLine) => (axisLine != null ? `line:${axisLine}` : axis);

/** The feature fields a control value stands for. */
export function axisFromValue(value) {
  if (typeof value === 'string' && value.startsWith('line:')) {
    return { axis: 'x', axisLine: Number(value.slice(5)) };
  }
  return { axis: value === 'y' ? 'y' : 'x', axisLine: null };
}

/**
 * What a new revolve should turn about on this sketch: its centerline when it has
 * one, which is why one was drawn; else the sketch's X axis.
 */
export function defaultAxisValue(doc) {
  const lines = doc ? centerlines(doc) : [];
  return lines.length ? `line:${lines[0].id}` : 'x';
}

export default function RevolveAxis({
  doc, value, onChange, long = false, ...rest
}) {
  const lines = doc ? centerlines(doc) : [];
  const options = [
    { label: long ? 'About X' : 'X', value: 'x' },
    { label: long ? 'About Y' : 'Y', value: 'y' },
    ...lines.map((l, i) => ({
      label: lines.length > 1 ? `Centerline ${i + 1}` : 'Centerline',
      value: `line:${l.id}`,
    })),
  ];
  return <Segmented size="small" value={value} onChange={onChange} options={options} {...rest} />;
}
