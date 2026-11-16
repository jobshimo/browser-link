import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../version.js';
import { BEGIN_PREFIX, END_MARKER, beginMarker, block } from './content.js';
import {
  CorruptBlockError,
  InvalidUtf8Error,
  OutsideHomeError,
  SymlinkRefusedError,
} from './errors.js';
import { detectAt, installAt, uninstallAt } from './file-ops.js';
import { renderCore } from '../manual/core.js';
import { renderTrigger } from '../manual/render.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'browser-link-instr-'));
  file = join(dir, 'AGENTS.md');
  // Anchor $HOME inside `dir` so the outside-$HOME guard treats the test
  // file as inside the user home. The guard reads homedir() on every call,
  // which reads HOME (POSIX) / USERPROFILE (Windows) live.
  if (process.platform === 'win32') process.env.USERPROFILE = dir;
  else process.env.HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('detectAt', () => {
  test('no-file when the target does not exist', () => {
    const d = detectAt(file);
    expect(d.state.kind).toBe('no-file');
    expect(d.filePath).toBe(file);
  });

  test('not-installed when the file exists with no marker block', () => {
    writeFileSync(file, '# My instructions\n\nUnrelated content.\n', 'utf8');
    const d = detectAt(file);
    expect(d.state.kind).toBe('not-installed');
  });

  test('installed (current version) when our block is in there', () => {
    writeFileSync(file, `Preamble.\n\n${beginMarker()}\nbody\n${END_MARKER}\n`, 'utf8');
    const d = detectAt(file);
    expect(d.state.kind).toBe('installed');
    if (d.state.kind === 'installed') expect(d.state.version).toBe(VERSION);
  });

  test('installed-outdated when the block carries an older semver', () => {
    writeFileSync(file, `${beginMarker('0.0.1')}\nbody\n${END_MARKER}\n`, 'utf8');
    const d = detectAt(file);
    expect(d.state.kind).toBe('installed-outdated');
    if (d.state.kind === 'installed-outdated') expect(d.state.version).toBe('0.0.1');
  });

  test('installed-outdated when the block has no version (legacy)', () => {
    // Legacy markers without a version still match the begin regex.
    writeFileSync(file, `${BEGIN_PREFIX} -->\nbody\n${END_MARKER}\n`, 'utf8');
    const d = detectAt(file);
    expect(d.state.kind).toBe('installed-outdated');
    if (d.state.kind === 'installed-outdated') expect(d.state.version).toBeNull();
  });

  test('corrupt when the file contains two BEGIN markers', () => {
    const text = [
      `${beginMarker('0.0.1')}\nbody1\n${END_MARKER}`,
      `${beginMarker()}\nbody2\n${END_MARKER}`,
    ].join('\n\n');
    writeFileSync(file, text, 'utf8');
    const d = detectAt(file);
    expect(d.state.kind).toBe('corrupt');
    if (d.state.kind === 'corrupt') expect(d.state.reason).toBe('multiple-begin-markers');
  });
});

describe('installAt', () => {
  test('creates the file (and parent dirs) when nothing exists', () => {
    const nested = join(dir, 'deep', 'nest', 'AGENTS.md');
    installAt(nested, 'Test Client');
    expect(existsSync(nested)).toBe(true);
    const text = readFileSync(nested, 'utf8');
    expect(text).toContain(beginMarker());
    expect(text).toContain(END_MARKER);
  });

  test('appends the block to an existing file with no marker', () => {
    writeFileSync(file, '# Existing\n\nUser content.\n', 'utf8');
    installAt(file, 'Test Client');
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('# Existing\n\nUser content.\n')).toBe(true);
    expect(text).toContain(beginMarker());
  });

  test('refreshes the block in place when one is already present', () => {
    const initial = [
      'Preamble.',
      '',
      `${beginMarker('0.0.1')}`,
      'stale body',
      END_MARKER,
      '',
      'Trailing user content.',
      '',
    ].join('\n');
    writeFileSync(file, initial, 'utf8');
    installAt(file, 'Test Client');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('Preamble.');
    expect(text).toContain('Trailing user content.');
    expect(text).toContain(beginMarker());
    expect(text).not.toContain('stale body');
    // No duplication of the marker.
    const begins = text.match(new RegExp(BEGIN_PREFIX, 'g')) ?? [];
    expect(begins).toHaveLength(1);
  });

  test('keeps user content surrounding an existing block intact', () => {
    const initial = `Before.\n${beginMarker('0.0.1')}\nold\n${END_MARKER}\nAfter.\n`;
    writeFileSync(file, initial, 'utf8');
    installAt(file, 'Test Client');
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('Before.\n')).toBe(true);
    expect(text.endsWith('After.\n')).toBe(true);
  });
});

