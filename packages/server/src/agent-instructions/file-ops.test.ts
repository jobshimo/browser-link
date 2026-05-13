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
import { BEGIN_PREFIX, END_MARKER, beginMarker } from './content.js';
import { CorruptBlockError, OutsideHomeError, SymlinkRefusedError } from './errors.js';
import { detectAt, installAt, uninstallAt } from './file-ops.js';

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

  test('collapses the multi-blank gap left behind into a single blank', () => {
    const initial = `Before.\n\n${beginMarker()}\nbody\n${END_MARKER}\n\nAfter.\n`;
    writeFileSync(file, initial, 'utf8');
    uninstallAt(file, 'Test Client');
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/\n\n\n/);
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
