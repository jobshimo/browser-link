import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from './db.js';
import { getDbPath } from './paths.js';
import {
  forget,
  getMapHint,
  listApps,
  listInsights,
  recall,
  saveEntry,
  saveInsight,
} from './queries.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-insights-test-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const base = { origin: 'http://x', title: 'My App' };

describe('insights migration', () => {
  test('a pre-insights DB with real rows gains the insights table and keeps every row', () => {
    closeDb();
    const legacy = new Database(getDbPath());
    legacy.exec(`
      CREATE TABLE apps (
        id INTEGER PRIMARY KEY, origin TEXT NOT NULL, app_key TEXT NOT NULL, title TEXT,
        notes TEXT, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        UNIQUE(origin, app_key)
      );
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        url_pattern TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('selector', 'flow', 'gotcha')),
        purpose TEXT NOT NULL, payload TEXT NOT NULL, verified_at TEXT, failed_at TEXT,
        notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(app_id, url_pattern, kind, purpose)
      );
      CREATE TABLE flows (
        id INTEGER PRIMARY KEY,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        name TEXT NOT NULL, description TEXT, steps_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0, UNIQUE(app_id, name)
      );
    `);
    legacy
      .prepare('INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES (?,?,?,?)')
      .run('http://legacy', 'legacy-app', '2026-01-01', '2026-01-01');
    legacy
      .prepare(
        `INSERT INTO entries (app_id, url_pattern, kind, purpose, payload, verified_at, created_at, updated_at)
         VALUES (1, '/x', 'selector', 'btn', '{"selector":"#b"}', '2026-01-02', '2026-01-01', '2026-01-02')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO flows (app_id, name, steps_json, created_at, updated_at, use_count)
         VALUES (1, 'f', '[]', '2026-01-01', '2026-01-01', 7)`,
      )
      .run();
    legacy.close();

    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    expect(tables.map((t) => t.name)).toContain('insights');
    expect(db.prepare('SELECT purpose, payload, verified_at FROM entries').all()).toEqual([
      { purpose: 'btn', payload: '{"selector":"#b"}', verified_at: '2026-01-02' },
    ]);
    expect(db.prepare('SELECT name, use_count FROM flows').all()).toEqual([
      { name: 'f', use_count: 7 },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM insights').get()).toEqual({ n: 0 });
  });

  test('rejects an unknown insight kind and cascades on app delete', () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES ('http://a','a','t','t')",
    ).run();
    const insert = (kind: string) =>
      db
        .prepare(
          `INSERT INTO insights (app_id, kind, key, description, created_at, updated_at)
           VALUES (1, ?, 'k', 'd', 't', 't')`,
        )
        .run(kind);
    expect(() => insert('bogus')).toThrow();
    insert('pitfall');
    db.prepare('DELETE FROM apps WHERE id = 1').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM insights').get()).toEqual({ n: 0 });
  });
});

