import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../map/db.js';
import { getMapHint } from '../map/queries.js';
import { handleMapTool } from '../map/tools.js';
import { handleBrowserTool, type BrowserToolDeps } from './browser-dispatch.js';
import type { AgentCaller } from './tab-claims.js';

/**
 * End-to-end regression for the origin-canonicalization WARNING: an agent
 * saves through the REAL `browser.map.save` handler with a free-text origin
 * (trailing slash), and the hint must surface through the REAL
 * `browser.list_tabs` handler whose lookup key is `new URL(tab.url).origin`
 * — the exact save→list join `server.ts` wires in production. Before
 * v0.20.0's canonicalization, this pairing was a silent permanent no-op:
 * the stored "https://myapp.example.com/" never string-matched the
 * canonical "https://myapp.example.com" and the hint was omitted forever,
 * indistinguishable from an empty map.
 *
 * Uses a real temp-dir SQLite DB (same fixture pattern as queries.test.ts),
 * not mocks — the WHERE clause equality is the thing under test.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-maphint-test-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const CALLER: AgentCaller = { agent_id: 'integration-caller', pid: 0, binary: 'node' };

function makeDeps(tabUrl: string): BrowserToolDeps {
  return {
    listTabs: vi.fn(() => [{ tab_id: 'tab_1', url: tabUrl, title: 'My App' }]),
    callBrowserTool: vi.fn(async () => undefined),
    // The exact wiring server.ts uses (minus its outer try/catch, which is
    // irrelevant to the equality under test here).
    getMapHint: (origin) => getMapHint(origin),
  };
}

describe('browser.map.save → browser.list_tabs map hint (real DB, real handlers)', () => {
  test('a save with a trailing-slash origin surfaces as a hint on a tab URL with a path', async () => {
    handleMapTool('browser.map.save', {
      origin: 'https://myapp.example.com/',
      title: 'My App',
      url_pattern: '/home/dashboard',
      kind: 'selector',
      purpose: 'open dashboard',
      payload: { selector: '#dash' },
    });

    const tabs = (await handleBrowserTool(
      'browser.list_tabs',
      {},
      makeDeps('https://myapp.example.com/home/dashboard?tab=1'),
      CALLER,
    )) as Array<Record<string, unknown>>;

    expect(tabs[0]).toMatchObject({
      tab_id: 'tab_1',
      map: { app_key: 'my-app', entries: 1, flows: 0 },
    });
  });

  test('no hint when the map genuinely has nothing for the tab origin', async () => {
    handleMapTool('browser.map.save', {
      origin: 'https://unrelated.example.com/',
      title: 'Other App',
      url_pattern: '/x',
      kind: 'gotcha',
      purpose: 'note',
      payload: { body: 'n' },
    });

    const tabs = (await handleBrowserTool(
      'browser.list_tabs',
      {},
      makeDeps('https://myapp.example.com/home'),
      CALLER,
    )) as Array<Record<string, unknown>>;

    expect(tabs[0]).not.toHaveProperty('map');
  });
});
