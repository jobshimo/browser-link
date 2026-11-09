import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeActivityDb, getActivityDb } from './db.js';
import { query } from './queries.js';

/**
 * The schema as it shipped before `flag` / `agent_id` existed, verbatim. A
 * user upgrading carries a file built from exactly this statement, so the
 * migration is tested against it rather than against today's bootstrap.
 */
const PREVIOUS_SCHEMA = `
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
`;

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-activity-migration-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
  const legacy = new Database(join(dataDir, 'activity.db'));
  legacy.exec(PREVIOUS_SCHEMA);
  legacy
    .prepare(
      `INSERT INTO activity (at, tool, tab_id, transport, url, title, agent, agent_pid,
         selector, payload, outcome, error, duration_ms, flow_id)
       VALUES ('2026-11-01T10:00:00.000Z', 'browser.click', 'tab_1', 'extension',
         'https://example.com/a', 'A', 'claude-code', 7, '#legacy', NULL, 'error',
         'boom', 12, NULL)`,
    )
    .run();
  legacy.close();
});

afterEach(() => {
  closeActivityDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function columns(): string[] {
  return (getActivityDb().prepare('PRAGMA table_info(activity)').all() as { name: string }[]).map(
    (c) => c.name,
  );
}

describe('activity schema migration', () => {
  test('a file from the previous schema gains flag and agent_id, once, across reopens', () => {
    expect(columns()).toEqual(expect.arrayContaining(['flag', 'agent_id']));
    closeActivityDb();
    // The second open must not try to add the columns again (SQLite would
    // throw "duplicate column name") and must not duplicate them.
    const after = columns();
    expect(after.filter((c) => c === 'flag')).toHaveLength(1);
    expect(after.filter((c) => c === 'agent_id')).toHaveLength(1);
  });

  test('existing rows survive untouched and read back with flag = null', () => {
    getActivityDb();
    closeActivityDb();
    const { records, total } = query();
    expect(total).toBe(1);
    expect(records[0]).toMatchObject({
      selector: '#legacy',
      outcome: 'error',
      error: 'boom',
      agent: 'claude-code',
      flag: null,
      agentId: null,
    });
  });

  test('the new columns are indexed for the report', () => {
    const indexes = (
      getActivityDb().prepare('PRAGMA index_list(activity)').all() as { name: string }[]
    ).map((i) => i.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_activity_flag', 'idx_activity_agent_id']));
  });
});

/** The 0.44 schema: the first one plus `flag` and `agent_id`, as an
 * installed 0.44.x left the file. */
const SCHEMA_0_44 = `${PREVIOUS_SCHEMA}
  ALTER TABLE activity ADD COLUMN flag TEXT;
  ALTER TABLE activity ADD COLUMN agent_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_activity_flag ON activity(flag);
  CREATE INDEX IF NOT EXISTS idx_activity_agent_id ON activity(agent_id);
`;

describe('activity schema migration — result_bytes (0.45.0)', () => {
  beforeEach(() => {
    // Replace the pre-flag fixture with a 0.44 file.
    rmSync(join(dataDir, 'activity.db'), { force: true });
    const legacy = new Database(join(dataDir, 'activity.db'));
    legacy.exec(SCHEMA_0_44);
    legacy
      .prepare(
        `INSERT INTO activity (at, tool, tab_id, transport, url, title, agent, agent_pid,
           selector, payload, outcome, error, duration_ms, flow_id, flag, agent_id)
         VALUES ('2026-11-08T10:00:00.000Z', 'browser.evaluate', 'tab_1', 'extension',
           'https://example.com/a', 'A', 'claude-code', 7, NULL, 'document.title', 'ok',
           NULL, 12, NULL, NULL, 's-1')`,
      )
      .run();
    legacy.close();
  });

  test('a 0.44 file gains result_bytes once, across reopens', () => {
    expect(columns()).toContain('result_bytes');
    closeActivityDb();
    expect(columns().filter((c) => c === 'result_bytes')).toHaveLength(1);
    closeActivityDb();
    expect(columns().filter((c) => c === 'result_bytes')).toHaveLength(1);
  });

  test('stored 0.44 rows survive untouched and read back resultBytes = null', () => {
    const { records, total } = query();
    expect(total).toBe(1);
    expect(records[0]).toMatchObject({
      tool: 'browser.evaluate',
      payload: 'document.title',
      agentId: 's-1',
      resultBytes: null,
    });
  });
});
