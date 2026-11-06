import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from './db.js';
import { listApps, listEntries, listFlows, listInsights } from './queries.js';
import { handleMapTool, MAP_TOOL_DEFINITIONS } from './tools.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-entryless-test-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const ORIGIN = 'https://myapp.example.com';
const ENTRY = {
  url_pattern: '/home',
  kind: 'selector',
  purpose: 'nav link',
  payload: { selector: '#nav' },
};

describe('browser.map.save without a base entry', () => {
  test('a pitfalls-only save succeeds and creates no entry row', () => {
    const result = handleMapTool('browser.map.save', {
      origin: ORIGIN,
      title: 'My App',
      pitfalls: [{ key: 'p', description: 'does not work' }],
    }) as Record<string, unknown>;
    expect(result).not.toHaveProperty('entry');
    expect(result.pitfalls).toHaveLength(1);
    const [app] = listApps();
    expect(app?.app_key).toBe('my-app');
    expect(listEntries(app!.id)).toEqual([]);
    expect(listInsights(app!.id, 'pitfall')).toHaveLength(1);
  });

  test('a mechanisms-only save succeeds', () => {
    handleMapTool('browser.map.save', {
      origin: ORIGIN,
      mechanisms: [{ key: 'm', description: 'GET completes it' }],
    });
    const [app] = listApps();
    expect(listInsights(app!.id, 'mechanism')).toHaveLength(1);
  });

  test('a flows-only save succeeds', () => {
    handleMapTool('browser.map.save', {
      origin: ORIGIN,
      flows: [{ name: 'f', steps: [{ find: { text: 'Go' } }, { click: {} }] }],
    });
    const [app] = listApps();
    expect(listFlows(app!.id)).toHaveLength(1);
    expect(listEntries(app!.id)).toEqual([]);
  });

  test('a save with a full entry plus insights still writes both', () => {
    handleMapTool('browser.map.save', {
      origin: ORIGIN,
      ...ENTRY,
      pitfalls: [{ key: 'p', description: 'd' }],
    });
    const [app] = listApps();
    expect(listEntries(app!.id)).toHaveLength(1);
    expect(listInsights(app!.id, 'pitfall')).toHaveLength(1);
  });

  test('a call carrying nothing at all is rejected and writes nothing', () => {
    expect(() => handleMapTool('browser.map.save', { origin: ORIGIN })).toThrow(/nothing to save/);
    expect(() =>
      handleMapTool('browser.map.save', { origin: ORIGIN, pitfalls: [], mechanisms: [] }),
    ).toThrow(/nothing to save/);
    expect(listApps()).toEqual([]);
  });

  test('a missing origin is still rejected', () => {
    expect(() =>
      handleMapTool('browser.map.save', { pitfalls: [{ key: 'p', description: 'd' }] }),
    ).toThrow(/origin/);
    expect(listApps()).toEqual([]);
  });

  test.each(['url_pattern', 'kind', 'purpose', 'payload'])(
    'a partial entry (only %s) is rejected naming the missing fields, nothing written',
    (field) => {
      expect(() =>
        handleMapTool('browser.map.save', {
          origin: ORIGIN,
          [field]: (ENTRY as Record<string, unknown>)[field],
          pitfalls: [{ key: 'p', description: 'd' }],
        }),
      ).toThrow(/entry requires/);
      expect(listApps()).toEqual([]);
    },
  );

  test('an invalid entry kind is rejected', () => {
    expect(() =>
      handleMapTool('browser.map.save', { origin: ORIGIN, ...ENTRY, kind: 'bogus' }),
    ).toThrow(/kind must be one of/);
    expect(listApps()).toEqual([]);
  });

  test('the schema only requires origin', () => {
    const save = MAP_TOOL_DEFINITIONS.find((d) => d.name === 'browser.map.save')!;
    expect((save.inputSchema as { required: string[] }).required).toEqual(['origin']);
  });
});
