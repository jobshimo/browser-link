import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeInstaller } from './claude.js';
import { copilotInstaller } from './copilot.js';
import { opencodeInstaller } from './opencode.js';
import {
  editMcpConfig,
  jsonEditor,
  type EditPlan,
  type JsonEditor,
  type McpConfigFile,
} from './json-config.js';
import type { TextEdit } from './json-edit.js';
import { firstInvalidUtf8Offset } from './safe-file.js';
import type { Installer } from './types.js';

/**
 * D16 for the MCP config installers: read and validate before touching,
 * refuse and change nothing on a file that cannot be parsed, is not valid
 * UTF-8 or has the wrong shape; atomic write; every byte that is not ours is
 * kept; the same symlink guard as the instruction installers; no backup copy.
 */

let fakeHome: string;
const savedEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  COPILOT_HOME: process.env.COPILOT_HOME,
};

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'browser-link-safe-'));
  if (process.platform === 'win32') process.env.USERPROFILE = fakeHome;
  else process.env.HOME = fakeHome;
  delete process.env.COPILOT_HOME;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(fakeHome, { recursive: true, force: true });
});

interface Case {
  installer: Installer;
  label: string;
  file: () => string;
  /** The top-level key holding the MCP servers map. */
  container: 'mcpServers' | 'mcp';
}

const CASES: Case[] = [
  {
    installer: claudeInstaller,
    label: 'Claude',
    file: () => join(fakeHome, '.claude.json'),
    container: 'mcpServers',
  },
  {
    installer: opencodeInstaller,
    label: 'OpenCode',
    file: () => join(fakeHome, '.config', 'opencode', 'opencode.json'),
    container: 'mcp',
  },
  {
    installer: copilotInstaller,
    label: 'Copilot',
    file: () => join(fakeHome, '.copilot', 'mcp-config.json'),
    container: 'mcpServers',
  },
];

function put(path: string, bytes: string | Buffer): Buffer {
  mkdirSync(dirname(path), { recursive: true });
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  writeFileSync(path, buf);
  return buf;
}

function canSymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

describe.each(CASES)('$label MCP config: refuse and change nothing', (c) => {
  test('a file that is not valid UTF-8 is refused by install, uninstall and detect', () => {
    // "caf" + 0xE9 (Latin-1 é) inside a JSON string: JSON.parse accepts the
    // U+FFFD it decodes to, so only a strict UTF-8 read can catch it.
    const original = put(
      c.file(),
      Buffer.concat([
        Buffer.from(`{"note":"caf`, 'utf8'),
        Buffer.from([0xe9]),
        Buffer.from(`","${c.container}":{"browser-link":{}}}\n`, 'utf8'),
      ]),
    );
    const offset = 12; // index of the 0xE9 byte
    expect(() => c.installer.install('browser-link', [])).toThrow(
      `${c.file()} is not valid UTF-8 (byte 0xE9 at offset ${offset})`,
    );
    expect(() => c.installer.uninstall()).toThrow('is not valid UTF-8');
    expect(() => c.installer.detect()).toThrow('is not valid UTF-8');
    expect(readFileSync(c.file()).equals(original)).toBe(true);
    expect(readdirSync(dirname(c.file()))).toEqual([c.file().split(/[\\/]/).pop()]);
  });

  test.each([
    ['null', 'the top level is null, not an object'],
    ['42', 'the top level is a number, not an object'],
    ['"text"', 'the top level is a string, not an object'],
    ['[]', 'the top level is an array, not an object'],
  ])('valid JSON %s at the top level is refused with what was found', (json, found) => {
    const original = put(c.file(), `${json}\n`);
    expect(() => c.installer.install('browser-link', [])).toThrow(
      `${c.label === 'Copilot' ? 'Copilot' : c.label} config at ${c.file()} is not in the expected shape: ${found}.`,
    );
    expect(() => c.installer.uninstall()).toThrow(found);
    expect(() => c.installer.detect()).toThrow(found);
    expect(readFileSync(c.file()).equals(original)).toBe(true);
  });

  test('a servers map of the wrong type is refused with what was found', () => {
    const original = put(c.file(), `{"${c.container}": "nope"}\n`);
    expect(() => c.installer.install('browser-link', [])).toThrow(
      `"${c.container}" is a string, not an object`,
    );
    expect(() => c.installer.uninstall()).toThrow(`"${c.container}" is a string, not an object`);
    expect(readFileSync(c.file()).equals(original)).toBe(true);
  });

  test('a duplicated servers key is refused: the edit would be ambiguous', () => {
    const original = put(c.file(), `{"${c.container}": {}, "${c.container}": {}}\n`);
    expect(() => c.installer.install('browser-link', [])).toThrow(
      `"${c.container}" appears more than once`,
    );
    expect(readFileSync(c.file()).equals(original)).toBe(true);
  });

  test('a file that is not JSON is still refused and left unchanged (previous behaviour)', () => {
    const original = put(c.file(), '{ not json\n');
    expect(() => c.installer.install('browser-link', [])).toThrow(
      `Could not parse ${c.label} config at ${c.file()}`,
    );
    expect(() => c.installer.detect()).toThrow(`Could not parse ${c.label} config at ${c.file()}`);
    expect(readFileSync(c.file()).equals(original)).toBe(true);
  });
});

