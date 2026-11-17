// isolatedServerEnv: the environment of every built-server process a run
// starts (the MCP server and the cdp-direct CLI commands).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { isolatedServerEnv } from './lib.mjs';

const RUN = { wsPort: 41001, ipcPort: 41002, dataDir: '/t/data', homeDir: '/t/home' };

test('points ports, data dir and every HOME-like variable at the run', () => {
  const env = isolatedServerEnv(RUN, {});
  assert.deepEqual(env, {
    BROWSER_LINK_WS_PORT: '41001',
    BROWSER_LINK_IPC_PORT: '41002',
    BROWSER_LINK_DATA_DIR: '/t/data',
    HOME: '/t/home',
    USERPROFILE: '/t/home',
    XDG_CONFIG_HOME: join('/t/home', '.config'),
    XDG_DATA_HOME: join('/t/home', '.local/share'),
    COPILOT_HOME: join('/t/home', '.copilot'),
  });
});

test("keeps the rest of the base environment and overrides the owner's values", () => {
  const base = {
    PATH: '/bin',
    HOME: '/home/owner',
    BROWSER_LINK_DATA_DIR: '/home/owner/data',
    BROWSER_LINK_WS_PORT: '17529',
  };
  const env = isolatedServerEnv(RUN, base);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/t/home');
  assert.equal(env.BROWSER_LINK_DATA_DIR, '/t/data');
  assert.equal(env.BROWSER_LINK_WS_PORT, '41001');
  // The base object itself is not changed.
  assert.equal(base.HOME, '/home/owner');
});
