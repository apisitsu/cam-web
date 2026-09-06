/**
 * The library of saved work — what a record **is**, before any database is
 * involved.
 *
 * Saving has meant writing a file since there was anything to save: a project
 * goes to `.camweb.json`, a program to `.nc`, and the browser's own save dialog
 * decides where. That is the right way to *hand work on* — to a machine, to a
 * colleague, into a backup — and the wrong way to keep it. A file the operator
 * has to find again is a file they will open the wrong version of, and on a
 * tablet on the shop floor it is a file they may not be able to find at all.
 *
 * So the app keeps its own store: names in, names out, no dialog, and it
 * survives a refresh — and, since the library moved onto the server, a change of
 * machine and a change of shift too. This module is the pure half of that — the
 * record shape, the naming rules and the list ordering — kept out of
 * `lib/workApi.js` (which owns the transport) for the usual reason: the format
 * is the part worth testing, and an HTTP round trip cannot be tested here.
 *
 * A record is stored in **two pieces**, and that split is the whole reason
 * listing a library of ten projects is fast:
 *
 * - the **meta** — name, kind, when, how big, one line of what is in it. Small,
 *   fixed size, and all the list needs.
 * - the **data** — the program text, or the entire project document, which
 *   carries a base64 STL and can run to megabytes.
 *
 * Reading a cursor over the data to draw a list would deserialize every one of
 * those payloads to show a row of names.
 *
 * Pure: plain data in, plain data out. No DOM, no transport, no store.
 */

import { PROJECT_KIND } from './projectFile.js';

/** The two things worth keeping: a program on its own, or the whole session. */
export const KINDS = ['program', 'project'];

/**
 * Bump when the stored shape changes incompatibly. Unlike a project *file*,
 * which arrives from anywhere and may be from a newer build, these records are
 * written by this app into its own table — so the version is here to let a
 * future build migrate them, not to police strangers.
 */
export const LIBRARY_VERSION = 1;

/** Longest name the list can show without the row becoming a paragraph. */
export const NAME_MAX = 60;

/**
 * The key a record is stored under: its kind and its name.
 *
 * Deliberately not a generated id. A library keyed by name behaves the way a
 * folder does — saving "OR35128 OP10" twice replaces it, which is what an
 * operator means by saving again, and it means the same work cannot quietly
 * accumulate as eight identical rows. Wanting a copy is what `uniqueName` is
 * for, and it is an explicit act.
 *
 * The kind is part of the key so a program and a project may share a name: they
 * are different things about the same job, and one must not overwrite the other.
 */
export function libraryKey(kind, name) {
  return `${kind}/${name}`;
}

/**
 * Tidy a name the user typed into one a list can show and a key can hold.
 *
 * Control characters and newlines are stripped (a pasted name brings them), runs
 * of whitespace collapse, and the result is capped. `/` is *not* special — this
 * is not a path — but leading and trailing whitespace is, because " part" and
 * "part " look identical in a list and are two different records.
 */
export function cleanName(name) {
  return String(name ?? '')
    // \p{Cc} is Unicode's control category — a pasted name brings tabs and
    // newlines with it, and a newline in a list row is a broken row.
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    // Trim again: the cut can land mid-word and leave the space before it.
    .trim();
}

/**
 * Check a name, with a message meant for the user. Returns the cleaned name.
 * Throws rather than silently saving as "untitled": a save that lands somewhere
 * the operator did not name is a save they will not find.
 */
export function requireName(name) {
  const clean = cleanName(name);
  if (!clean) throw new Error('Give this a name so you can find it again.');
  return clean;
}

/**
 * A name to offer, from whatever the work is already called: the loaded file's
 * name without its extension, else the fallback.
 */
export function suggestName(fileName, fallback = 'Untitled') {
  const base = String(fileName ?? '').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
  return cleanName(base) || fallback;
}

/**
 * `name`, or the first "name (2)", "name (3)"… that is not taken.
 *
 * `taken` is the set of names already in the library **of the same kind** — a
 * program and a project may share a name (see `libraryKey`), so passing all of
 * them would refuse a perfectly good name.
 */
export function uniqueName(name, taken = []) {
  const set = taken instanceof Set ? taken : new Set(taken);
  const base = cleanName(name);
  if (!set.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = ` (${n})`;
    // Keep the whole thing inside NAME_MAX by trimming the base, not the suffix
    // — a name that ends "(7" says nothing.
    const trimmed = base.slice(0, NAME_MAX - suffix.length).trim();
    const candidate = `${trimmed}${suffix}`;
    if (!set.has(candidate)) return candidate;
  }
  return `${base.slice(0, NAME_MAX - 14).trim()} ${Date.now()}`;
}

/** Lines of actual program in some G-code — blank lines are not blocks. */
export function programLines(gcode) {
  if (!gcode) return 0;
  let n = 0;
  for (const line of String(gcode).split(/\r?\n/)) if (line.trim()) n += 1;
  return n;
}

/** Bytes a string takes as UTF-8, for the "how big is this" column. */
export function byteLength(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(text ?? '')).length;
  return String(text ?? '').length;
}

