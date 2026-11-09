import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import * as paths from '../map/paths.js';
import { App } from './app.js';
import type { AdminInput } from '../admin/descriptor.js';

/* Register from the setup console with a malformed client config. HOME and
 * the data dir point at temp dirs; the status view's facts are injected so
 * no live primary is probed. */

let fakeHome: string;
let dataDir: string;
let dataDirSpy: ReturnType<typeof vi.spyOn>;
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'browser-link-app-home-'));
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-app-data-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  dataDirSpy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
});

afterEach(() => {
  process.env.HOME = savedEnv.HOME;
  process.env.USERPROFILE = savedEnv.USERPROFILE;
  dataDirSpy.mockRestore();
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const statusInput = (): Promise<AdminInput> =>
  Promise.resolve({
    config: {},
    now: 0,
    version: '0.47.0',
    server: { running: null, installed: '0.47.0', outdated: false },
    tabsConnected: null,
    ports: { ws: 17529, ipc: 17530 },
    extension: { path: null, connectedVersion: null },
    instructions: [],
    clients: [],
    cdpGrant: { live: false, remainingMs: null },
    update: null,
    toolNames: [],
    downloadsDir: '/d',
  });

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('App Register with a malformed ~/.claude.json', () => {
  test('opens the client picker with the client marked, and registering it reports the error', async () => {
    writeFileSync(join(fakeHome, '.claude.json'), '{ "mcpServers": ', 'utf8');
    const { lastFrame, stdin } = render(
      <App
        initialLanguage="en"
        skipWelcome={true}
        noticeAcknowledged={true}
        statusInput={statusInput}
      />,
    );
    await tick();
    stdin.write('\t'); // status view → menu
    await tick();
    stdin.write('r'); // Register
    await tick();
    expect(lastFrame() ?? '').toContain('Which MCP client?');
    expect(lastFrame() ?? '').toContain('unknown (config unreadable)');

    stdin.write('c'); // pick Claude Code
    await tick();
    const out = lastFrame() ?? '';
    expect(out).toContain('Could not parse Claude config');
    expect(out).not.toContain('Which MCP client?');
  });
});
