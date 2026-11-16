/**
 * Byte-preserving edits of a JSON document. The MCP config installers add,
 * replace or remove only their own member; every other byte of the user's
 * file (indentation, line ends, key order, number spelling, escapes) is
 * written back exactly as it was read. Parsing and re-serialising the whole
 * document would rewrite all of it.
 *
 * Every function here expects text that JSON.parse already accepted.
 */

export interface JsonMember {
  key: string;
  keyStart: number;
  valueStart: number;
  /** Index after the last character of the value. */
  valueEnd: number;
}

export interface JsonObjectSpan {
  /** Index of `{`. */
  start: number;
  /** Index after `}`. */
  end: number;
  members: JsonMember[];
}

/** Thrown when an object holds the same key more than once: JSON.parse keeps
 * the last one, so an edit of either could silently be the wrong one. */
export class DuplicateKeyError extends Error {
  constructor(public readonly key: string) {
    super(`"${key}" appears more than once in the same object`);
    this.name = 'DuplicateKeyError';
  }
}

const WS = new Set([' ', '\t', '\r', '\n']);

function skipWs(text: string, i: number): number {
  while (i < text.length && WS.has(text[i])) i++;
  return i;
}

function skipString(text: string, i: number): number {
  i++; // opening quote
  while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
  return i + 1;
}

