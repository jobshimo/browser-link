import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeInstructionsInstaller } from './claude.js';

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'browser-link-claude-instr-'));
  if (process.platform === 'win32') process.env.USERPROFILE = fakeHome;
  else process.env.HOME = fakeHome;
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

const expectedPath = (): string => join(fakeHome, '.claude', 'CLAUDE.md');

describe('claudeInstructionsInstaller', () => {
  test('filePath() points at ~/.claude/CLAUDE.md', () => {
    expect(claudeInstructionsInstaller.filePath()).toBe(expectedPath());
  });

  test('detect → no-file by default', () => {
    expect(claudeInstructionsInstaller.detect().state.kind).toBe('no-file');
  });

  test('install creates the file under ~/.claude/ and detect flips to installed', () => {
    claudeInstructionsInstaller.install();
    expect(existsSync(expectedPath())).toBe(true);
    expect(claudeInstructionsInstaller.detect().state.kind).toBe('installed');
  });

  test('install on an existing CLAUDE.md preserves the user content', () => {
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    writeFileSync(expectedPath(), '# My personal CLAUDE.md\n\nSome rules.\n', 'utf8');
    claudeInstructionsInstaller.install();
    const text = readFileSync(expectedPath(), 'utf8');
    expect(text).toContain('# My personal CLAUDE.md');
    expect(text).toContain('Some rules.');
  });

  test('uninstall removes the block and leaves user content intact', () => {
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    writeFileSync(expectedPath(), '# My personal CLAUDE.md\n\nSome rules.\n', 'utf8');
    claudeInstructionsInstaller.install();
    claudeInstructionsInstaller.uninstall();
    const text = readFileSync(expectedPath(), 'utf8');
    expect(text).toContain('# My personal CLAUDE.md');
    expect(text).toContain('Some rules.');
    expect(text).not.toMatch(/browser-link:instructions:begin/);
  });
});