describe('uninstallAt', () => {
  test('no-op when the file does not exist', () => {
    expect(() => uninstallAt(file, 'Test Client')).not.toThrow();
    expect(existsSync(file)).toBe(false);
  });

  test('no-op when the file exists but has no block', () => {
    writeFileSync(file, '# Just my notes.\n', 'utf8');
    uninstallAt(file, 'Test Client');
    expect(readFileSync(file, 'utf8')).toBe('# Just my notes.\n');
  });

  test('removes the block and preserves the rest', () => {
    const initial = [
      'Before line.',
      '',
      beginMarker(),
      'body',
      END_MARKER,
      '',
      'After line.',
      '',
    ].join('\n');
    writeFileSync(file, initial, 'utf8');
    uninstallAt(file, 'Test Client');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('Before line.');
    expect(text).toContain('After line.');
    expect(text).not.toContain(BEGIN_PREFIX);
    expect(text).not.toContain(END_MARKER);
    expect(text).not.toContain('body');
  });

  test('leaves the blank lines around a block in the middle as the user had them', () => {
    // D16: the old collapse of every 3+ line-end run is gone; only our span goes.
    const initial = `Before.\n\n${beginMarker()}\nbody\n${END_MARKER}\n\nAfter.\n`;
    writeFileSync(file, initial, 'utf8');
    uninstallAt(file, 'Test Client');
    expect(readFileSync(file, 'utf8')).toBe('Before.\n\n\nAfter.\n');
  });
});

describe('atomic write', () => {
  test('cleans up the temp file when the rename step fails', () => {
    // Force rename to fail naturally: create a directory where the file
    // should land. renameSync(file, dir) throws EISDIR / EPERM and the
    // helper must clean up the .tmp it had already written.
    const target = join(dir, 'AGENTS.md');
    mkdirSync(target);
    // Drop a stale child so the directory cannot be replaced atomically
    // even on platforms where Node would otherwise allow it.
    writeFileSync(join(target, 'inside.txt'), 'placeholder', 'utf8');
    expect(() => installAt(target, 'Test Client')).toThrow();
    const entries = readdirSync(dir).filter((e) => e.endsWith('.tmp'));
    expect(entries).toEqual([]);
  });
});

describe('symlink handling', () => {
  // Creating a symlink on Windows requires elevation or developer mode; the
  // try/catch around symlinkSync lets us skip cleanly when that fails.
  const target = (): string => join(dir, 'real-target.md');
  const link = (): string => join(dir, 'link.md');

  function trySymlink(): boolean {
    try {
      writeFileSync(target(), '# real target\n', 'utf8');
      symlinkSync(target(), link());
      return true;
    } catch {
      return false;
    }
  }

  test('installAt throws SymlinkRefusedError with target + paste-ready block', () => {
    if (!trySymlink()) {
      console.warn('skipping: symlink creation unavailable on this platform');
      return;
    }
    let caught: unknown;
    try {
      installAt(link(), 'Test Client');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SymlinkRefusedError);
    if (caught instanceof SymlinkRefusedError) {
      // realpathSync may normalize path casing/separators; only assert the
      // basename to keep the test portable.
      expect(caught.target).toContain('real-target.md');
      expect(caught.blockContent).toContain(BEGIN_PREFIX);
      expect(caught.blockContent).toContain(END_MARKER);
    }
    // The real target was not overwritten.
    expect(readFileSync(target(), 'utf8')).toBe('# real target\n');
  });

  test('uninstallAt throws SymlinkRefusedError too', () => {
    if (!trySymlink()) {
      console.warn('skipping: symlink creation unavailable on this platform');
      return;
    }
    expect(() => uninstallAt(link(), 'Test Client')).toThrow(SymlinkRefusedError);
  });
});