/**
 * The one line the list shows under a name — what is actually in this record,
 * in the terms the operator saved it in.
 *
 * A project's line is what makes the library worth opening: "3 ops · a part ·
 * 412 blocks" is the difference between two saves of the same job, and a row
 * that only said "project" would make the operator open both to find out.
 */
export function describe(kind, payload = {}) {
  if (kind === 'program') {
    const lines = programLines(payload.gcode);
    return `${lines} block${lines === 1 ? '' : 's'}`;
  }
  const doc = payload.project || {};
  const bits = [];
  const lines = programLines(doc.gcode);
  if (lines) bits.push(`${lines} block${lines === 1 ? '' : 's'}`);
  const ops = doc.cam?.ops?.length ?? doc.cam?.operations?.length ?? 0;
  if (ops) bits.push(`${ops} op${ops === 1 ? '' : 's'}`);
  if (doc.cam?.part || doc.cam?.mesh) bits.push('a part');
  if (doc.sketch) bits.push('a sketch');
  return bits.length ? bits.join(' · ') : 'empty';
}

/**
 * Split a saved thing into the row the list shows and the payload it opens.
 *
 * @param {{kind:string, name:string, mode?:string, savedAt?:string,
 *   gcode?:string, project?:object}} args
 * @returns {{meta:object, data:object}} both keyed the same, so a delete that
 *   removes one always finds the other.
 */
export function buildRecord({
  kind, name, mode = null, savedAt = null, gcode = null, project = null,
} = {}) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown kind of saved work: ${kind}`);
  const clean = requireName(name);
  const when = savedAt || new Date().toISOString();
  const payload = kind === 'program' ? { gcode: String(gcode ?? '') } : { project };
  if (kind === 'project' && (!project || typeof project !== 'object')) {
    throw new Error('There is no project to save yet.');
  }
  const key = libraryKey(kind, clean);
  const text = kind === 'program' ? payload.gcode : JSON.stringify(project);
  return {
    meta: {
      key,
      kind,
      name: clean,
      savedAt: when,
      version: LIBRARY_VERSION,
      mode: mode ?? (kind === 'project' ? project?.settings?.mode ?? null : null),
      bytes: byteLength(text),
      note: describe(kind, payload),
    },
    data: { key, kind, name: clean, savedAt: when, version: LIBRARY_VERSION, ...payload },
  };
}

/**
 * Check a payload read back out before it is applied to the app.
 *
 * The database is ours and the records went in valid, but a browser store is
 * not a guarantee: it survives builds, and a half-written record from a tab
 * killed mid-save is a real thing. Better a sentence than a store applying
 * `undefined` as a program.
 */
export function readPayload(data) {
  if (!data || typeof data !== 'object') throw new Error('That saved item could not be read back.');
  if (data.kind === 'program') {
    if (typeof data.gcode !== 'string') throw new Error('That saved program has no text in it.');
    return { kind: 'program', name: data.name ?? '', gcode: data.gcode };
  }
  if (data.kind === 'project') {
    const doc = data.project;
    if (!doc || typeof doc !== 'object') throw new Error('That saved project is empty.');
    if (doc.kind && doc.kind !== PROJECT_KIND) {
      throw new Error('That saved item is not a cam-web project.');
    }
    return { kind: 'project', name: data.name ?? '', project: doc };
  }
  throw new Error('That saved item is of a kind this build does not know.');
}

/**
 * The list, newest first — which is the order the operator wants: the thing
 * they were just working on is the thing they are most likely to reopen. Ties
 * fall back to the name so the order is stable rather than whatever the
 * database happened to iterate in.
 */
export function sortLibrary(metas = []) {
  return [...metas].sort((a, b) => {
    const ta = Date.parse(a?.savedAt ?? '') || 0;
    const tb = Date.parse(b?.savedAt ?? '') || 0;
    if (tb !== ta) return tb - ta;
    return String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
  });
}

/**
 * The two shelves, out of the one list the server returns.
 *
 * A row is on exactly one of them: your own (private), or the shared library.
 * The server marks each row rather than sending two lists, because everything
 * else about a row — its name, its note, how it sorts — is identical either way
 * and only the shelf differs.
 */
export function myWork(metas = []) {
  return metas.filter((m) => m && !m.shared);
}

export function sharedWork(metas = []) {
  return metas.filter((m) => m?.shared);
}

/**
 * The names already taken for one kind — what `uniqueName` needs.
 *
 * Callers pass **their own shelf**, not the whole list. Saving writes to your
 * shelf and nowhere else, so a name is only "taken" if you took it: dodging a
 * name because a colleague published one like it would have you saving
 * "OP10 (2)" while your own OP10 slot sat empty.
 */
export function namesOfKind(metas = [], kind) {
  return new Set(metas.filter((m) => m?.kind === kind).map((m) => m.name));
}

/** A size a person reads: 812 B, 41.2 kB, 3.4 MB. */
export function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/**
 * When it was saved, as a control would put it: the date and the time to the
 * minute, in the machine's own locale. Seconds are noise on a save list.
 */
export function formatSavedAt(iso, now = new Date()) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString()} ${time}`;
}
