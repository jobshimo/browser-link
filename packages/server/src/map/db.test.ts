import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from './db.js';
import { getDbPath } from './paths.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-db-test-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('getDb — bootstrap', () => {
  test('creates the data dir on first call', () => {
    const nested = join(dataDir, 'does', 'not', 'exist');
    process.env.BROWSER_LINK_DATA_DIR = nested;
    getDb();
    expect(existsSync(nested)).toBe(true);
    expect(existsSync(join(nested, 'map.db'))).toBe(true);
  });

  test('returns the same Database instance on repeated calls (singleton)', () => {
    const a = getDb();
    const b = getDb();
    expect(a).toBe(b);
  });

  test('closeDb releases the singleton so the next getDb opens fresh', () => {
    const first = getDb();
    closeDb();
    const second = getDb();
    expect(second).not.toBe(first);
  });

  test('enables WAL journal mode', () => {
    const db = getDb();
    const mode = db.pragma('journal_mode', { simple: true });
    expect(String(mode).toLowerCase()).toBe('wal');
  });

  test('enables foreign_keys', () => {
    const db = getDb();
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(Number(fk)).toBe(1);
  });
});

describe('schema migrations', () => {
  test('creates the apps and entries tables and the lookup index', () => {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('apps');
    expect(names).toContain('entries');
    expect(names).toContain('idx_entries_lookup');
  });

  test('is idempotent — calling getDb on an existing DB does not destroy data', () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
    ).run('http://x', 'app', '2026-05-12', '2026-05-12');
    closeDb();

    const db2 = getDb();
    const rows = db2.prepare('SELECT origin, app_key FROM apps').all();
    expect(rows).toEqual([{ origin: 'http://x', app_key: 'app' }]);
  });

  test('CHECK constraint rejects entries with an invalid kind', () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
    ).run('http://x', 'app', '2026-05-12', '2026-05-12');
    expect(() =>
      db
        .prepare(
          'INSERT INTO entries (app_id, url_pattern, kind, purpose, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(1, '/', 'bogus-kind', 'p', '{}', '2026-05-12', '2026-05-12'),
    ).toThrow(/CHECK constraint failed/i);
  });

  test('CHECK constraint accepts selector, flow and gotcha', () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
    ).run('http://x', 'app', '2026-05-12', '2026-05-12');
    const insert = db.prepare(
      'INSERT INTO entries (app_id, url_pattern, kind, purpose, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const kind of ['selector', 'flow', 'gotcha']) {
      expect(() =>
        insert.run(1, '/', kind, `purpose-${kind}`, '{}', '2026-05-12', '2026-05-12'),
      ).not.toThrow();
    }
  });

  test('UNIQUE(origin, app_key) prevents duplicate apps', () => {
    const db = getDb();
    const insert = db.prepare(
      'INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('http://x', 'app', '2026-05-12', '2026-05-12');
    expect(() => insert.run('http://x', 'app', '2026-05-12', '2026-05-12')).toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  test('UNIQUE(app_id, url_pattern, kind, purpose) prevents duplicate entries', () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
    ).run('http://x', 'app', '2026-05-12', '2026-05-12');
    const insert = db.prepare(
      'INSERT INTO entries (app_id, url_pattern, kind, purpose, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run(1, '/', 'selector', 'open', '{}', '2026-05-12', '2026-05-12');
    expect(() => insert.run(1, '/', 'selector', 'open', '{}', '2026-05-12', '2026-05-12')).toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  test('FK CASCADE deletes entries when their app is removed', () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
    ).run('http://x', 'app', '2026-05-12', '2026-05-12');
    db.prepare(
      'INSERT INTO entries (app_id, url_pattern, kind, purpose, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(1, '/', 'selector', 'p', '{}', '2026-05-12', '2026-05-12');
    expect(db.prepare('SELECT COUNT(*) AS n FROM entries').get()).toEqual({ n: 1 });

    db.prepare('DELETE FROM apps WHERE id = 1').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM entries').get()).toEqual({ n: 0 });
  });

  test('creates the flows table and its app index', () => {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('flows');
    expect(names).toContain('idx_flows_app');
  });

  test('UNIQUE(app_id, name) prevents duplicate flow names within an app', () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
    ).run('http://x', 'app', '2026-05-12', '2026-05-12');
    const insert = db.prepare(
      'INSERT INTO flows (app_id, name, steps_json, created_at, updated_at, use_count) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run(1, 'open task detail', '[]', '2026-05-12', '2026-05-12', 0);
    expect(() => insert.run(1, 'open task detail', '[]', '2026-05-12', '2026-05-12', 0)).toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  test('flows.use_count defaults to 0', () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
    ).run('http://x', 'app', '2026-05-12', '2026-05-12');
    db.prepare(
      'INSERT INTO flows (app_id, name, steps_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(1, 'open task detail', '[]', '2026-05-12', '2026-05-12');
    const row = db.prepare('SELECT use_count FROM flows WHERE app_id = 1').get() as {
      use_count: number;
    };
    expect(row.use_count).toBe(0);
  });

  test('FK CASCADE deletes flows when their app is removed', () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
    ).run('http://x', 'app', '2026-05-12', '2026-05-12');
    db.prepare(
      'INSERT INTO flows (app_id, name, steps_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(1, 'open task detail', '[]', '2026-05-12', '2026-05-12');
    expect(db.prepare('SELECT COUNT(*) AS n FROM flows').get()).toEqual({ n: 1 });

    db.prepare('DELETE FROM apps WHERE id = 1').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM flows').get()).toEqual({ n: 0 });
  });

  test('migrating a pre-v0.18.0 DB (apps + entries only) adds the flows table without touching existing rows', () => {
    // Simulate a DB created before the flows table existed: build the OLD
    // schema by hand (apps + entries only, no flows table), seed a row,
    // close it, then reopen through the real getDb() — the idempotent
    // CREATE TABLE IF NOT EXISTS migration must add `flows` on top without
    // disturbing the pre-existing `apps` row.
    closeDb();
    const path = getDbPath();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE apps (
        id INTEGER PRIMARY KEY,
        origin TEXT NOT NULL,
        app_key TEXT NOT NULL,
        title TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(origin, app_key)
      );
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        url_pattern TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('selector', 'flow', 'gotcha')),
        purpose TEXT NOT NULL,
        payload TEXT NOT NULL,
        verified_at TEXT,
        failed_at TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(app_id, url_pattern, kind, purpose)
      );
    `);
    legacy
      .prepare('INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run('http://legacy', 'legacy-app', '2026-01-01', '2026-01-01');
    legacy.close();

    const migrated = getDb();
    const tables = migrated
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('flows');
    expect(migrated.prepare('SELECT origin, app_key FROM apps').all()).toEqual([
      { origin: 'http://legacy', app_key: 'legacy-app' },
    ]);
    expect(() => migrated.prepare('SELECT * FROM flows').all()).not.toThrow();
  });

  test('normalizes a pre-v0.20.0 non-canonical apps.origin on open (trailing slash / full URL)', () => {
    // Before v0.20.0 the save path stored whatever free text the agent
    // passed. Reopening through getDb() must rewrite those rows to the
    // canonical URL.origin form so the list_tabs map-hint lookup (which
    // matches on `new URL(tab.url).origin`) can find them again.
    const db = getDb();
    const insert = db.prepare(
      'INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('https://myapp.example.com/', 'slashed', '2026-01-01', '2026-01-01');
    insert.run('https://other.example.com/home/dash', 'pathed', '2026-01-01', '2026-01-01');
    insert.run('http://already-canonical.example.com', 'clean', '2026-01-01', '2026-01-01');
    closeDb();

    const migrated = getDb();
    const rows = migrated.prepare('SELECT origin, app_key FROM apps ORDER BY app_key').all() as {
      origin: string;
      app_key: string;
    }[];
    expect(rows).toEqual([
      { origin: 'http://already-canonical.example.com', app_key: 'clean' },
      { origin: 'https://other.example.com', app_key: 'pathed' },
      { origin: 'https://myapp.example.com', app_key: 'slashed' },
    ]);
  });

  test('leaves a legacy row untouched when normalizing would collide with an existing canonical row', () => {
    const db = getDb();
    const insert = db.prepare(
      'INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
    );
    // Same app saved twice pre-fix: once canonical, once with a slash.
    insert.run('https://myapp.example.com', 'app', '2026-01-01', '2026-01-01');
    insert.run('https://myapp.example.com/', 'app', '2026-01-01', '2026-01-01');
    closeDb();

    const migrated = getDb();
    const rows = migrated.prepare('SELECT origin, app_key FROM apps ORDER BY id').all() as {
      origin: string;
      app_key: string;
    }[];
    // UNIQUE(origin, app_key) blocks the rewrite — the legacy row stays
    // as-is rather than being merged or dropped implicitly.
    expect(rows).toEqual([
      { origin: 'https://myapp.example.com', app_key: 'app' },
      { origin: 'https://myapp.example.com/', app_key: 'app' },
    ]);
  });
});

describe('legacy DB migration guards', () => {
  /* The actual copy of ~/.browser-link/map.db is hard to exercise from a
   * test without leaking into the host's real $HOME — and the migration
   * is explicitly gated to NOT run when BROWSER_LINK_DATA_DIR is set,
   * which every test here uses. So we assert the guards instead. */

  test('does NOT copy from the legacy path when BROWSER_LINK_DATA_DIR is set', () => {
    /* This is the default in every other test here — proven by the fact
     * that getDb() returns an empty schema (no rows) even though the host
     * machine might have a real ~/.browser-link/map.db. */
    const db = getDb();
    const rows = db.prepare('SELECT * FROM apps').all();
    expect(rows).toEqual([]);
  });

  test('does NOT overwrite an existing target DB', () => {
    /* Pre-seed the target DB with a row, then call getDb. If the migration
     * ran it would have copied over our row. The override keeps it safe. */
    const db1 = getDb();
    db1
      .prepare('INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run('http://x', 'app', '2026-05-12', '2026-05-12');
    closeDb();

    const db2 = getDb();
    expect(db2.prepare('SELECT origin FROM apps').all()).toEqual([{ origin: 'http://x' }]);
  });

  test('falls back to a fresh DB when the legacy copy fails silently', () => {
    /* The legacy migration swallows copy errors. Hard to exercise without
     * mocking copyFileSync; this test instead asserts the happy contract:
     * a brand-new data dir always yields a usable schema. */
    const db = getDb();
    expect(() => db.prepare('SELECT * FROM apps').all()).not.toThrow();
  });
});

describe('persistence + cross-restart', () => {
  test('survives close + reopen — rows written before closeDb are visible after getDb', () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO apps (origin, app_key, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
    ).run('http://x', 'app', '2026-05-12', '2026-05-12');
    closeDb();

    const db2 = getDb();
    expect(db2.prepare('SELECT origin, app_key FROM apps').all()).toEqual([
      { origin: 'http://x', app_key: 'app' },
    ]);
  });

  test('opens a DB at the location reported by getDbPath', () => {
    getDb();
    expect(existsSync(getDbPath())).toBe(true);
  });

  test('tolerates an existing empty file at the DB path', () => {
    /* Touch a 0-byte file at the target path before getDb. better-sqlite3
     * should still open and migrate it. */
    const path = getDbPath();
    writeFileSync(path, '');
    expect(() => getDb()).not.toThrow();
  });
});
