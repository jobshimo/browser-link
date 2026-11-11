import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, unreadableConfigMessage, type UnreadableConfig } from './config.js';
import { dispatch } from './cli.js';

/* The real CLI dispatch (no module mocks) with an unreadable config.json in
 * a temp data dir. Only commands that never start the server are run. A
 * rejected `dispatch` is what the entry point turns into exit code 1 with
 * the message on stderr. */

let dataDir: string;
let configPath: string;
let logs: string[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-cli-unreadable-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
  configPath = join(dataDir, 'config.json');
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${String(code)})`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const BROKEN = '{ "language": "es", ';

function problem(): UnreadableConfig {
  const read = readConfig();
  if (read.state !== 'unreadable') throw new Error('config is not unreadable');
  return read;
}

describe('cli dispatch with an unreadable config.json', () => {
  test('a command that needs no config still runs, in English', async () => {
    writeFileSync(configPath, BROKEN, 'utf8');
    await dispatch(['help']);
    expect(logs.join('\n')).toContain('bridge any MCP client to the Chrome tabs you enable');
    expect(readFileSync(configPath, 'utf8')).toBe(BROKEN);
  });

  test.each([
    [['config', 'set', 'idle-ttl', '15']],
    [['tools', 'disable', 'browser.click']],
    [['multi-agent', 'disable']],
    [['config', 'get']],
  ])('%j fails with the refusal message and writes nothing', async (argv) => {
    writeFileSync(configPath, BROKEN, 'utf8');
    await expect(dispatch(argv)).rejects.toThrow(unreadableConfigMessage(problem()));
    expect(readFileSync(configPath, 'utf8')).toBe(BROKEN);
    expect(readdirSync(dataDir)).toEqual(['config.json']);
  });

  test('config restore-defaults --yes restores and prints the report', async () => {
    writeFileSync(configPath, BROKEN, 'utf8');
    await dispatch(['config', 'restore-defaults', '--yes']);
    expect(readFileSync(configPath, 'utf8')).toBe('{}\n');
    const backups = readdirSync(dataDir).filter((f) => f.startsWith('config.json.unreadable-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dataDir, backups[0] ?? ''), 'utf8')).toBe(BROKEN);
    expect(logs.join('\n')).toContain('Restored the default settings.');
  });

  test('the help names config restore-defaults in both languages', async () => {
    await dispatch(['help']);
    writeFileSync(configPath, '{"language":"es"}', 'utf8');
    await dispatch(['help']);
    const out = logs.join('\n');
    expect(out.match(/browser-link config restore-defaults \[--yes\]/g)).toHaveLength(2);
  });
});

describe('cli dispatch with a missing or valid config.json (unchanged)', () => {
  test('the configured language is still used', async () => {
    writeFileSync(configPath, '{"language":"es"}', 'utf8');
    await dispatch(['help']);
    expect(logs.join('\n')).toContain('puente entre cualquier cliente MCP');
  });
});
