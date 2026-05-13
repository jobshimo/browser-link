import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copilotInstructionsInstaller } from './copilot.js';

let fakeHome: string;
let originalCopilotHome: string | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'browser-link-copilot-instr-'));
  if (process.platform === 'win32') process.env.USERPROFILE = fakeHome;
  else process.env.HOME = fakeHome;
  originalCopilotHome = process.env.COPILOT_HOME;
  delete process.env.COPILOT_HOME;
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = originalCopilotHome;
});

const expectedPath = (): string => join(fakeHome, '.copilot', 'AGENTS.md');

describe('copilotInstructionsInstaller', () => {
  test('filePath() points at ~/.copilot/AGENTS.md by default', () => {
    expect(copilotInstructionsInstaller.filePath()).toBe(expectedPath());
  });

  test('COPILOT_HOME overrides the directory', () => {
    const custom = mkdtempSync(join(tmpdir(), 'browser-link-copilot-home-'));
    process.env.COPILOT_HOME = custom;
    try {
      expect(copilotInstructionsInstaller.filePath()).toBe(join(custom, 'AGENTS.md'));
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
  });

  test('install creates the file', () => {
    copilotInstructionsInstaller.install();
    expect(existsSync(expectedPath())).toBe(true);
    expect(copilotInstructionsInstaller.detect().state.kind).toBe('installed');
  });

  test('install preserves the user content of an existing AGENTS.md', () => {
    mkdirSync(join(fakeHome, '.copilot'), { recursive: true });
    writeFileSync(expectedPath(), '# My agents file\n\nUser rules.\n', 'utf8');
    copilotInstructionsInstaller.install();
    const text = readFileSync(expectedPath(), 'utf8');
    expect(text).toContain('# My agents file');
    expect(text).toContain('User rules.');
  });

  test('uninstall on a file with only our block leaves a trimmed file', () => {
    copilotInstructionsInstaller.install();
    copilotInstructionsInstaller.uninstall();
    const text = readFileSync(expectedPath(), 'utf8');
    expect(text).not.toMatch(/browser-link:instructions:begin/);
  });
});
