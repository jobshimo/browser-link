import Database from 'better-sqlite3';
import { chmodSync, closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { getActivityDbPath } from './paths.js';

let dbInstance: Database.Database | null = null;

/**
 * Rows kept before the oldest are pruned.
 *
 * Sized so a heavy day of agent work never evicts the morning: a `repeat`
 * flow can dispatch a few hundred actions in one call, so a 200-row ceiling
 * like `BridgeEventLog`'s would make the trail useless for exactly the runs
 * worth auditing. 50k rows is a few tens of MB at this row width — cheap for
 * a file on disk, and unlike the in-memory event log nothing here competes
 * with the process's working set.
 */
export const MAX_ACTIVITY_ROWS = 50_000;

/**
 * How many inserts between prune sweeps.
 *
 * Pruning on every insert would run a DELETE with a subquery on the hot path
 * of every single agent action. Pruning on a counter means the table can
 * briefly exceed `MAX_ACTIVITY_ROWS` by at most this much, which costs
 * nothing and keeps the write path a single INSERT.
 */
const PRUNE_INTERVAL = 500;

let insertsSincePrune = 0;

export function getActivityDb(): Database.Database {
  if (dbInstance) return dbInstance;
  const path = getActivityDbPath();
  mkdirSync(dirname(path), { recursive: true });
  restrictToOwner(path);
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  dbInstance = db;
  return db;
}

/** Owner read/write only. */
const OWNER_ONLY = 0o600;

/**
 * Keep the trail readable by its owner only, on POSIX: the file is created
 * 0600 when it does not exist yet, and an existing file (or WAL / shared
 * memory file) this process owns is tightened to 0600. SQLite creates the
 * `-wal` and `-shm` files with the database file's mode, so a 0600
 * database keeps them 0600 too. A file owned by another user is left
 * alone, and so is every stored row: only the mode changes.
 *
 * A no-op on Windows, where Node maps the mode to the read-only flag and
 * nothing else; access there follows the data directory's ACL, which
 * already belongs to the user.
 *
 * Best effort: a filesystem that refuses chmod must not stop the trail.
 */
function restrictToOwner(path: string): void {
  if (process.platform === 'win32') return;
  try {
    closeSync(openSync(path, 'a', OWNER_ONLY));
  } catch {
    return;
  }
  const uid = process.getuid?.();
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const stat = statSync(file);
      if (stat.uid === uid && (stat.mode & 0o777) !== OWNER_ONLY) chmodSync(file, OWNER_ONLY);
    } catch {
      // Absent (no WAL yet) or unreadable: nothing to tighten.
    }
  }
}

function runMigrations(db: Database.Database): void {
  // Same idempotent CREATE-IF-NOT-EXISTS pattern as map/db.ts: an existing
  // file from an earlier version picks up new tables on next open without
  // touching a single stored row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      tool TEXT NOT NULL,
      tab_id TEXT,
      transport TEXT CHECK (transport IN ('extension', 'cdp')),
      url TEXT,
      title TEXT,
      agent TEXT,
      agent_pid INTEGER,
      selector TEXT,
      payload TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error')),
      error TEXT,
      duration_ms INTEGER NOT NULL,
      flow_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at);
    CREATE INDEX IF NOT EXISTS idx_activity_tab ON activity(tab_id);
    CREATE INDEX IF NOT EXISTS idx_activity_flow ON activity(flow_id);
    CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity(agent);
  `);

  // Columns added after the table first shipped. `ADD COLUMN` has no
  // IF NOT EXISTS form, so each one is guarded by `table_info`: a reopen is a
  // no-op, and an upgraded file keeps every stored row exactly as it was —
  // the new columns read back NULL for history, never a guessed value.
  // Nullable with no CHECK on purpose: SQLite cannot alter a CHECK later, so
  // the closed `flag` enum is enforced by `record` (see `ACTIVITY_FLAGS`).
  const present = new Set(
    (db.prepare('PRAGMA table_info(activity)').all() as { name: string }[]).map((c) => c.name),
  );
  for (const [column, ddl] of [
    ['flag', 'ALTER TABLE activity ADD COLUMN flag TEXT'],
    ['agent_id', 'ALTER TABLE activity ADD COLUMN agent_id TEXT'],
    ['result_bytes', 'ALTER TABLE activity ADD COLUMN result_bytes INTEGER'],
  ] as const) {
    if (!present.has(column)) db.exec(ddl);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_activity_flag ON activity(flag);
    CREATE INDEX IF NOT EXISTS idx_activity_agent_id ON activity(agent_id);
  `);

  // Agent feedback about the tool itself (`browser.feedback`, `wrap_up`).
  // Its own table, never pruned with the trail: an entry stays until the
  // owner turns it into an issue or clears the file. Read by
  // `browser-link feedback` (see `feedback.ts`).
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      tool TEXT NOT NULL,
      observed TEXT NOT NULL,
      expected TEXT NOT NULL,
      agent_id TEXT,
      origin TEXT,
      build TEXT
    );
  `);
}

/**
 * AUTOINCREMENT on the primary key is deliberate, and it is the reason the
 * `sinceId` cursor is safe.
 *
 * Without it SQLite reuses the rowids of deleted rows, so pruning the oldest
 * rows could hand a NEW row an id a tailing panel had already seen and
 * skipped past — the panel would silently never render it. AUTOINCREMENT
 * costs one extra table (`sqlite_sequence`) and buys a monotonic cursor that
 * survives pruning.
 */
export function pruneIfDue(db: Database.Database, force = false): number {
  insertsSincePrune += 1;
  if (!force && insertsSincePrune < PRUNE_INTERVAL) return 0;
  insertsSincePrune = 0;
  const result = db
    .prepare(
      `DELETE FROM activity WHERE id <= (
         SELECT MAX(id) FROM activity
       ) - ?`,
    )
    .run(MAX_ACTIVITY_ROWS);
  return result.changes;
}

/** Close and forget the handle. Tests use this between temp data dirs; the
 * CLI uses it so a `clear --vacuum` is not fighting its own open WAL. */
export function closeActivityDb(): void {
  if (!dbInstance) return;
  dbInstance.close();
  dbInstance = null;
  insertsSincePrune = 0;
}
