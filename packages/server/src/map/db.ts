import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getDbPath } from './paths.js';

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
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
