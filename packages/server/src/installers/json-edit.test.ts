import { describe, expect, test } from 'vitest';
import { removeIn, setIn, type TextEdit } from './json-edit.js';

/**
 * Every edit must hold three properties:
 * (a) the new text is accepted by JSON.parse;
 * (b) it parses to exactly the intended document: the original data with only
 *     the target member set or removed, key order of everything included;
 * (c) every byte outside the edited span is the original byte, and the span
 *     held only what the edit was meant to replace.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Serialisation that keeps key order and tells -0 from 0. */
function ordered(value: unknown): string {
  if (Object.is(value, -0)) return '-0';
  if (Array.isArray(value)) return `[${value.map(ordered).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}:${ordered(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function at(doc: Json, path: string[]): Json | undefined {
  let cur: Json | undefined = doc;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function intendedSet(original: string, path: string[], value: Json): Json {
  const doc = JSON.parse(original) as Json;
  let cur = doc as { [key: string]: Json };
  for (const key of path.slice(0, -1)) {
    if (!(key in cur)) cur[key] = {};
    cur = cur[key] as { [key: string]: Json };
  }
  cur[path[path.length - 1]] = value;
  return doc;
}

function intendedRemove(original: string, path: string[]): Json {
  const doc = JSON.parse(original) as Json;
  const parent = at(doc, path.slice(0, -1)) as { [key: string]: Json };
  delete parent[path[path.length - 1]];
  return doc;
}

function assertBytesOutside(original: string, edit: TextEdit): void {
  expect(edit.text.slice(0, edit.start)).toBe(original.slice(0, edit.start));
  expect(edit.text.slice(edit.start + edit.insert.length)).toBe(original.slice(edit.end));
}

const VALUE: Json = { type: 'stdio', command: 'c', args: ['a', '{"}'] };

interface Case {
  name: string;
  text: string;
  /** Path of a member that exists. */
  target: string[];
}

const CASES: Case[] = [
  {
    name: 'tab indentation',
    text: '{\n\t"a": 1,\n\t"s": {\n\t\t"t": 2\n\t}\n}\n',
    target: ['s', 't'],
  },
  {
    name: '4 spaces',
    text: '{\n    "a": 1,\n    "s": {\n        "t": 2\n    }\n}\n',
    target: ['s', 't'],
  },
  { name: 'single line', text: '{"a":1,"s":{"t":2,"u":3}}', target: ['s', 't'] },
  {
    name: 'CRLF',
    text: '{\r\n  "a": 1,\r\n  "s": {\r\n    "t": 2\r\n  }\r\n}\r\n',
    target: ['s', 't'],
  },
  { name: 'no trailing newline', text: '{\n  "s": {\n    "t": 2\n  }\n}', target: ['s', 't'] },
  {
    name: 'keys and strings with { } [ ] , : " and \\ escapes',
    text:
      '{\n  "k{}[],:\\"\\\\": "v{}[],:\\"\\\\",\n  "s": {\n    "a\\"b": "]}\\\\",\n' +
      '    "t": "x,\\"y\\""\n  },\n  "z": "\\\\\\""\n}\n',
    target: ['s', 't'],
  },
  {
    name: 'nested object and array as sibling values',
    text: '{\n  "s": {\n    "o": {"x": [1, {"y": "}"}]},\n    "t": [1, [2, {"z": "]"}]],\n    "w": {}\n  }\n}\n',
    target: ['s', 't'],
  },
  {
    name: 'target as first member',
    text: '{\n  "s": {\n    "t": 1,\n    "b": 2,\n    "c": 3\n  }\n}\n',
    target: ['s', 't'],
  },
  {
    name: 'target as middle member',
    text: '{\n  "s": {\n    "a": 1,\n    "t": 2,\n    "c": 3\n  }\n}\n',
    target: ['s', 't'],
  },
  {
    name: 'target as last member',
    text: '{\n  "s": {\n    "a": 1,\n    "b": 2,\n    "t": 3\n  }\n}\n',
    target: ['s', 't'],
  },
  { name: 'target as only member', text: '{\n  "s": {\n    "t": 1\n  }\n}\n', target: ['s', 't'] },
  {
    name: 'numbers 1e5, -0, 1.0',
    text: '{\n  "n": [1e5, -0, 1.0],\n  "s": {\n    "e": 1E+5,\n    "t": -0,\n    "f": 1.0\n  }\n}\n',
    target: ['s', 't'],
  },
  {
    name: 'deep nesting',
    text: '{"a":{"b":{"c":{"d":{"e":{"t":[[[{"x":1}]]],"f":{"g":{}}}}}}}}\n',
    target: ['a', 'b', 'c', 'd', 'e', 't'],
  },
];

describe.each(CASES)('json-edit: $name', ({ text, target }) => {
  const parent = target.slice(0, -1);

  test('set-new: adds a member the object did not have', () => {
    const path = [...parent, 'browser-link'];
    const edit = setIn(text, path, VALUE);
    expect(() => JSON.parse(edit.text) as unknown).not.toThrow();
    expect(ordered(JSON.parse(edit.text))).toBe(ordered(intendedSet(text, path, VALUE)));
    assertBytesOutside(text, edit);
    expect(text.slice(edit.start, edit.end)).toMatch(/^\s*$/);
  });

  test('set-existing: replaces only the value of the member', () => {
    const edit = setIn(text, target, VALUE);
    expect(() => JSON.parse(edit.text) as unknown).not.toThrow();
    expect(ordered(JSON.parse(edit.text))).toBe(ordered(intendedSet(text, target, VALUE)));
    assertBytesOutside(text, edit);
    const old = at(JSON.parse(text) as Json, target);
    expect(ordered(JSON.parse(text.slice(edit.start, edit.end)))).toBe(ordered(old));
  });

  test('remove: takes out the member and its separator only', () => {
    const edit = removeIn(text, target);
    expect(edit).not.toBeNull();
    if (!edit) return;
    expect(() => JSON.parse(edit.text) as unknown).not.toThrow();
    expect(ordered(JSON.parse(edit.text))).toBe(ordered(intendedRemove(text, target)));
    assertBytesOutside(text, edit);
    expect(edit.insert).toBe('');
  });
});

describe('json-edit: empty objects', () => {
  test.each([
    ['{}', '{"s":{}}'],
    ['{ }', '{"s":{ }}'],
    ['{\\n}', '{\n  "s": {\n}\n}\n'],
  ])('set-new into %s', (_label, text) => {
    const path = ['s', 'browser-link'];
    const edit = setIn(text, path, VALUE);
    expect(ordered(JSON.parse(edit.text))).toBe(ordered(intendedSet(text, path, VALUE)));
    assertBytesOutside(text, edit);
    expect(text.slice(edit.start, edit.end)).toMatch(/^\s*$/);
  });

  test('set-new creates a missing container at the top level', () => {
    const text = '{\n  "a": 1\n}\n';
    const path = ['mcpServers', 'browser-link'];
    const edit = setIn(text, path, VALUE);
    expect(ordered(JSON.parse(edit.text))).toBe(ordered(intendedSet(text, path, VALUE)));
    assertBytesOutside(text, edit);
  });

  test('remove of an absent member is null (nothing to write)', () => {
    expect(removeIn('{"s":{}}', ['s', 'browser-link'])).toBeNull();
    expect(removeIn('{}', ['s', 'browser-link'])).toBeNull();
  });
});
