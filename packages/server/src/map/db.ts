import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getDbPath } from './paths.js';
import { canonicalOrigin } from './origin.js';

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  const path = getDbPath();
  mkdirSync(dirname(path), { recursive: true });
  migrateLegacyDb(path);
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  dbInstance = db;
  return db;
}

/**
 * Older versions of browser-link stored the map at ~/.browser-link/map.db.
 * On first boot with the new XDG/per-OS path, copy the legacy file over so
 * a user upgrading does not lose what they had learned.
 *
 * Only runs when the data dir was NOT overridden via BROWSER_LINK_DATA_DIR.
 * Portable installs and tests that point to a custom dir should start empty.
 */
function migrateLegacyDb(targetPath: string): void {
  if (process.env.BROWSER_LINK_DATA_DIR && process.env.BROWSER_LINK_DATA_DIR.trim().length > 0) {
    return;
  }
  if (existsSync(targetPath)) return;
  const legacy = join(homedir(), '.browser-link', 'map.db');
  if (!existsSync(legacy)) return;
  try {
    copyFileSync(legacy, targetPath);
  } catch {
    // If the copy fails we silently fall back to a fresh DB.
  }
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS apps (
      id INTEGER PRIMARY KEY,
      origin TEXT NOT NULL,
      app_key TEXT NOT NULL,
      title TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(origin, app_key)
    );

    CREATE TABLE IF NOT EXISTS entries (
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

    CREATE INDEX IF NOT EXISTS idx_entries_lookup ON entries(app_id, url_pattern);
  `);

  // v0.18.0: named, replayable browser.flow recipes per app. Deliberately a
  // separate table from `entries` — the pre-existing `entries.kind='flow'`
  // is a free-form payload with no shape guarantee, while a row here always
  // holds a `steps_json` array validated against the EXACT browser.flow step
  // grammar (see `validateFlowSteps` in tools/browser-dispatch.ts, reused by
  // map/tools.ts). Not scoped by url_pattern like entries — a flow recipe
  // is identified by (app, name) only, since a multi-step recipe is not
  // tied to a single route the way a selector or gotcha usually is.
  // Same idempotent CREATE-TABLE-IF-NOT-EXISTS pattern as above, so an
  // existing DB from before this table existed picks it up on next getDb()
  // without touching any pre-existing row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS flows (
      id INTEGER PRIMARY KEY,
      app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      steps_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(app_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_flows_app ON flows(app_id);
  `);

  // Mechanisms and pitfalls: what an app does underneath ("a GET of the item
  // URL completes it") and what does NOT work ("click on the next link
  // returns ok but never navigates"). A separate table, not new values for
  // entries.kind: that column has a CHECK constraint, and SQLite cannot
  // alter a CHECK in place — widening it means rebuilding `entries` (copy,
  // drop, rename), which is exactly the kind of rewrite the user's map must
  // never go through. Additive CREATE-IF-NOT-EXISTS, same pattern as
  // `flows`: an older DB picks it up on next open and no existing row is
  // touched. Identified by (app, kind, key) — a stable slug, like a flow name.
  db.exec(`
    CREATE TABLE IF NOT EXISTS insights (
      id INTEGER PRIMARY KEY,
      app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('mechanism', 'pitfall')),
      key TEXT NOT NULL,
      description TEXT NOT NULL,
      symptom TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(app_id, kind, key)
    );

    CREATE INDEX IF NOT EXISTS idx_insights_app ON insights(app_id);
  `);

  // v0.43.0: what the map learned from use, with no bookkeeping by the agent
  // (see map/learning.ts). One row per durable target (a CSS selector or a
  // `browser.find` semantic key, never typed text or values) per action per
  // route, with ok/fail counters. Additive CREATE-IF-NOT-EXISTS like every
  // table above: an older DB picks it up on next open, no row is rewritten.
  // `last_reason` holds a fixed enum (`LEARNED_REASONS` in learning.ts),
  // enforced in code rather than by a CHECK, so widening the enum later
  // never means rebuilding this table (see the `insights` comment).
  db.exec(`
    CREATE TABLE IF NOT EXISTS selector_outcomes (
      id INTEGER PRIMARY KEY,
      app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      url_pattern TEXT NOT NULL,
      target TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('selector', 'key')),
      action TEXT NOT NULL,
      ok_n INTEGER NOT NULL DEFAULT 0,
      fail_n INTEGER NOT NULL DEFAULT 0,
      last_reason TEXT,
      last_ok_at TEXT,
      last_fail_at TEXT,
      UNIQUE(app_id, url_pattern, target, target_kind, action)
    );

    CREATE INDEX IF NOT EXISTS idx_selector_outcomes_app ON selector_outcomes(app_id);
  `);

  // v0.45.0 (knowledge-loop): what was observed, on which build and screen.
  // `view_sig` is the screen the target was last used on; `last_ok_build` /
  // `last_fail_build` the build fingerprints of the last success and failure;
  // `struct_fail_n` counts failures that count as structural (see
  // confidence.ts) on `struct_fail_build` since the row last worked, which
  // is what `failing` is computed from. Added with a guarded ALTER, never a
  // table rebuild, so every existing row and counter is kept as is.
  addColumnIfMissing(db, 'selector_outcomes', 'view_sig', 'TEXT');
  addColumnIfMissing(db, 'selector_outcomes', 'last_ok_build', 'TEXT');
  addColumnIfMissing(db, 'selector_outcomes', 'last_fail_build', 'TEXT');
  addColumnIfMissing(db, 'selector_outcomes', 'struct_fail_n', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'selector_outcomes', 'struct_fail_build', 'TEXT');

  // v0.45.0: every build fingerprint an app was seen running (the hash of
  // its script and stylesheet URLs, computed in the page by the observer),
  // with when it was first and last seen. Lets confidence tell "worked on
  // this build" from "worked on an older one".
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_builds (
      id INTEGER PRIMARY KEY,
      app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(app_id, fingerprint)
    );
  `);

  // v0.45.0: the append-only registry of `browser.evaluate` expressions
  // (read and written by map/readers.ts). `status` changes only through the
  // agent's explicit curation; nothing here rewrites an expression.
  db.exec(`
    CREATE TABLE IF NOT EXISTS js_readers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      hash TEXT NOT NULL,
      expression TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('reader','mutation')),
      name TEXT,
      ok_n INTEGER NOT NULL DEFAULT 0,
      fail_n INTEGER NOT NULL DEFAULT 0,
      last_ok_at TEXT,
      last_fail_at TEXT,
      last_ok_build TEXT,
      result_bytes_avg INTEGER,
      flags TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','kept','dropped')),
      created_at TEXT NOT NULL,
      UNIQUE(app_id, hash)
    );

    CREATE INDEX IF NOT EXISTS idx_js_readers_app ON js_readers(app_id, status);
  `);

  // v0.20.0: normalize apps.origin rows written before the write path
  // canonicalized origins (see origin.ts). Before this release, save
  // stored whatever free text the agent passed ("https://x.com/" with a
  // trailing slash, a full URL with a path), while the list_tabs map-hint
  // lookup — and now every lookup — matches on the canonical
  // `new URL(...).origin` form. Legacy rows would never match again
  // without this pass. Idempotent and cheap (the map holds tens of apps,
  // not thousands; already-canonical rows are skipped), so it simply runs
  // on every open alongside the CREATE-IF-NOT-EXISTS migrations above.
  // A row whose canonical form collides with an existing (origin, app_key)
  // row is left untouched rather than merged — dropping or merging rows
  // implicitly is worse than leaving one legacy row unreachable by hint
  // lookups (recall by explicit app listing still shows it).
  const legacyRows = db.prepare('SELECT id, origin FROM apps').all() as {
    id: number;
    origin: string;
  }[];
  for (const row of legacyRows) {
    const canonical = canonicalOrigin(row.origin);
    if (canonical === row.origin) continue;
    try {
      db.prepare('UPDATE apps SET origin = ? WHERE id = ?').run(canonical, row.id);
    } catch {
      // UNIQUE(origin, app_key) collision with an already-canonical row.
    }
  }
}

/**
 * `ALTER TABLE <table> ADD COLUMN <column> <definition>` only when the
 * column is not there yet, so every open of the DB runs it safely. Adding a
 * column is the one schema change SQLite does in place: no row is copied or
 * rewritten. Table and column names come from this module, never from input.
 */
export function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
