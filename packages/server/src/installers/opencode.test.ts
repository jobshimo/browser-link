import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { opencodeInstaller } from './opencode.js';

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'browser-link-opencode-'));
  // os.homedir() respects these env vars on their respective platforms.
  if (process.platform === 'win32') process.env.USERPROFILE = fakeHome;
  else process.env.HOME = fakeHome;
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

const configPath = () => join(fakeHome, '.config', 'opencode', 'opencode.json');

const writeCfg = (cfg: unknown) => {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
};
const readCfg = () => JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;

describe('detect', () => {
  test('reports not installed when opencode.json does not exist', () => {
    const d = opencodeInstaller.detect();
    expect(d.installed).toBe(false);
    expect(d.registered).toBe(false);
    // Path should still be reported so the menu can tell the user where it would go.
    expect(d.configPath).toBe(configPath());
  });

  test('reports installed-but-not-registered when the config has no mcp block', () => {
    writeCfg({ $schema: 'https://opencode.ai/config.json' });
    const d = opencodeInstaller.detect();
    expect(d.installed).toBe(true);
    expect(d.registered).toBe(false);
  });

  test('reports registered when the entry exists under mcp', () => {
    writeCfg({
      mcp: { 'browser-link': { type: 'local', command: ['browser-link'] } },
    });
    expect(opencodeInstaller.detect().registered).toBe(true);
  });

  test('a different mcp entry does not count as registered', () => {
    writeCfg({
      mcp: { 'something-else': { type: 'local', command: ['x'] } },
    });
    expect(opencodeInstaller.detect().registered).toBe(false);
  });
});

describe('install', () => {
  test('creates the config (with directories) when nothing exists yet', () => {
    opencodeInstaller.install('browser-link', []);
    const cfg = readCfg() as {
      $schema?: string;
      mcp: Record<string, { type: string; command: string[] }>;
    };
    expect(cfg.$schema).toBe('https://opencode.ai/config.json');
    expect(cfg.mcp['browser-link']?.type).toBe('local');
    expect(cfg.mcp['browser-link']?.command).toEqual(['browser-link']);
  });

  test('merges into an existing config without dropping unrelated keys', () => {
    writeCfg({
      $schema: 'https://opencode.ai/config.json',
      agent: { foo: 'bar' },
      mcp: { other: { type: 'local', command: ['x'] } },
    });
    opencodeInstaller.install('browser-link', ['--debug']);
    const cfg = readCfg() as {
      agent: { foo: string };
      mcp: Record<string, { type: string; command: string[] }>;
    };
    expect(cfg.agent.foo).toBe('bar');
    expect(cfg.mcp['other']?.command).toEqual(['x']);
    expect(cfg.mcp['browser-link']?.command).toEqual(['browser-link', '--debug']);
  });

  test('merges command and args into the single command array', () => {
    opencodeInstaller.install('node', ['/abs/path/to/cli.js', '--foo']);
    const cfg = readCfg() as { mcp: Record<string, { command: string[] }> };
    expect(cfg.mcp['browser-link']?.command).toEqual(['node', '/abs/path/to/cli.js', '--foo']);
  });

  test('overwrites an existing entry instead of duplicating', () => {
    writeCfg({
      mcp: { 'browser-link': { type: 'local', command: ['old-cmd'] } },
    });
    opencodeInstaller.install('browser-link', []);
    const cfg = readCfg() as { mcp: Record<string, { command: string[] }> };
    expect(cfg.mcp['browser-link']?.command).toEqual(['browser-link']);
  });

  test('does not overwrite an existing $schema', () => {
    writeCfg({ $schema: 'https://example.com/custom-schema.json' });
    opencodeInstaller.install('browser-link', []);
    const cfg = readCfg() as { $schema: string };
    expect(cfg.$schema).toBe('https://example.com/custom-schema.json');
  });
});

describe('uninstall', () => {
  test('removes the entry from mcp', () => {
    writeCfg({
      mcp: {
        'browser-link': { type: 'local', command: ['x'] },
        other: { type: 'local', command: ['y'] },
      },
    });
    opencodeInstaller.uninstall();
    const cfg = readCfg() as { mcp: Record<string, unknown> };
    expect(cfg.mcp['browser-link']).toBeUndefined();
    expect(cfg.mcp['other']).toBeDefined();
  });

  test('is a no-op when the config does not exist', () => {
    expect(() => opencodeInstaller.uninstall()).not.toThrow();
  });

  test('is a no-op when the entry is not present', () => {
    writeCfg({ mcp: { other: { type: 'local', command: ['x'] } } });
    expect(() => opencodeInstaller.uninstall()).not.toThrow();
    const cfg = readCfg() as { mcp: Record<string, unknown> };
    expect(cfg.mcp['other']).toBeDefined();
  });
});
