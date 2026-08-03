/**
 * @vitest-environment jsdom
 *
 * The contract that makes an icon-only toolbar usable, in the real DOM.
 *
 * `engine/view/commands.test.js` proves the catalogue is complete — every
 * command has a name and a hint that says something new. That is necessary and
 * not sufficient: a catalogue entry helps nobody if the button renders without
 * the name on it. What this holds is the wiring:
 *
 * - the name reaches `aria-label`, so the button is not silent to a screen
 *   reader and not anonymous to a test;
 * - the id reaches `data-cmd`, which is now the only stable handle the other
 *   component suites have;
 * - the words stay OFF the button unless the catalogue says otherwise.
 *
 * The last one is the whole refactor. Without it a later edit can quietly put a
 * label back and nothing anywhere would notice.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import CommandButton from './CommandButton.jsx';
import { COMMANDS, command } from '../engine/view/commands.js';

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(node) {
  await act(async () => root.render(node));
  return container;
}

const btn = () => container.querySelector('button');

describe('every command in the catalogue renders as a named button', () => {
  it.each(COMMANDS)('$id carries its name and id', async ({ id, label }) => {
    await render(<CommandButton id={id} />);
    expect(btn().getAttribute('aria-label')).toBe(label);
    expect(btn().dataset.cmd).toBe(id);
  });

  it.each(COMMANDS.filter((c) => !c.keepsText))('$id renders no text', async ({ id, label }) => {
    await render(<CommandButton id={id} />);
    expect(btn().textContent).not.toContain(label);
  });

  it.each(COMMANDS.filter((c) => c.keepsText))('$id keeps its label', async ({ id, label }) => {
    await render(<CommandButton id={id} />);
    expect(btn().textContent).toContain(label);
  });
});

describe('what a caller can and cannot change', () => {
  it('passes ordinary Button props straight through', async () => {
    await render(<CommandButton id="parse" type="primary" size="small" disabled />);
    expect(btn().disabled).toBe(true);
    expect(btn().className).toMatch(/ant-btn-primary/);
    expect(btn().className).toMatch(/ant-btn-sm/);
  });

  it('renders the icon it was handed', async () => {
    await render(<CommandButton id="parse" icon={<span data-testid="ic" />} />);
    expect(container.querySelector('[data-testid="ic"]')).toBeTruthy();
  });

  it('fires onClick', async () => {
    let hits = 0;
    await render(<CommandButton id="parse" onClick={() => { hits += 1; }} />);
    await act(async () => btn().click());
    expect(hits).toBe(1);
  });

  it('keeps the name even when the description is overridden per state', async () => {
    // The frame toggle says something different when it is on; the command it
    // *is* must not change with it, or the button renames itself mid-session.
    await render(<CommandButton id="rotateWork" title="On: the table turns the work" />);
    expect(btn().getAttribute('aria-label')).toBe(command('rotateWork').label);
  });

  it('drops a caller-supplied child for a command that keeps no text', async () => {
    // Guards the accident this refactor was undoing: a label smuggled back in
    // as a child would render, silently, on a button meant to be a glyph.
    await render(<CommandButton id="parse">Parse</CommandButton>);
    expect(btn().textContent).toBe('');
  });

  it('throws on an unknown id rather than rendering a nameless button', () => {
    expect(() => command('notACommand')).toThrow(/Unknown command id/);
  });
});
