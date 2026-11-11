import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, unreadableConfigMessage, type UnreadableConfig } from '../config.js';
import { createPrimaryAdminHandlers } from './primary.js';
import { gatherAdminInput } from './sources.js';

/* S6.3: the Admin window never writes over an unreadable config.json and
 * never describes the defaults as the settings in effect. Data dir and HOME
 * are temp dirs; the update check is stubbed (no network). */

const saved = {
  home: process.env.HOME,
  profile: process.env.USERPROFILE,
  data: process.env.BROWSER_LINK_DATA_DIR,
};
let dir: string;
let dataDir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'browser-link-admin-unreadable-'));
  dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
  configPath = join(dataDir, 'config.json');
});

afterEach(() => {
  for (const [key, value] of [
    ['HOME', saved.home],
    ['USERPROFILE', saved.profile],
    ['BROWSER_LINK_DATA_DIR', saved.data],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const BROKEN = '{ "language": "es" ';

function handlers() {
  return createPrimaryAdminHandlers({
    version: '1.0.0',
    tabsConnected: () => 0,
    connectedExtensionVersion: () => null,
    checkUpdates: () =>
      Promise.resolve({ current: '1.0.0', latest: null, isNewer: false }) as never,
    doctor: () => Promise.resolve([]),
  });
}

function problem(): UnreadableConfig {
  const read = readConfig();
  if (read.state !== 'unreadable') throw new Error('config is not unreadable');
  return read;
}

describe('Admin window with an unreadable config.json', () => {
  test.each([
    [{ id: 'language', value: 'en', confirm: true }],
    [{ id: 'multiAgent', value: false, confirm: true }],
    [{ id: 'activityEnabled', value: false, confirm: true }],
  ])('action %j fails with the refusal message and writes nothing', async (req) => {
    writeFileSync(configPath, BROKEN, 'utf8');
    expect(await handlers().action(req)).toEqual({
      ok: false,
      error: unreadableConfigMessage(problem()),
    });
    expect(readFileSync(configPath, 'utf8')).toBe(BROKEN);
    expect(readdirSync(dataDir)).toEqual(['config.json']);
  });

  test('describe rejects with the refusal message instead of showing the defaults', async () => {
    writeFileSync(configPath, BROKEN, 'utf8');
    await expect(handlers().describe()).rejects.toThrow(unreadableConfigMessage(problem()));
  });

  test('gatherAdminInput (the console status view) rejects the same way', async () => {
    writeFileSync(configPath, BROKEN, 'utf8');
    await expect(
      gatherAdminInput({
        server: () => Promise.resolve({ running: null, installed: '1.0.0', outdated: false }),
      }),
    ).rejects.toThrow(unreadableConfigMessage(problem()));
  });
});

describe('Admin window with a valid config.json (unchanged)', () => {
  test('a confirmed toggle still writes a valid file with the other keys kept', async () => {
    writeFileSync(configPath, JSON.stringify({ language: 'es' }), 'utf8');
    const result = await handlers().action({ id: 'activityEnabled', value: false, confirm: true });
    expect(result.ok).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toBe(
      JSON.stringify({ language: 'es', activityEnabled: false }, null, 2) + '\n',
    );
  });
});
