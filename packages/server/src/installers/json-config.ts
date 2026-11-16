import { DuplicateKeyError, removeIn, setIn, type TextEdit } from './json-edit.js';
import { assertWritable, atomicWrite, readUtf8Strict } from './safe-file.js';

/**
 * The read-validate-splice-write path shared by the three MCP config
 * installers. A file that is not valid UTF-8, cannot be parsed, has the
 * wrong shape or an ambiguous duplicate key is refused before anything is
 * written; an edit touches only browser-link's own member, and every edit is
 * checked (parses, is the intended document, no other byte changed) before
 * the atomic write.
 */

export interface McpConfigFile {
  path: string;
  /** Client name used in messages ("Claude", "OpenCode", "Copilot"). */
  label: string;
  /** The user redirected the path through a client env var. */
  allowOutsideHome?: boolean;
}

/** Returns a description of the first wrong-shaped field, or null. */
export type ShapeCheck = (data: Record<string, unknown>) => string | null;

export type JsonObject = Record<string, unknown>;

/** A client config the installer refuses to change. */
export class ClientConfigError extends Error {
  constructor(
    public readonly filePath: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClientConfigError';
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeJsonValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** `"projects" → "/a" → "mcpServers" is a string, not an object` when the
 * value at `keys` is present and not an object; null otherwise. */
export function expectObjectAt(value: unknown, keys: string[]): string | null {
  if (value === undefined || isJsonObject(value)) return null;
  return `${keys.map((k) => JSON.stringify(k)).join(' → ')} is ${describeJsonValue(value)}, not an object`;
}

export interface LoadedConfig {
  /** The file's text, or null when the file does not exist. */
  text: string | null;
  data: JsonObject;
}

/** Read and validate the config. Throws, without changing anything, when
 * the file is not valid UTF-8, is not JSON, or has the wrong shape. */
export function loadMcpConfig(file: McpConfigFile, shape: ShapeCheck): LoadedConfig {
  const text = readUtf8Strict(file.path);
  if (text === null) return { text: null, data: {} };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ClientConfigError(
      file.path,
      `Could not parse ${file.label} config at ${file.path} (${detail}). ` +
        'Nothing was changed; fix the file or delete it.',
    );
  }
  const problem = isJsonObject(data)
    ? shape(data)
    : `the top level is ${describeJsonValue(data)}, not an object`;
  if (problem !== null) {
    throw new ClientConfigError(
      file.path,
      `${file.label} config at ${file.path} is not in the expected shape: ${problem}. ` +
        'Nothing was changed; fix the file by hand.',
    );
  }
  return { text, data: data as JsonObject };
}

/** One change an installer asks for: set or remove the member at `path`. */
export type EditOp =
  { kind: 'set'; path: string[]; value: unknown } | { kind: 'remove'; path: string[] };

/** What an installer plans from the validated config. No ops: nothing is
 * written. */
export interface EditPlan {
  ops: EditOp[];
  message: string;
}

/** The text editor the write path uses; a parameter so a test can hand in a
 * broken one and prove the self-check stops it before the file. */
export interface JsonEditor {
  set(text: string, path: string[], value: unknown): TextEdit;
  remove(text: string, path: string[]): TextEdit | null;
}

export const jsonEditor: JsonEditor = { set: setIn, remove: removeIn };

/** Equal values with the same key order everywhere; -0 is not 0. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameJson(v, b[i]));
  }
  if (isJsonObject(a) || isJsonObject(b)) {
    if (!isJsonObject(a) || !isJsonObject(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameJson(a[k], b[k]));
  }
  return Object.is(a, b);
}

/** The value at `path`, or undefined when some step is missing. */
function valueAt(doc: unknown, path: string[]): unknown {
  let cur = doc;
  for (const key of path) {
    if (!isJsonObject(cur) || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** The document `op` is meant to produce from `doc` (a deep copy). */
function intendedAfter(doc: JsonObject, op: EditOp): JsonObject {
  const next = structuredClone(doc);
  let cur: JsonObject = next;
  for (const key of op.path.slice(0, -1)) {
    if (!isJsonObject(cur[key])) {
      if (op.kind === 'remove') return next;
      cur[key] = {};
    }
    cur = cur[key] as JsonObject;
  }
  const last = op.path[op.path.length - 1];
  if (op.kind === 'set') cur[last] = op.value;
  else Reflect.deleteProperty(cur, last);
  return next;
}

function parses(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Why `edit` is not exactly `op` applied to `text`, or null when it is:
 * (a) the result parses, (b) it parses to the intended document, (c) no byte
 * outside the edited span changed and the span held only what `op` replaces. */
function editProblem(
  text: string,
  edit: TextEdit,
  op: EditOp,
  before: JsonObject,
  intended: JsonObject,
): string | null {
  const after = parses(edit.text);
  if (!after.ok) return 'the edited text is not valid JSON';
  if (!sameJson(after.value, intended)) return 'the edited text is not the intended document';
  const { start, end, insert } = edit;
  if (!(start >= 0 && start <= end && end <= text.length)) return 'the edited span is out of range';
  if (edit.text !== text.slice(0, start) + insert + text.slice(end)) {
    return 'bytes outside the edited span changed';
  }
  const replaced = text.slice(start, end);
  const last = op.path[op.path.length - 1];
  const old = valueAt(before, op.path);
  if (op.kind === 'remove') {
    const member = parses(`{${replaced.replace(/^\s*,/, '').replace(/,\s*$/, '')}}`);
    if (!member.ok || !sameJson(member.value, { [last]: old })) {
      return 'the removed bytes are not only the browser-link member';
    }
  } else if (old === undefined) {
    if (!/^\s*$/.test(replaced)) return 'the insertion replaced bytes that were not whitespace';
  } else {
    const value = parses(replaced);
    if (!value.ok || !sameJson(value.value, old)) {
      return 'the replaced bytes are not only the old browser-link value';
    }
  }
  return null;
}

/** Apply `ops` to `text`, checking every edit before it is accepted. */
function applyChecked(
  file: McpConfigFile,
  text: string,
  data: JsonObject,
  ops: EditOp[],
  editor: JsonEditor,
): string {
  let current = text;
  let doc = data;
  for (const op of ops) {
    const edit =
      op.kind === 'set' ? editor.set(current, op.path, op.value) : editor.remove(current, op.path);
    const intended = intendedAfter(doc, op);
    const problem =
      edit === null
        ? sameJson(intended, doc)
          ? null
          : 'the member to remove was not found in the text'
        : editProblem(current, edit, op, doc, intended);
    if (problem !== null) {
      throw new ClientConfigError(
        file.path,
        `browser-link could not edit ${file.label} config at ${file.path} safely (${problem}). ` +
          'Nothing was changed.',
      );
    }
    if (edit !== null) current = edit.text;
    doc = intended;
  }
  return current;
}

/** Run the write side of an installer: guards, read and validate, plan,
 * edit with a self-check, then an atomic write when the text changed. A
 * refusal at any step leaves the file as it was. */
export function editMcpConfig(
  file: McpConfigFile,
  shape: ShapeCheck,
  plan: (loaded: LoadedConfig) => EditPlan,
  editor: JsonEditor = jsonEditor,
): string {
  assertWritable(file.path, { allowOutsideHome: file.allowOutsideHome });
  const loaded = loadMcpConfig(file, shape);
  const { ops, message } = plan(loaded);
  if (ops.length === 0) return message;
  let next: string;
  try {
    next = applyChecked(file, loaded.text ?? '{}\n', loaded.data, ops, editor);
  } catch (err) {
    if (!(err instanceof DuplicateKeyError)) throw err;
    throw new ClientConfigError(
      file.path,
      `${file.label} config at ${file.path} is ambiguous: ${err.message}. ` +
        'Nothing was changed; remove the duplicate by hand.',
    );
  }
  if (next !== loaded.text) atomicWrite(file.path, next);
  return message;
}