describe('corrupt state', () => {
  test('installAt throws CorruptBlockError when two BEGIN markers exist', () => {
    const text = [
      `${beginMarker('0.0.1')}\nbody1\n${END_MARKER}`,
      `${beginMarker()}\nbody2\n${END_MARKER}`,
    ].join('\n\n');
    writeFileSync(file, text, 'utf8');
    expect(() => installAt(file, 'Test Client')).toThrow(CorruptBlockError);
  });

  test('uninstallAt throws CorruptBlockError when two BEGIN markers exist', () => {
    const text = [
      `${beginMarker('0.0.1')}\nbody1\n${END_MARKER}`,
      `${beginMarker()}\nbody2\n${END_MARKER}`,
    ].join('\n\n');
    writeFileSync(file, text, 'utf8');
    expect(() => uninstallAt(file, 'Test Client')).toThrow(CorruptBlockError);
  });
});

describe('EOL preservation', () => {
  test('CRLF file gets a CRLF block', () => {
    writeFileSync(file, '# Existing\r\n\r\nUser content.\r\n', 'utf8');
    installAt(file, 'Test Client');
    const text = readFileSync(file, 'utf8');
    // Locate the block and assert it contains CRLF and no lone LF inside.
    const begin = text.indexOf(BEGIN_PREFIX);
    const end = text.indexOf(END_MARKER, begin) + END_MARKER.length;
    expect(begin).toBeGreaterThanOrEqual(0);
    const blockText = text.slice(begin, end);
    expect(blockText).toContain('\r\n');
    // No lone LF inside the block region (every \n is preceded by \r).
    for (let i = 0; i < blockText.length; i++) {
      if (blockText.charCodeAt(i) === 0x0a) {
        expect(blockText.charCodeAt(i - 1)).toBe(0x0d);
      }
    }
  });

  test('LF file stays LF', () => {
    writeFileSync(file, '# Existing\n\nUser content.\n', 'utf8');
    installAt(file, 'Test Client');
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/\r/);
  });
});

describe('outside-$HOME guard', () => {
  // The top-level beforeEach anchors $HOME at `dir`. Re-point it to a
  // sibling temp dir for these tests so the target file (still under `dir`)
  // is no longer under home.
  let otherHome: string;

  beforeEach(() => {
    otherHome = mkdtempSync(join(tmpdir(), 'browser-link-other-home-'));
    if (process.platform === 'win32') process.env.USERPROFILE = otherHome;
    else process.env.HOME = otherHome;
  });

  afterEach(() => {
    rmSync(otherHome, { recursive: true, force: true });
  });

  test('installAt throws OutsideHomeError when the target sits outside $HOME', () => {
    expect(() => installAt(file, 'Test Client')).toThrow(OutsideHomeError);
  });

  test('uninstallAt throws OutsideHomeError when the target sits outside $HOME', () => {
    // Pre-create the file so uninstallAt reaches the guard before the
    // existsSync short-circuit could ever fire.
    writeFileSync(file, 'something\n', 'utf8');
    expect(() => uninstallAt(file, 'Test Client')).toThrow(OutsideHomeError);
  });

  test('allowOutsideHome:true bypasses the guard (env-var override case)', () => {
    expect(() => installAt(file, 'Test Client', { allowOutsideHome: true })).not.toThrow();
    expect(existsSync(file)).toBe(true);
  });

  test('error message names the resolved home so the user can diagnose it', () => {
    let caught: unknown;
    try {
      installAt(file, 'Test Client');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OutsideHomeError);
    if (caught instanceof OutsideHomeError) {
      expect(caught.message).toContain('COPILOT_HOME');
      expect(caught.filePath).toBe(file);
    }
  });
});