function skipValue(text: string, i: number): number {
  const c = text[i];
  if (c === '"') return skipString(text, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    for (;;) {
      const ch = text[i];
      if (ch === '"') {
        i = skipString(text, i);
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
  }
  while (i < text.length && !WS.has(text[i]) && !',}]'.includes(text[i])) i++;
  return i;
}

/** The members of the object whose `{` is at `start`. */
export function readObject(text: string, start: number): JsonObjectSpan {
  const members: JsonMember[] = [];
  let i = skipWs(text, start + 1);
  if (text[i] === '}') return { start, end: i + 1, members };
  for (;;) {
    const keyStart = i;
    const keyEnd = skipString(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    const valueStart = skipWs(text, skipWs(text, keyEnd) + 1); // past ':'
    const valueEnd = skipValue(text, valueStart);
    members.push({ key, keyStart, valueStart, valueEnd });
    i = skipWs(text, valueEnd);
    if (text[i] === ',') {
      i = skipWs(text, i + 1);
      continue;
    }
    return { start, end: i + 1, members };
  }
}

/** The top-level object of the document. */
export function rootObject(text: string): JsonObjectSpan {
  return readObject(text, skipWs(text, 0));
}

/** The one member named `key`, or undefined. Throws DuplicateKeyError when
 * the key is there more than once. */
export function findMember(obj: JsonObjectSpan, key: string): JsonMember | undefined {
  const found = obj.members.filter((m) => m.key === key);
  if (found.length > 1) throw new DuplicateKeyError(key);
  return found[0];
}

/** Leading whitespace of the line holding `index`. */
function lineIndent(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  let end = lineStart;
  while (text[end] === ' ' || text[end] === '\t') end++;
  return text.slice(lineStart, end);
}

interface Style {
  eol: string;
  /** One indentation level, as the file writes it. */
  unit: string;
  multiline: boolean;
}

/** The file's own style: its line end, its indentation unit (taken from the
 * first member of the top-level object) and whether it spans several lines. */
export function detectStyle(text: string): Style {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  const eol = crlf > 0 && crlf >= lf - crlf ? '\r\n' : '\n';
  const root = rootObject(text);
  const first = root.members.at(0);
  const firstIndent = first ? lineIndent(text, first.keyStart) : '';
  const onOwnLine = first ? text.slice(root.start + 1, first.keyStart).includes('\n') : false;
  return { eol, unit: onOwnLine && firstIndent.length > 0 ? firstIndent : '  ', multiline: lf > 0 };
}

/** `value` serialised in the file's style, its continuation lines indented
 * by `indent` (the indentation of the line the member starts on). */
function render(value: unknown, style: Style, indent: string): string {
  if (!style.multiline) return JSON.stringify(value);
  return JSON.stringify(value, null, style.unit)
    .split('\n')
    .join(style.eol + indent);
}

/** One replacement in the original text: `text` is the whole new document,
 * equal to `original.slice(0, start) + insert + original.slice(end)`. The
 * span lets a caller check that no byte outside it changed. */
export interface TextEdit {
  start: number;
  end: number;
  insert: string;
  text: string;
}

function replace(original: string, start: number, end: number, insert: string): TextEdit {
  return {
    start,
    end,
    insert,
    text: original.slice(0, start) + insert + original.slice(end),
  };
}

/** Set `key` in `obj` to `value`: replace the value when the member exists,
 * otherwise add the member at the end of the object. */
export function setMember(
  text: string,
  obj: JsonObjectSpan,
  key: string,
  value: unknown,
): TextEdit {
  const style = detectStyle(text);
  const existing = findMember(obj, key);
  if (existing) {
    const indent = lineIndent(text, existing.keyStart);
    return replace(text, existing.valueStart, existing.valueEnd, render(value, style, indent));
  }
  const last = obj.members.at(-1);
  const first = obj.members.at(0);
  if (last && first) {
    const ownLines = text.slice(obj.start + 1, first.keyStart).includes('\n');
    const indent = ownLines ? lineIndent(text, first.keyStart) : '';
    const sep = ownLines ? style.eol + indent : ' ';
    const member = `${JSON.stringify(key)}: ${render(value, style, indent)}`;
    return replace(text, last.valueEnd, last.valueEnd, `,${sep}${member}`);
  }
  // Empty object: everything between the braces is whitespace and is replaced.
  const open = obj.start + 1;
  const close = obj.end - 1;
  if (!style.multiline) {
    return replace(text, open, close, `${JSON.stringify(key)}: ${render(value, style, '')}`);
  }
  const closeIndent = lineIndent(text, obj.start);
  const indent = closeIndent + style.unit;
  const member = `${JSON.stringify(key)}: ${render(value, style, indent)}`;
  return replace(text, open, close, `${style.eol}${indent}${member}${style.eol}${closeIndent}`);
}

/** Remove the member `key` from `obj` with the separator that joined it to
 * its neighbours. Returns null when the member is absent. */
export function removeMember(text: string, obj: JsonObjectSpan, key: string): TextEdit | null {
  const member = findMember(obj, key);
  if (!member) return null;
  const index = obj.members.indexOf(member);
  if (obj.members.length === 1) return replace(text, obj.start + 1, obj.end - 1, '');
  if (index > 0) {
    const prev = obj.members[index - 1];
    return replace(text, prev.valueEnd, member.valueEnd, '');
  }
  const next = obj.members[1];
  return replace(text, member.keyStart, next.keyStart, '');
}

/** Walk `keys` from the top-level object. Returns the deepest existing object
 * and the keys still missing below it. */
function walk(text: string, keys: string[]): { obj: JsonObjectSpan; missing: string[] } {
  let obj = rootObject(text);
  for (let i = 0; i < keys.length; i++) {
    const member = findMember(obj, keys[i]);
    if (!member) return { obj, missing: keys.slice(i) };
    obj = readObject(text, member.valueStart);
  }
  return { obj, missing: [] };
}

/** Set the value at `path` (objects missing on the way are created). */
export function setIn(text: string, path: string[], value: unknown): TextEdit {
  const { obj, missing } = walk(text, path.slice(0, -1));
  const [first, ...rest] = [...missing, path[path.length - 1]];
  const nested = rest.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value);
  return setMember(text, obj, first, nested);
}

/** Remove the member at `path`; null when it is absent. */
export function removeIn(text: string, path: string[]): TextEdit | null {
  const { obj, missing } = walk(text, path.slice(0, -1));
  if (missing.length > 0) return null;
  return removeMember(text, obj, path[path.length - 1]);
}
