import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from './db.js';
import {
  forget,
  getMapHint,
  listAppsWithCounts,
  listEntries,
  listInsights,
  recall,
  saveInsight,
} from './queries.js';
import { handleMapTool, MAP_TOOL_DEFINITIONS } from './tools.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-insights-review-test-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const base = { origin: 'http://x', title: 'My App' };

describe('insight counts in listAppsWithCounts and forget (W1)', () => {
  test('listAppsWithCounts reports insights', () => {
    saveInsight({ ...base, kind: 'pitfall', key: 'p', description: 'd' });
    saveInsight({ ...base, kind: 'mechanism', key: 'm', description: 'd' });
    expect(listAppsWithCounts()[0]).toMatchObject({ entries: 0, flows: 0, insights: 2 });
  });

  test('forgetting an app reports how many insights went with it', () => {
    const { app } = saveInsight({ ...base, kind: 'pitfall', key: 'p', description: 'd' });
    saveInsight({ ...base, kind: 'mechanism', key: 'm', description: 'd' });
    expect(forget({ app_id: app.id })).toEqual({
      deleted_entries: 0,
      deleted_apps: 1,
      deleted_insights: 2,
    });
  });
});

describe('deleting one insight (W2)', () => {
  test('forget({ insight }) deletes exactly that kind+key and nothing else', () => {
    const { app } = saveInsight({ ...base, kind: 'pitfall', key: 'k', description: 'p' });
    saveInsight({ ...base, kind: 'mechanism', key: 'k', description: 'm' });
    saveInsight({ ...base, kind: 'pitfall', key: 'other', description: 'o' });
    const result = forget({ insight: { app_id: app.id, kind: 'pitfall', key: 'k' } });
    expect(result).toMatchObject({ deleted_insights: 1, deleted_apps: 0 });
    expect(listInsights(app.id, 'pitfall').map((r) => r.key)).toEqual(['other']);
    expect(listInsights(app.id, 'mechanism')).toHaveLength(1);
  });

  test('deleting a missing insight reports zero', () => {
    const { app } = saveInsight({ ...base, kind: 'pitfall', key: 'k', description: 'p' });
    expect(forget({ insight: { app_id: app.id, kind: 'pitfall', key: 'nope' } })).toMatchObject({
      deleted_insights: 0,
    });
  });

  test('browser.map.forget accepts insight and the schema declares it', () => {
    const { app } = saveInsight({ ...base, kind: 'pitfall', key: 'k', description: 'p' });
    const result = handleMapTool('browser.map.forget', {
      insight: { app_id: app.id, kind: 'pitfall', key: 'k' },
    });
    expect(result).toMatchObject({ deleted_insights: 1 });
    const def = MAP_TOOL_DEFINITIONS.find((d) => d.name === 'browser.map.forget')!;
    expect((def.inputSchema as { properties: object }).properties).toHaveProperty('insight');
  });

  test.each([
    [{ app_id: 1, kind: 'bogus', key: 'k' }],
    [{ app_id: 'x', kind: 'pitfall', key: 'k' }],
    [{ app_id: 1, kind: 'pitfall', key: '' }],
    ['nope'],
  ])('browser.map.forget rejects a malformed insight %j', (insight) => {
    expect(() => handleMapTool('browser.map.forget', { insight })).toThrow(/insight/);
  });
});

describe('save validation details (N1, N4)', () => {
  const save = {
    origin: 'http://x',
    title: 'My App',
    url_pattern: '/a',
    kind: 'selector',
    purpose: 'p',
    payload: { selector: '#a' },
  };

  test('a recalled item (symptom: null) can be re-saved unchanged', () => {
    handleMapTool('browser.map.save', { ...save, mechanisms: [{ key: 'm', description: 'd' }] });
    const recalled = recall({ origin: 'http://x' });
    expect(recalled.mechanisms[0]?.symptom).toBeNull();
    expect(() =>
      handleMapTool('browser.map.save', { ...save, mechanisms: recalled.mechanisms }),
    ).not.toThrow();
    expect(() =>
      handleMapTool('browser.map.save', {
        origin: 'http://x',
        pitfalls: [{ key: 'p', description: 'd', symptom: null }],
      }),
    ).not.toThrow();
  });

  test('a failure in the write phase rolls back the entry and the app (single transaction)', () => {
    getDb().exec(
      `CREATE TRIGGER boom BEFORE INSERT ON insights BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    expect(() =>
      handleMapTool('browser.map.save', { ...save, pitfalls: [{ key: 'p', description: 'd' }] }),
    ).toThrow(/boom/);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM entries').get()).toEqual({ n: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM apps').get()).toEqual({ n: 0 });
    expect(listEntries(1)).toEqual([]);
  });
});

describe('inline size cap is measured in bytes (N3)', () => {
  test('multi-byte content over 2048 bytes (but under 2048 chars) is not inlined', () => {
    saveInsight({ ...base, kind: 'mechanism', key: 'm', description: 'é'.repeat(1000) });
    const hint = getMapHint('http://x');
    expect(JSON.stringify(hint).length).toBeLessThan(2048 + 200);
    expect(hint).not.toHaveProperty('inline');
  });
});
