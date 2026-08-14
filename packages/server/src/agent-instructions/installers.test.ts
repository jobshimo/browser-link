import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INSTRUCTIONS_INSTALLERS,
  claudeInstructionsInstaller,
  copilotInstructionsInstaller,
  opencodeInstructionsInstaller,
  type ClientId,
  type InstructionsInstaller,
} from './index.js';

/**
 * Parameterized suite for the three agent-instruction installers. Used to
 * live as three near-identical files (one per client); collapsed because
 * every client routes through the same factory + file-ops helpers, and
 * each pasted copy was one more place to forget to update. Per-client
 * special cases (currently just `COPILOT_HOME`) live in their own
 * `describe` block at the bottom.
 */

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'browser-link-instr-'));
  if (process.platform === 'win32') process.env.USERPROFILE = fakeHome;
  else process.env.HOME = fakeHome;
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

interface InstallerCase {
  installer: InstructionsInstaller;
  id: ClientId;
  expectedRelative: string[];
  displayName: string;
}

const CASES: InstallerCase[] = [
  {
    installer: claudeInstructionsInstaller,
    id: 'claude',
    expectedRelative: ['.claude', 'CLAUDE.md'],
    displayName: 'Claude Code',
  },
  {
    installer: opencodeInstructionsInstaller,
    id: 'opencode',
    expectedRelative: ['.config', 'opencode', 'AGENTS.md'],
    displayName: 'OpenCode',
  },
  {
    installer: copilotInstructionsInstaller,
    id: 'copilot',
    expectedRelative: ['.copilot', 'AGENTS.md'],
    displayName: 'GitHub Copilot CLI',
  },
];

describe('INSTRUCTIONS_INSTALLERS registry', () => {
  test('exposes the three expected ids in a stable order', () => {
    expect(INSTRUCTIONS_INSTALLERS.map((i) => i.id)).toEqual(['claude', 'opencode', 'copilot']);
  });

  test('each entry has the InstructionsInstaller shape', () => {
    for (const i of INSTRUCTIONS_INSTALLERS) {
      expect(typeof i.id).toBe('string');
      expect(typeof i.displayName).toBe('string');
      expect(typeof i.filePath).toBe('function');
      expect(typeof i.detect).toBe('function');
      expect(typeof i.install).toBe('function');
      expect(typeof i.uninstall).toBe('function');
    }
  });
});

describe.each(CASES)('$id installer', ({ installer, expectedRelative, displayName }) => {
  const expectedPath = (): string => join(fakeHome, ...expectedRelative);

  test('id and displayName line up with the case fixture', () => {
    expect(installer.displayName).toBe(displayName);
  });

  test('filePath() resolves under the fake home', () => {
    expect(installer.filePath()).toBe(expectedPath());
  });

  test('detect → no-file by default', () => {
    expect(installer.detect().state.kind).toBe('no-file');
  });

  test('install creates the file and detect flips to installed', () => {
    installer.install();
    expect(existsSync(expectedPath())).toBe(true);
    expect(installer.detect().state.kind).toBe('installed');
  });

  test('install is idempotent — calling it twice keeps a single block', () => {
    installer.install();
    installer.install();
    const text = readFileSync(expectedPath(), 'utf8');
    const begins = text.match(/browser-link:instructions:begin/g) ?? [];
    expect(begins).toHaveLength(1);
  });

  test('install preserves pre-existing user content', () => {
    mkdirSync(join(fakeHome, ...expectedRelative.slice(0, -1)), { recursive: true });
    writeFileSync(expectedPath(), '# My personal file\n\nSome rules.\n', 'utf8');
    installer.install();
    const text = readFileSync(expectedPath(), 'utf8');
    expect(text).toContain('# My personal file');
    expect(text).toContain('Some rules.');
  });

  test('uninstall removes the block and leaves user content intact', () => {
    mkdirSync(join(fakeHome, ...expectedRelative.slice(0, -1)), { recursive: true });
    writeFileSync(expectedPath(), '# My personal file\n\nSome rules.\n', 'utf8');
    installer.install();
    installer.uninstall();
    const text = readFileSync(expectedPath(), 'utf8');
    expect(text).toContain('# My personal file');
    expect(text).toContain('Some rules.');
    expect(text).not.toMatch(/browser-link:instructions:begin/);
  });
});

describe('Copilot special cases', () => {
  let originalCopilotHome: string | undefined;

  beforeEach(() => {
    originalCopilotHome = process.env.COPILOT_HOME;
    delete process.env.COPILOT_HOME;
  });

  afterEach(() => {
    if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = originalCopilotHome;
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

  test('COPILOT_HOME pointing outside $HOME still installs (explicit user override)', () => {
    const custom = mkdtempSync(join(tmpdir(), 'browser-link-copilot-outside-'));
    process.env.COPILOT_HOME = custom;
    try {
      // The custom dir lives under tmpdir(), which is NOT under fakeHome.
      // Without the COPILOT_HOME-driven override the outside-$HOME guard
      // would throw OutsideHomeError; the env var is the user opting in.
      expect(() => copilotInstructionsInstaller.install()).not.toThrow();
      expect(existsSync(join(custom, 'AGENTS.md'))).toBe(true);
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
  });
});
