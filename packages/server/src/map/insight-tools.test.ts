import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from './db.js';
import { getMapHints, listEntries, listApps } from './queries.js';
import { handleMapTool, MAP_TOOL_DEFINITIONS } from './tools.js';
import { handleBrowserTool, type BrowserToolDeps } from '../tools/browser-dispatch.js';

/* Real-DB tests for browser.map.save `mechanisms` / `pitfalls` and the
 * browser.map.recall sections — handlers are exercised end to end, the
 * same way map-hint.integration.test.ts does for the list_tabs hint. */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-insight-tools-test-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const baseSave = {
  origin: 'https://myapp.example.com',
  title: 'My App',
  url_pattern: '/home',
  kind: 'selector',
  purpose: 'nav link',
  payload: { selector: '#nav' },
};

describe('browser.map.save — mechanisms and pitfalls', () => {
  test('persists both and browser.map.recall returns them, pitfalls section first', () => {
    const saved = handleMapTool('browser.map.save', {
      ...baseSave,
      mechanisms: [
        { key: 'get-marks-complete', description: 'A GET of the item URL completes it.' },
      ],
      pitfalls: [
        {
          key: 'next-click-noop',
          description: 'Clicking the next link does not navigate.',
          symptom: 'click ok, URL unchanged',
        },
      ],
    }) as Record<string, unknown[]>;
    expect(saved.mechanisms).toHaveLength(1);
    expect(saved.pitfalls).toHaveLength(1);

    const recalled = handleMapTool('browser.map.recall', {
      origin: 'https://myapp.example.com',
    }) as Record<string, unknown[]>;
    expect(Object.keys(recalled)).toEqual(['app', 'pitfalls', 'mechanisms', 'entries', 'flows']);
    expect(recalled.pitfalls[0]).toMatchObject({
      key: 'next-click-noop',
      symptom: 'click ok, URL unchanged',
    });
    expect(recalled.mechanisms[0]).toMatchObject({ key: 'get-marks-complete' });
  });

  test('omits mechanisms/pitfalls from the save result when none were passed', () => {
    const saved = handleMapTool('browser.map.save', baseSave) as Record<string, unknown>;
    expect(saved).not.toHaveProperty('mechanisms');
    expect(saved).not.toHaveProperty('pitfalls');
  });

  const BAD: [string, Record<string, unknown>, RegExp][] = [
    [
      'non-array mechanisms',
      { mechanisms: { key: 'k', description: 'd' } },
      /mechanisms must be an array/,
    ],
    ['non-array pitfalls', { pitfalls: 'nope' }, /pitfalls must be an array/],
    ['non-object mechanism', { mechanisms: ['x'] }, /each mechanism must be an object/],
    ['empty pitfall key', { pitfalls: [{ key: ' ', description: 'd' }] }, /non-empty key/],
    ['missing description', { mechanisms: [{ key: 'k' }] }, /non-empty description/],
    [
      'non-string symptom',
      { pitfalls: [{ key: 'k', description: 'd', symptom: 3 }] },
      /symptom must be a string/,
    ],
    [
      'symptom on a mechanism',
      { mechanisms: [{ key: 'k', description: 'd', symptom: 's' }] },
      /symptom/,
    ],
    [
      'oversized description',
      { pitfalls: [{ key: 'k', description: 'x'.repeat(1001) }] },
      /at most 1000/,
    ],
    ['oversized key', { pitfalls: [{ key: 'k'.repeat(101), description: 'd' }] }, /at most 100/],
  ];

  test.each(BAD)('rejects %s and writes nothing (not even the base entry)', (_name, extra, re) => {
    expect(() => handleMapTool('browser.map.save', { ...baseSave, ...extra })).toThrow(re);
    expect(listApps()).toEqual([]);
  });

  test('a valid save after a rejected one still works (no partial state)', () => {
    expect(() =>
      handleMapTool('browser.map.save', { ...baseSave, pitfalls: [{ key: '' }] }),
    ).toThrow();
    handleMapTool('browser.map.save', baseSave);
    const [app] = listApps();
    expect(listEntries(app!.id)).toHaveLength(1);
  });

  test('the save schema declares mechanisms and pitfalls and the docs forbid domain data', () => {
    const save = MAP_TOOL_DEFINITIONS.find((d) => d.name === 'browser.map.save')!;
    const props = (save.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('mechanisms');
    expect(props).toHaveProperty('pitfalls');
    expect(save.description).toMatch(/mechanism/i);
    expect(save.description).toMatch(/pitfall/i);
    expect((save.doc?.gotchas ?? []).join(' ')).toMatch(/behaviou?r, never content/i);
  });
});

describe('browser.list_tabs — inline map content vs counts', () => {
  const deps: BrowserToolDeps = {
    listTabs: vi.fn(() => [
      { tab_id: 'tab_1', url: 'https://myapp.example.com/home', title: 'My App' },
    ]),
    callBrowserTool: vi.fn(async () => undefined),
    getMapHints: (origins) => getMapHints(origins),
  };
  const caller = { agent_id: 'a', pid: 0, binary: 'node' };

  async function mapOfFirstTab(): Promise<Record<string, unknown>> {
    const tabs = (await handleBrowserTool('browser.list_tabs', {}, deps, caller)) as Array<{
      map: Record<string, unknown>;
    }>;
    return tabs[0]!.map;
  }

  test('a small map arrives inline with the counts', async () => {
    handleMapTool('browser.map.save', {
      ...baseSave,
      pitfalls: [{ key: 'p', description: 'does not work' }],
    });
    const map = await mapOfFirstTab();
    expect(map).toMatchObject({
      app_key: 'my-app',
      entries: 1,
      flows: 0,
      mechanisms: 0,
      pitfalls: 1,
    });
    expect(map.inline).toMatchObject({ pitfalls: [{ key: 'p', description: 'does not work' }] });
  });

  test('a bigger map (more than 5 items) falls back to counts only', async () => {
    handleMapTool('browser.map.save', {
      ...baseSave,
      mechanisms: [1, 2, 3].map((i) => ({ key: `m${i}`, description: 'd' })),
      pitfalls: [1, 2, 3].map((i) => ({ key: `p${i}`, description: 'd' })),
    });
    const map = await mapOfFirstTab();
    expect(map).toMatchObject({ entries: 1, mechanisms: 3, pitfalls: 3 });
    expect(map).not.toHaveProperty('inline');
  });
});