describe.each(CASES)('$label MCP config: what is not ours is kept byte for byte', (c) => {
  test('CRLF, 4-space indent, number spelling and key order survive install and uninstall', () => {
    // OpenCode's install also adds `$schema` when the file has none; the
    // file already has one here so the only change is browser-link's entry.
    const schema =
      c.container === 'mcp' ? `    "$schema": "https://opencode.ai/config.json",\r\n` : '';
    const others =
      `{\r\n` +
      schema +
      `    "big": 12345678901234567890,\r\n` +
      `    "ratio": 1.0,\r\n` +
      `    "${c.container}": {\r\n` +
      `        "other": { "keep": "as-is" }\r\n` +
      `    },\r\n` +
      `    "z": "\\u00e9"\r\n` +
      `}\r\n`;
    put(c.file(), others);
    c.installer.install('cmd', ['a']);
    const after = readFileSync(c.file(), 'utf8');
    // Only the new member is added, in the file's own style.
    const head =
      `{\r\n${schema}    "big": 12345678901234567890,\r\n    "ratio": 1.0,\r\n    "${c.container}": {\r\n` +
      `        "other": { "keep": "as-is" },\r\n        "browser-link": `;
    const tail = `\r\n    },\r\n    "z": "\\u00e9"\r\n}\r\n`;
    expect(after.startsWith(head)).toBe(true);
    expect(after.endsWith(tail)).toBe(true);
    const inserted = after.slice(head.length, after.length - tail.length);
    expect(inserted).not.toMatch(/(?<!\r)\n/); // no lone LF
    expect(
      inserted
        .split('\r\n')
        .slice(1)
        .every((l) => l.startsWith('        ')),
    ).toBe(true);
    c.installer.uninstall();
    expect(readFileSync(c.file(), 'utf8')).toBe(others);
  });

  test('a single-line file stays on one line and keeps no trailing newline', () => {
    const schema = c.container === 'mcp' ? `"$schema":"https://opencode.ai/config.json",` : '';
    const original = `{${schema}"a":1,"${c.container}":{}}`;
    put(c.file(), original);
    c.installer.install('cmd', []);
    const after = readFileSync(c.file(), 'utf8');
    expect(after.startsWith(`{${schema}"a":1,"${c.container}":{"browser-link": {`)).toBe(true);
    expect(after).not.toContain('\n');
    c.installer.uninstall();
    expect(readFileSync(c.file(), 'utf8')).toBe(original);
  });
});

describe.each(CASES)('$label MCP config: atomic write, no backup, symlink guard', (c) => {
  test('the write replaces the file through a rename and leaves no temp or backup file', () => {
    put(c.file(), `{"${c.container}": {}}\n`);
    const before = statSync(c.file(), { bigint: true }).ino;
    c.installer.install('cmd', []);
    const after = statSync(c.file(), { bigint: true }).ino;
    expect(after).not.toBe(before);
    expect(readdirSync(dirname(c.file()))).toEqual([c.file().split(/[\\/]/).pop()]);
  });

  test('a symlinked config is refused and its target is left unchanged', () => {
    const real = join(fakeHome, 'real-config.json');
    const original = put(real, `{"${c.container}": {}}\n`);
    mkdirSync(dirname(c.file()), { recursive: true });
    if (!canSymlink(real, c.file())) {
      console.warn('skipping: symlink creation unavailable on this platform');
      return;
    }
    expect(() => c.installer.install('cmd', [])).toThrow(
      `${c.file()} is a symlink to ${real}. Refusing to write through it`,
    );
    expect(() => c.installer.uninstall()).toThrow('is a symlink');
    expect(readFileSync(real).equals(original)).toBe(true);
  });
});

describe('firstInvalidUtf8Offset (the strict read every installer uses)', () => {
  test.each([
    ['ASCII, accents, CJK and an emoji', Buffer.from('a é 日 😀', 'utf8'), -1],
    ['a UTF-8 BOM', Buffer.from([0xef, 0xbb, 0xbf, 0x61]), -1],
    ['a Latin-1 byte', Buffer.from([0x61, 0xe9, 0x62]), 1],
    ['an overlong encoding', Buffer.from([0x61, 0xc0, 0x80]), 1],
    ['an encoded surrogate', Buffer.from([0xed, 0xa0, 0x80]), 0],
    ['a code point above U+10FFFF', Buffer.from([0xf4, 0x90, 0x80, 0x80]), 0],
    ['a sequence cut at the end', Buffer.from([0x61, 0xe6, 0x97]), 1],
    ['a lone continuation byte', Buffer.from([0x80]), 0],
  ])('%s', (_label, buf, expected) => {
    expect(firstInvalidUtf8Offset(buf)).toBe(expected);
  });
});