describe('mechanisms and pitfalls (insights)', () => {
  test('saveInsight round-trips a mechanism and a pitfall (with symptom)', () => {
    const m = saveInsight({
      ...base,
      kind: 'mechanism',
      key: 'lesson-get-marks-complete',
      description: 'A GET of a lesson URL marks it complete server-side.',
    });
    const p = saveInsight({
      ...base,
      kind: 'pitfall',
      key: 'next-link-click-noop',
      description: 'Click on the next-lesson link does not navigate (mouseup handler).',
      symptom: 'click returns ok but the URL does not change',
    });
    expect(m.insight).toMatchObject({ kind: 'mechanism', key: 'lesson-get-marks-complete' });
    expect(m.insight.symptom).toBeNull();
    expect(p.insight.symptom).toBe('click returns ok but the URL does not change');
    expect(listInsights(m.app.id, 'mechanism')).toHaveLength(1);
    expect(listInsights(m.app.id, 'pitfall')).toHaveLength(1);
  });

  test('upserts on (app, kind, key): the second save replaces the description', () => {
    saveInsight({ ...base, kind: 'pitfall', key: 'k', description: 'old' });
    const second = saveInsight({ ...base, kind: 'pitfall', key: 'k', description: 'new' });
    const rows = listInsights(second.app.id, 'pitfall');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('new');
  });

  test('the same key may exist as both a mechanism and a pitfall', () => {
    const a = saveInsight({ ...base, kind: 'mechanism', key: 'k', description: 'm' });
    saveInsight({ ...base, kind: 'pitfall', key: 'k', description: 'p' });
    expect(listInsights(a.app.id, 'mechanism')).toHaveLength(1);
    expect(listInsights(a.app.id, 'pitfall')).toHaveLength(1);
  });

  test('recall returns pitfalls first, then mechanisms, then entries and flows', () => {
    saveEntry({
      ...base,
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'p',
      payload: { selector: '#a' },
    });
    saveInsight({ ...base, kind: 'mechanism', key: 'm1', description: 'm' });
    saveInsight({ ...base, kind: 'pitfall', key: 'p1', description: 'p' });
    const result = recall({ origin: 'http://x' });
    expect(Object.keys(result)).toEqual(['app', 'pitfalls', 'mechanisms', 'entries', 'flows']);
    expect(result.pitfalls.map((p) => p.key)).toEqual(['p1']);
    expect(result.mechanisms.map((m) => m.key)).toEqual(['m1']);
  });

  test('recall of an unknown origin returns empty sections', () => {
    expect(recall({ origin: 'http://nope' })).toEqual({
      app: null,
      pitfalls: [],
      mechanisms: [],
      entries: [],
      flows: [],
    });
  });

  test('forgetting the app cascades to its insights', () => {
    const { app } = saveInsight({ ...base, kind: 'pitfall', key: 'k', description: 'd' });
    forget({ app_id: app.id });
    expect(listInsights(app.id, 'pitfall')).toEqual([]);
  });
});

describe('getMapHint — mechanisms, pitfalls and inline content', () => {
  test('an app with only a pitfall still yields a hint, with counts', () => {
    saveInsight({ ...base, kind: 'pitfall', key: 'p', description: 'd' });
    expect(getMapHint('http://x')).toMatchObject({
      app_key: 'my-app',
      entries: 0,
      flows: 0,
      mechanisms: 0,
      pitfalls: 1,
    });
  });

  test('a small map carries the recalled content inline, pitfalls first', () => {
    saveEntry({
      ...base,
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'search box',
      payload: { selector: '#q' },
    });
    saveInsight({ ...base, kind: 'mechanism', key: 'm', description: 'behaviour' });
    saveInsight({
      ...base,
      kind: 'pitfall',
      key: 'p',
      description: 'does not work',
      symptom: 'silent no-op',
    });
    const hint = getMapHint('http://x');
    expect(hint?.inline).toBeDefined();
    expect(Object.keys(hint?.inline ?? {})).toEqual(['pitfalls', 'mechanisms', 'entries', 'flows']);
    expect(hint?.inline?.pitfalls).toEqual([
      { key: 'p', description: 'does not work', symptom: 'silent no-op' },
    ]);
    expect(hint?.inline?.mechanisms).toEqual([{ key: 'm', description: 'behaviour' }]);
    expect(hint?.inline?.entries[0]).toMatchObject({
      url_pattern: '/a',
      kind: 'selector',
      purpose: 'search box',
      payload: { selector: '#q' },
    });
  });

  test('inline is included at exactly 5 items and dropped at 6 (counts only)', () => {
    for (let i = 0; i < 5; i++) {
      saveInsight({ ...base, kind: 'pitfall', key: `p${i}`, description: 'd' });
    }
    expect(getMapHint('http://x')?.inline).toBeDefined();
    saveInsight({ ...base, kind: 'pitfall', key: 'p5', description: 'd' });
    const hint = getMapHint('http://x');
    expect(hint).not.toHaveProperty('inline');
    expect(hint).toMatchObject({ pitfalls: 6 });
  });

  test('inline is dropped when the serialized content exceeds 2 KB', () => {
    saveInsight({ ...base, kind: 'mechanism', key: 'big', description: 'x'.repeat(2100) });
    const hint = getMapHint('http://x');
    expect(hint).not.toHaveProperty('inline');
    expect(hint).toMatchObject({ mechanisms: 1 });
  });

  test('building the hint does not bump last_seen_at', () => {
    const { app } = saveInsight({ ...base, kind: 'pitfall', key: 'p', description: 'd' });
    const before = listApps().find((a) => a.id === app.id)?.last_seen_at;
    getMapHint('http://x');
    expect(listApps().find((a) => a.id === app.id)?.last_seen_at).toBe(before);
  });
});
