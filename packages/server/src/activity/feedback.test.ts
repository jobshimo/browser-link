import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { closeActivityDb, getActivityDb } from './db.js';
import { FEEDBACK_TEXT_MAX, listFeedback, recordFeedback } from './feedback.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-feedback-test-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeActivityDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('feedback table', () => {
  test('is created next to the activity table with the agreed columns', () => {
    const db = getActivityDb();
    const columns = (db.prepare('PRAGMA table_info(feedback)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toEqual([
      'id',
      'at',
      'tool',
      'observed',
      'expected',
      'agent_id',
      'origin',
      'build',
    ]);
  });

  test('the migration is idempotent and keeps stored rows on reopen', () => {
    const db = getActivityDb();
    recordFeedback(db, { tool: 'browser.find', observed: 'a', expected: 'b' });
    closeActivityDb();
    const again = getActivityDb();
    expect(listFeedback(again)).toHaveLength(1);
  });

  test('an activity.db created before the table existed gains it on open', () => {
    const path = join(dataDir, 'activity.db');
    const old = new Database(path);
    old.exec(`CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
      tool TEXT NOT NULL, tab_id TEXT, transport TEXT, url TEXT, title TEXT, agent TEXT,
      agent_pid INTEGER, selector TEXT, payload TEXT, outcome TEXT NOT NULL, error TEXT,
      duration_ms INTEGER NOT NULL, flow_id TEXT)`);
    old.close();
    const db = getActivityDb();
    expect(recordFeedback(db, { tool: 't', observed: 'o', expected: 'e' }).id).toBe(1);
  });
});

describe('recordFeedback', () => {
  test('stores every field and returns the new id', () => {
    const db = getActivityDb();
    const { id } = recordFeedback(db, {
      tool: 'browser.click',
      observed: 'ok: true but nothing changed',
      expected: 'an error when the click lands nowhere',
      agentId: 'session-1',
      origin: 'https://example.com',
      build: '3f9a',
    });
    expect(id).toBe(1);
    const [row] = listFeedback(db);
    expect(row).toMatchObject({
      id: 1,
      tool: 'browser.click',
      observed: 'ok: true but nothing changed',
      expected: 'an error when the click lands nowhere',
      agentId: 'session-1',
      origin: 'https://example.com',
      build: '3f9a',
    });
    expect(Number.isNaN(Date.parse(row!.at))).toBe(false);
  });

  test('optional fields default to null', () => {
    const db = getActivityDb();
    recordFeedback(db, { tool: 'browser.find', observed: 'o', expected: 'e' });
    expect(listFeedback(db)[0]).toMatchObject({ agentId: null, origin: null, build: null });
  });

  test('rejects an empty tool, observed or expected', () => {
    const db = getActivityDb();
    expect(() => recordFeedback(db, { tool: ' ', observed: 'o', expected: 'e' })).toThrow(/tool/);
    expect(() => recordFeedback(db, { tool: 't', observed: '', expected: 'e' })).toThrow(
      /observed/,
    );
    expect(() => recordFeedback(db, { tool: 't', observed: 'o', expected: '  ' })).toThrow(
      /expected/,
    );
    expect(listFeedback(db)).toEqual([]);
  });

  test('caps long text so one entry cannot bloat the database', () => {
    const db = getActivityDb();
    recordFeedback(db, { tool: 't', observed: 'x'.repeat(FEEDBACK_TEXT_MAX + 50), expected: 'e' });
    expect(listFeedback(db)[0]!.observed.length).toBeLessThanOrEqual(FEEDBACK_TEXT_MAX);
  });
});

describe('listFeedback', () => {
  test('returns newest first, honours limit and sinceId', () => {
    const db = getActivityDb();
    for (const n of [1, 2, 3]) recordFeedback(db, { tool: `t${n}`, observed: 'o', expected: 'e' });
    expect(listFeedback(db).map((r) => r.id)).toEqual([3, 2, 1]);
    expect(listFeedback(db, { limit: 2 }).map((r) => r.id)).toEqual([3, 2]);
    expect(listFeedback(db, { sinceId: 1 }).map((r) => r.id)).toEqual([3, 2]);
  });
});