describe('MCP config: every edit is checked before the write', () => {
  const ORIGINAL =
    '{\n  "ratio": 1.0,\n  "mcpServers": {\n    "other": { "keep": true },\n' +
    '    "browser-link": { "command": "old" }\n  },\n  "z": "\u00e9"\n}\n';
  const file = (): McpConfigFile => ({ path: join(fakeHome, '.claude.json'), label: 'Claude' });
  const setPlan = (): EditPlan => ({
    ops: [{ kind: 'set', path: ['mcpServers', 'browser-link'], value: { command: 'new' } }],
    message: 'set',
  });
  const removePlan = (): EditPlan => ({
    ops: [{ kind: 'remove', path: ['mcpServers', 'browser-link'] }],
    message: 'removed',
  });

  /** A real edit whose result is then damaged by `damage`, span unchanged. */
  const broken = (damage: (text: string) => string): JsonEditor => ({
    set: (text, path, value) => {
      const edit = jsonEditor.set(text, path, value);
      return { ...edit, text: damage(edit.text) };
    },
    remove: (text, path) => {
      const edit = jsonEditor.remove(text, path);
      return edit && { ...edit, text: damage(edit.text) };
    },
  });

  test.each([
    ['the result is not JSON', setPlan, broken((t) => t.replace('"z"', 'z'))],
    ['the result is another document', setPlan, broken((t) => t.replace('"new"', '"evil"'))],
    ['a byte outside the span changed', setPlan, broken((t) => t.replace('1.0', '1'))],
    [
      'a remove also took a neighbour',
      removePlan,
      broken((t) => t.replace('"other": { "keep": true }', '')),
    ],
    [
      'the span claims more than the member',
      removePlan,
      {
        ...jsonEditor,
        remove: (text: string): TextEdit => {
          const start = text.indexOf('"other"');
          const end = text.indexOf('}\n  },') + 1;
          const edited = text.slice(0, start) + text.slice(end).replace(/^,?\s*/, '');
          return { start, end, insert: '', text: edited };
        },
      } satisfies JsonEditor,
    ],
    [
      'a set rewrites neighbours inside a span it reports as its own',
      setPlan,
      {
        ...jsonEditor,
        set: (text: string, _path: string[], value: unknown): TextEdit => {
          // Same document, but "other" is reformatted inside the claimed span.
          const start = text.indexOf('{', text.indexOf('"mcpServers"'));
          const end = text.indexOf('}\n  },') + 4;
          const insert = JSON.stringify({ other: { keep: true }, 'browser-link': value });
          return { start, end, insert, text: text.slice(0, start) + insert + text.slice(end) };
        },
      } satisfies JsonEditor,
    ],
  ])('refuses and writes nothing when %s', (_label, plan, editor) => {
    put(file().path, ORIGINAL);
    expect(() => editMcpConfig(file(), () => null, plan, editor)).toThrow(
      `browser-link could not edit Claude config at ${file().path} safely (`,
    );
    expect(() => editMcpConfig(file(), () => null, plan, editor)).toThrow('Nothing was changed.');
    expect(readFileSync(file().path, 'utf8')).toBe(ORIGINAL);
    expect(readdirSync(fakeHome)).toEqual(['.claude.json']);
  });

  test('the real editor passes the check and changes only the entry (previous behaviour)', () => {
    put(file().path, ORIGINAL);
    expect(editMcpConfig(file(), () => null, setPlan)).toBe('set');
    expect(readFileSync(file().path, 'utf8')).toBe(
      ORIGINAL.replace('{ "command": "old" }', '{\n      "command": "new"\n    }'),
    );
    expect(editMcpConfig(file(), () => null, removePlan)).toBe('removed');
    expect(readFileSync(file().path, 'utf8')).toBe(
      ORIGINAL.replace(',\n    "browser-link": { "command": "old" }', ''),
    );
  });
});

describe('MCP config: a UTF-8 byte order mark', () => {
  test.each(CASES)(
    '$label: a file starting with a BOM is refused as unparseable, unchanged',
    (c) => {
      const original = put(c.file(), `\uFEFF{"${c.container}": {}}\n`);
      expect(() => c.installer.install('cmd', [])).toThrow(
        `Could not parse ${c.label} config at ${c.file()}`,
      );
      expect(() => c.installer.detect()).toThrow(`Could not parse ${c.label} config`);
      expect(readFileSync(c.file()).equals(original)).toBe(true);
    },
  );
});
