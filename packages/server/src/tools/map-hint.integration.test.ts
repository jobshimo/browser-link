import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../map/db.js';
import { getMapHint, getMapHints } from '../map/queries.js';
import { handleMapTool } from '../map/tools.js';
import { handleBrowserTool, type BrowserToolDeps, type TabSnapshot } from './browser-dispatch.js';
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

function makeDeps(tabs: TabSnapshot[]): BrowserToolDeps {
  return {
    listTabs: vi.fn(() => tabs),
    callBrowserTool: vi.fn(async () => undefined),
    // The exact wiring server.ts uses (minus its outer try/catch, which is
    // irrelevant to the equality under test here).
    getMapHints: (origins) => getMapHints(origins),
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
      makeDeps([
        { tab_id: 'tab_1', url: 'https://myapp.example.com/home/dashboard?tab=1', title: 'My App' },
      ]),
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
      makeDeps([{ tab_id: 'tab_1', url: 'https://myapp.example.com/home', title: 'My App' }]),
      CALLER,
    )) as Array<Record<string, unknown>>;

    expect(tabs[0]).not.toHaveProperty('map');
  });
});

describe('browser.list_tabs — batched map hints across multiple tabs (real DB, real handlers)', () => {
  test('multiple tabs on the same origin all get the same hint, computed once', async () => {
    handleMapTool('browser.map.save', {
      origin: 'https://myapp.example.com',
      title: 'My App',
      url_pattern: '/home',
      kind: 'selector',
      purpose: 'nav link',
      payload: { selector: '#nav' },
    });
    handleMapTool('browser.map.save', {
      origin: 'https://myapp.example.com',
      title: 'My App',
      url_pattern: '/login',
      kind: 'selector',
      purpose: 'login button',
      payload: { selector: '#login' },
    });

    const tabs = (await handleBrowserTool(
      'browser.list_tabs',
      {},
      makeDeps([
        { tab_id: 'tab_1', url: 'https://myapp.example.com/home', title: 'My App' },
        { tab_id: 'tab_2', url: 'https://myapp.example.com/settings', title: 'My App' },
        { tab_id: 'tab_3', url: 'https://myapp.example.com/login', title: 'My App' },
      ]),
      CALLER,
    )) as Array<Record<string, unknown>>;

    const expectedHint = getMapHint('https://myapp.example.com');
    expect(expectedHint).not.toBeNull();
    for (const tab of tabs) {
      expect(tab.map).toEqual(expectedHint);
    }
  });

  test('a mix of tabs with and without a saved app each get the right hint (or none)', async () => {
    handleMapTool('browser.map.save', {
      origin: 'https://myapp.example.com',
      title: 'My App',
      url_pattern: '/home',
      kind: 'selector',
      purpose: 'nav link',
      payload: { selector: '#nav' },
    });

    const tabs = (await handleBrowserTool(
      'browser.list_tabs',
      {},
      makeDeps([
        { tab_id: 'tab_1', url: 'https://myapp.example.com/home', title: 'My App' },
        { tab_id: 'tab_2', url: 'https://no-app-here.example.com/', title: 'No App' },
        { tab_id: 'tab_3', url: 'https://myapp.example.com/other', title: 'My App' },
      ]),
      CALLER,
    )) as Array<Record<string, unknown>>;

    const known = getMapHint('https://myapp.example.com');
    const unknown = getMapHint('https://no-app-here.example.com');
    expect(known).not.toBeNull();
    expect(unknown).toBeNull();

    expect(tabs.find((t) => t.tab_id === 'tab_1')?.map).toEqual(known);
    expect(tabs.find((t) => t.tab_id === 'tab_2')).not.toHaveProperty('map');
    expect(tabs.find((t) => t.tab_id === 'tab_3')?.map).toEqual(known);
  });

  test('batched list_tabs results match calling the single-origin lookup per tab', async () => {
    handleMapTool('browser.map.save', {
      origin: 'https://a.example.com',
      title: 'App A',
      url_pattern: '/x',
      kind: 'selector',
      purpose: 'a',
      payload: { selector: '#a' },
    });
    handleMapTool('browser.map.save', {
      origin: 'https://b.example.com',
      title: 'App B',
      url_pattern: '/y',
      kind: 'gotcha',
      purpose: 'b',
      payload: { body: 'note' },
    });

    const rawTabs = [
      { tab_id: 'tab_1', url: 'https://a.example.com/x', title: 'App A' },
      { tab_id: 'tab_2', url: 'https://b.example.com/y', title: 'App B' },
      { tab_id: 'tab_3', url: 'https://c.example.com/z', title: 'App C' },
    ];
    const tabs = (await handleBrowserTool(
      'browser.list_tabs',
      {},
      makeDeps(rawTabs),
      CALLER,
    )) as Array<Record<string, unknown>>;

    for (const raw of rawTabs) {
      const single = getMapHint(new URL(raw.url).origin);
      const batched = tabs.find((t) => t.tab_id === raw.tab_id)?.map ?? null;
      expect(batched).toEqual(single);
    }
  });
});