describe('installAt modes (trigger by default, --with-core keeps the core)', () => {
  test('a default install writes the trigger only and detects as mode trigger', () => {
    installAt(file, 'Test Client');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(renderTrigger());
    expect(text).not.toContain(renderCore({}));
    expect(detectAt(file).state).toEqual({ kind: 'installed', version: VERSION, mode: 'trigger' });
  });

  test('withCore writes the trigger and the core and detects as mode core', () => {
    installAt(file, 'Test Client', { withCore: true });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(`${renderTrigger()}\n\n${renderCore({})}`);
    expect(detectAt(file).state).toEqual({ kind: 'installed', version: VERSION, mode: 'core' });
  });

  test('an explicit install without withCore turns a core block back into the trigger', () => {
    writeFileSync(file, '# Mine\n', 'utf8');
    installAt(file, 'Test Client', { withCore: true });
    installAt(file, 'Test Client');
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('# Mine\n')).toBe(true);
    expect(text).not.toContain(renderCore({}));
    expect(detectAt(file).state).toEqual({ kind: 'installed', version: VERSION, mode: 'trigger' });
  });
});

describe('D16: refuse and change nothing, keep every byte that is not ours', () => {
  const bytesOf = (): Buffer => readFileSync(file);

  test('CRLF: refreshing a block three times adds no blank line', () => {
    const before = '# Mine\r\n\r\n';
    const after = '\r\nUser tail.\r\n';
    const stale = `${beginMarker('0.0.1')}\r\nold\r\n${END_MARKER}\r\n`;
    writeFileSync(file, before + stale + after, 'utf8');
    installAt(file, 'Test Client');
    installAt(file, 'Test Client');
    installAt(file, 'Test Client');
    expect(readFileSync(file, 'utf8')).toBe(before + block(VERSION, '\r\n') + after);
  });

  test('CRLF: uninstall keeps every byte around the block', () => {
    writeFileSync(file, `# Mine\r\n\r\n${block(VERSION, '\r\n')}\r\nUser tail.\r\n`, 'utf8');
    uninstallAt(file, 'Test Client');
    expect(readFileSync(file, 'utf8')).toBe('# Mine\r\n\r\n\r\nUser tail.\r\n');
  });

  test('a file that is not valid UTF-8 is refused by install and uninstall, unchanged', () => {
    const original = Buffer.concat([
      Buffer.from('caf', 'utf8'),
      Buffer.from([0xe9]),
      Buffer.from(`\n${block('0.0.1')}`, 'utf8'),
    ]);
    writeFileSync(file, original);
    expect(() => installAt(file, 'Test Client')).toThrow(
      `${file} is not valid UTF-8 (byte 0xE9 at offset 3)`,
    );
    expect(() => uninstallAt(file, 'Test Client')).toThrow(InvalidUtf8Error);
    expect(bytesOf().equals(original)).toBe(true);
    expect(detectAt(file).state).toEqual({ kind: 'corrupt', reason: 'invalid-utf8' });
  });

  test('valid UTF-8 with a BOM and accents is kept byte for byte (previous behaviour)', () => {
    const mine = '﻿# Café ñandú 日本\n';
    writeFileSync(file, mine, 'utf8');
    installAt(file, 'Test Client');
    expect(readFileSync(file, 'utf8')).toBe(`${mine}\n${block(VERSION)}`);
  });

  test('a begin marker with no end marker is refused by install and uninstall, unchanged', () => {
    const original = `# Mine\n\n${beginMarker('0.0.1')}\nhalf a block\n`;
    writeFileSync(file, original, 'utf8');
    let caught: unknown;
    try {
      installAt(file, 'Test Client');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CorruptBlockError);
    expect((caught as CorruptBlockError).reason).toBe('missing-end-marker');
    expect((caught as Error).message).toBe(
      `${file} has a browser-link begin marker on line 3 with no end marker after it. ` +
        'Refusing to touch it; nothing was changed. Add the end marker ' +
        `(${END_MARKER}) or remove the begin marker by hand.`,
    );
    expect(() => uninstallAt(file, 'Test Client')).toThrow('with no end marker after it');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(detectAt(file).state).toEqual({ kind: 'corrupt', reason: 'missing-end-marker' });
  });

  test('a block written by a pre-release version is recognised and refreshed in place', () => {
    writeFileSync(file, `# Mine\n\n${block('1.1.0-beta.1')}`, 'utf8');
    expect(detectAt(file).state).toMatchObject({ version: '1.1.0-beta.1' });
    installAt(file, 'Test Client');
    expect(readFileSync(file, 'utf8')).toBe(`# Mine\n\n${block(VERSION)}`);
    uninstallAt(file, 'Test Client');
    // The block was last in the file: the one line end before it goes too.
    expect(readFileSync(file, 'utf8')).toBe('# Mine\n');
  });
});

