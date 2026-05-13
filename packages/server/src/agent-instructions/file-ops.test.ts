import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../version.js';
import { BEGIN_PREFIX, END_MARKER, beginMarker } from './content.js';
import { detectAt, installAt, uninstallAt } from './file-ops.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'browser-link-instr-'));
  file = join(dir, 'AGENTS.md');
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

  test('installed-outdated when the block has no version (treated as 0.0.0)', () => {
    // Legacy markers without a version still match the begin regex.
    writeFileSync(file, `${BEGIN_PREFIX} -->\nbody\n${END_MARKER}\n`, 'utf8');
    const d = detectAt(file);
    expect(d.state.kind).toBe('installed-outdated');
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
