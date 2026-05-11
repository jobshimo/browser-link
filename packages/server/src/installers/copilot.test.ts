import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { copilotInstaller } from './copilot.js';

let fakeHome: string;
let prevCopilotHome: string | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'browser-link-copilot-'));
  // The installer honours COPILOT_HOME, which is the cleanest hook for tests.
  prevCopilotHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = fakeHome;
});

afterEach(() => {
  if (prevCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = prevCopilotHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

const configPath = () => join(fakeHome, 'mcp-config.json');

const writeCfg = (cfg: unknown) => {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
};
const readCfg = () => JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;

describe('detect', () => {
  test('reports not installed when mcp-config.json does not exist', () => {
    const d = copilotInstaller.detect();
    expect(d.installed).toBe(false);
    expect(d.registered).toBe(false);
    expect(d.configPath).toBe(configPath());
  });

  test('reports installed-but-not-registered when the config has no entry', () => {
    writeCfg({ mcpServers: {} });
    const d = copilotInstaller.detect();
    expect(d.installed).toBe(true);
    expect(d.registered).toBe(false);
  });

  test('reports registered when the entry exists under mcpServers', () => {
    writeCfg({
      mcpServers: {
        'browser-link': { type: 'local', command: 'browser-link', args: [], env: {}, tools: ['*'] },
      },
    });
    expect(copilotInstaller.detect().registered).toBe(true);
  });
});

describe('install', () => {
  test('creates the config (with directories) when nothing exists yet', () => {
    copilotInstaller.install('browser-link', []);
    const cfg = readCfg() as {
      mcpServers: Record<
        string,
        { type: string; command: string; args: string[]; env: object; tools: string[] }
      >;
    };
    const entry = cfg.mcpServers['browser-link']!;
    expect(entry.type).toBe('local');
    expect(entry.command).toBe('browser-link');
    expect(entry.args).toEqual([]);
    expect(entry.env).toEqual({});
    expect(entry.tools).toEqual(['*']);
  });

  test('merges into existing config without dropping unrelated keys', () => {
    writeCfg({
      mcpServers: {
        other: { type: 'local', command: 'x', args: [], env: {}, tools: ['*'] },
      },
    });
    copilotInstaller.install('browser-link', ['--debug']);
    const cfg = readCfg() as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(cfg.mcpServers['other']?.command).toBe('x');
    expect(cfg.mcpServers['browser-link']?.command).toBe('browser-link');
    expect(cfg.mcpServers['browser-link']?.args).toEqual(['--debug']);
  });

  test('keeps command and args as separate fields (Copilot schema)', () => {
    copilotInstaller.install('node', ['/abs/cli.js', '--foo']);
    const cfg = readCfg() as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(cfg.mcpServers['browser-link']?.command).toBe('node');
    expect(cfg.mcpServers['browser-link']?.args).toEqual(['/abs/cli.js', '--foo']);
  });

  test('overwrites an existing entry instead of duplicating', () => {
    writeCfg({
      mcpServers: {
        'browser-link': { type: 'local', command: 'old', args: ['--old'], env: {}, tools: ['*'] },
      },
    });
    copilotInstaller.install('browser-link', []);
    const cfg = readCfg() as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(cfg.mcpServers['browser-link']?.command).toBe('browser-link');
    expect(cfg.mcpServers['browser-link']?.args).toEqual([]);
  });

  test('always writes env:{} and tools:["*"] (Copilot requires both)', () => {
    copilotInstaller.install('browser-link', []);
    const cfg = readCfg() as {
      mcpServers: Record<string, { env: object; tools: string[] }>;
    };
    expect(cfg.mcpServers['browser-link']?.env).toEqual({});
    expect(cfg.mcpServers['browser-link']?.tools).toEqual(['*']);
  });
});

describe('uninstall', () => {
  test('removes the entry from mcpServers', () => {
    writeCfg({
      mcpServers: {
        'browser-link': { type: 'local', command: 'x', args: [], env: {}, tools: ['*'] },
        other: { type: 'local', command: 'y', args: [], env: {}, tools: ['*'] },
      },
    });
    copilotInstaller.uninstall();
    const cfg = readCfg() as { mcpServers: Record<string, unknown> };
    expect(cfg.mcpServers['browser-link']).toBeUndefined();
    expect(cfg.mcpServers['other']).toBeDefined();
  });

  test('is a no-op when the config does not exist', () => {
    expect(() => copilotInstaller.uninstall()).not.toThrow();
  });

  test('is a no-op when the entry is not present', () => {
    writeCfg({
      mcpServers: { other: { type: 'local', command: 'x', args: [], env: {}, tools: ['*'] } },
    });
    expect(() => copilotInstaller.uninstall()).not.toThrow();
    const cfg = readCfg() as { mcpServers: Record<string, unknown> };
    expect(cfg.mcpServers['other']).toBeDefined();
  });
});

describe('COPILOT_HOME override', () => {
  test('configPath honours COPILOT_HOME env var', () => {
    const customRoot = mkdtempSync(join(tmpdir(), 'copilot-custom-'));
    process.env.COPILOT_HOME = customRoot;
    expect(copilotInstaller.configPath()).toBe(join(customRoot, 'mcp-config.json'));
    rmSync(customRoot, { recursive: true, force: true });
  });
});