describe('D16: uninstall gives back every byte that is not ours', () => {
  // Rule: install appends after the user's text exactly one line end (none
  // into an empty file), then the block, which ends with its own line end.
  // Uninstall removes the block span and, only when the block is the last
  // thing in the file, that one line end before it. Nothing else changes.
  const LF_FILES = [
    'top\n\n\n\nmid\n\n\n\nbottom',
    'top\n\n\n\nmid\n\n\n\nbottom\n',
    'notes\n\n\n\n\n',
    'one line, no newline',
    '\n',
    '\n\n\n',
    '',
  ];
  const FILES = [...LF_FILES, ...LF_FILES.map((t) => t.replace(/\n/g, '\r\n'))];

  test.each(FILES.map((t) => [JSON.stringify(t), t]))(
    'uninstall(install(%s)) is the original',
    (_label, original) => {
      writeFileSync(file, original, 'utf8');
      installAt(file, 'Test Client');
      expect(detectAt(file).state.kind).toBe('installed');
      uninstallAt(file, 'Test Client');
      expect(readFileSync(file, 'utf8')).toBe(original);
    },
  );

  test('a block in the middle (old install, moved by hand) is cut out alone', () => {
    const before = 'top\n\n\n\n';
    const after = 'mid\n\n\n\nbottom';
    writeFileSync(file, `${before}${block('0.0.1')}${after}`, 'utf8');
    uninstallAt(file, 'Test Client');
    expect(readFileSync(file, 'utf8')).toBe(before + after);
  });

  test('a block the old code appended at the end loses only the line end before it', () => {
    writeFileSync(file, `user\r\n\r\n\r\n\r\n${block('0.0.1', '\r\n')}`, 'utf8');
    uninstallAt(file, 'Test Client');
    expect(readFileSync(file, 'utf8')).toBe('user\r\n\r\n\r\n');
  });

  test('a refresh keeps every byte around the block', () => {
    const original = 'a\n\n\n\nb';
    writeFileSync(file, original, 'utf8');
    installAt(file, 'Test Client');
    const once = readFileSync(file, 'utf8');
    installAt(file, 'Test Client');
    expect(readFileSync(file, 'utf8')).toBe(once);
    expect(once).toBe(`${original}\n${block(VERSION)}`);
  });
});

describe('install separator (one line end, none into an empty file)', () => {
  test.each([
    ['ends with a newline: one blank line, as before', 'x\n', `x\n\n${block(VERSION)}`],
    ['no final newline: the block starts on the next line', 'x', `x\n${block(VERSION)}`],
    ['ends with a blank line: kept, plus one line end', 'x\n\n', `x\n\n\n${block(VERSION)}`],
    ['empty file: the block alone', '', block(VERSION)],
  ])('%s', (_label, original, expected) => {
    writeFileSync(file, original, 'utf8');
    installAt(file, 'Test Client');
    expect(readFileSync(file, 'utf8')).toBe(expected);
  });
});
