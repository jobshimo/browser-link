import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opencodeInstructionsInstaller } from './opencode.js';

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'browser-link-opencode-instr-'));
  if (process.platform === 'win32') process.env.USERPROFILE = fakeHome;
  else process.env.HOME = fakeHome;
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

const expectedPath = (): string => join(fakeHome, '.config', 'opencode', 'AGENTS.md');

describe('opencodeInstructionsInstaller', () => {
  test('filePath() points at ~/.config/opencode/AGENTS.md on every OS', () => {
    expect(opencodeInstructionsInstaller.filePath()).toBe(expectedPath());
  });

  test('detect → no-file by default', () => {
    expect(opencodeInstructionsInstaller.detect().state.kind).toBe('no-file');
  });

  test('install creates the file under ~/.config/opencode/ and detect flips to installed', () => {
    opencodeInstructionsInstaller.install();
    expect(existsSync(expectedPath())).toBe(true);
    expect(opencodeInstructionsInstaller.detect().state.kind).toBe('installed');
  });

  test('install is idempotent — calling it twice keeps a single block', () => {
    opencodeInstructionsInstaller.install();
    opencodeInstructionsInstaller.install();
    const text = readFileSync(expectedPath(), 'utf8');
    const begins = text.match(/browser-link:instructions:begin/g) ?? [];
    expect(begins).toHaveLength(1);
  });

  test('uninstall removes the block', () => {
    opencodeInstructionsInstaller.install();
    opencodeInstructionsInstaller.uninstall();
    const text = existsSync(expectedPath()) ? readFileSync(expectedPath(), 'utf8') : '';
    expect(text).not.toMatch(/browser-link:instructions:begin/);
  });
});
