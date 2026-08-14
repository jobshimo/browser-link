import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeInstaller } from './claude.js';

let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'browser-link-home-'));
  homedirSpy = vi.spyOn({ homedir }, 'homedir').mockReturnValue(fakeHome);
  // The installer uses the imported homedir directly, so we also patch
  // process.env.HOME / USERPROFILE which os.homedir() respects.
  if (process.platform === 'win32') process.env.USERPROFILE = fakeHome;
  else process.env.HOME = fakeHome;
});

afterEach(() => {
  homedirSpy.mockRestore();
  rmSync(fakeHome, { recursive: true, force: true });
});

const configPath = () => join(fakeHome, '.claude.json');
const writeCfg = (cfg: unknown) =>
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
const readCfg = () => JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;

describe('detect', () => {
  test('reports not installed when ~/.claude.json does not exist', () => {
    const d = claudeInstaller.detect();
    expect(d.installed).toBe(false);
    expect(d.registered).toBe(false);
  });

  test('reports installed-but-not-registered when the config has no entry', () => {
    writeCfg({ mcpServers: {} });
    const d = claudeInstaller.detect();
    expect(d.installed).toBe(true);
    expect(d.registered).toBe(false);
  });

  test('reports registered when the entry exists at user scope', () => {
    writeCfg({ mcpServers: { 'browser-link': { command: 'browser-link', args: [] } } });
    expect(claudeInstaller.detect().registered).toBe(true);
  });

  test('reports registered when the entry exists in any project scope', () => {
    writeCfg({
      projects: {
        '/foo': { mcpServers: { 'browser-link': { command: 'x', args: [] } } },
      },
    });
    expect(claudeInstaller.detect().registered).toBe(true);
  });
});

describe('install', () => {
  test('adds a new entry under mcpServers (user scope)', () => {
    writeCfg({});
    claudeInstaller.install('browser-link', []);
    const cfg = readCfg() as { mcpServers: Record<string, { command: string; type?: string }> };
    expect(cfg.mcpServers['browser-link']?.command).toBe('browser-link');
    expect(cfg.mcpServers['browser-link']?.type).toBe('stdio');
  });

  test('overwrites an existing entry instead of duplicating', () => {
    writeCfg({ mcpServers: { 'browser-link': { command: 'old', args: [] } } });
    claudeInstaller.install('browser-link', ['--debug']);
    const cfg = readCfg() as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(cfg.mcpServers['browser-link']?.command).toBe('browser-link');
    expect(cfg.mcpServers['browser-link']?.args).toEqual(['--debug']);
  });
});

describe('uninstall', () => {
  test('removes the entry from user scope', () => {
    writeCfg({
      mcpServers: { 'browser-link': { command: 'x', args: [] }, other: { command: 'y', args: [] } },
    });
    claudeInstaller.uninstall();
    const cfg = readCfg() as { mcpServers: Record<string, unknown> };
    expect(cfg.mcpServers['browser-link']).toBeUndefined();
    expect(cfg.mcpServers['other']).toBeDefined();
  });

  test('also removes any project-scope occurrences', () => {
    writeCfg({
      projects: {
        '/a': { mcpServers: { 'browser-link': { command: 'x', args: [] } } },
        '/b': { mcpServers: { 'browser-link': { command: 'y', args: [] }, keep: {} } },
      },
    });
    claudeInstaller.uninstall();
    const cfg = readCfg() as {
      projects: Record<string, { mcpServers: Record<string, unknown> }>;
    };
    expect(cfg.projects['/a']?.mcpServers['browser-link']).toBeUndefined();
    expect(cfg.projects['/b']?.mcpServers['browser-link']).toBeUndefined();
    expect(cfg.projects['/b']?.mcpServers['keep']).toBeDefined();
  });

  test('is a no-op when the config has no entry', () => {
    writeCfg({ mcpServers: {} });
    expect(() => claudeInstaller.uninstall()).not.toThrow();
  });
});
