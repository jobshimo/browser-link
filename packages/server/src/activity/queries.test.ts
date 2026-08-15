import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeActivityDb, getActivityDb, MAX_ACTIVITY_ROWS, pruneIfDue } from './db.js';
import {
  clear,
  countInRange,
  exportAll,
  listAgents,
  MAX_QUERY_LIMIT,
  MAX_TEXT_LEN,
  purgeRange,
  query,
  record,
  redact,
  stats,
  truncate,
} from './queries.js';
import type { ActivityInput } from './types.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-activity-test-'));
  process.env.BROWSER_LINK_DATA_DIR = dataDir;
});

afterEach(() => {
  closeActivityDb();
  delete process.env.BROWSER_LINK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function row(over: Partial<ActivityInput> = {}): ActivityInput {
  return {
    tool: 'browser.click',
    tabId: 'tab_1',
    transport: 'extension',
    url: 'https://example.com/checkout',
    title: 'Checkout',
    agent: 'claude-code',
    agentPid: 4242,
    selector: '#submit',
    payload: null,
    outcome: 'ok',
    error: null,
    durationMs: 12,
    flowId: null,
    ...over,
  };
}

describe('bootstrap', () => {
  test('creates activity.db beside map.db, not inside it', () => {
    getActivityDb();
    expect(existsSync(join(dataDir, 'activity.db'))).toBe(true);
    // The map DB must NOT be created as a side effect — the two files have
    // independent lifecycles and one must never drag the other into being.
    expect(existsSync(join(dataDir, 'map.db'))).toBe(false);
  });

  test('getActivityDb is a singleton until closed', () => {
    expect(getActivityDb()).toBe(getActivityDb());
    closeActivityDb();
    // A fresh handle after close is a different object but the same file.
    expect(getActivityDb()).toBeDefined();
  });
});

describe('record', () => {
  test('assigns a monotonic id and an ISO timestamp', () => {
    const a = record(row());
    const b = record(row());
    expect(a?.id).toBeGreaterThan(0);
    expect(b?.id).toBe((a?.id ?? 0) + 1);
    expect(a?.at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  test('round-trips every column', () => {
    record(row({ payload: 'hunter2', flowId: 'flow_x', outcome: 'error', error: 'boom' }));
    const [stored] = query().records;
    expect(stored).toMatchObject({
      tool: 'browser.click',
      tabId: 'tab_1',
      transport: 'extension',
      url: 'https://example.com/checkout',
      agent: 'claude-code',
      agentPid: 4242,
      selector: '#submit',
      payload: 'hunter2',
      outcome: 'error',
      error: 'boom',
      flowId: 'flow_x',
    });
  });

  test('never throws — a broken sink loses the row, not the action', () => {
    // A closed handle is the deterministic stand-in for "the store is
    // unavailable" (disk full, DB locked, file removed under us). Platform
    // -independent, unlike poisoning the data-dir path.
    const broken = getActivityDb();
    closeActivityDb();
    expect(() => record(row(), broken)).not.toThrow();
    expect(record(row(), broken)).toBeNull();
  });

  test('negative or fractional durations are stored as sane integers', () => {
    record(row({ durationMs: -5 }));
    record(row({ durationMs: 12.7 }));
    const durations = query().records.map((r) => r.durationMs);
    expect(durations).toContain(0);
    expect(durations).toContain(13);
  });
});

describe('truncate', () => {
  test('leaves short values untouched and marks long ones', () => {
    expect(truncate('short')).toBe('short');
    expect(truncate(null)).toBeNull();
    const long = 'x'.repeat(MAX_TEXT_LEN + 100);
    const cut = truncate(long);
    expect(cut).toHaveLength(MAX_TEXT_LEN);
    expect(cut?.endsWith('…[truncated]')).toBe(true);
  });

  test('a huge evaluate expression is stored truncated, not dropped', () => {
    record(row({ tool: 'browser.evaluate', payload: 'y'.repeat(50_000) }));
    const [stored] = query().records;
    expect(stored.payload).toHaveLength(MAX_TEXT_LEN);
  });
});

describe('query', () => {
  test('returns newest first', () => {
    record(row({ selector: '#first' }));
    record(row({ selector: '#second' }));
    expect(query().records.map((r) => r.selector)).toEqual(['#second', '#first']);
  });

  test('reports the unfiltered total alongside a limited page', () => {
    for (let i = 0; i < 5; i += 1) record(row());
    const page = query({ limit: 2 });
    expect(page.records).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  test('total respects the filter it is shown next to', () => {
    record(row({ agent: 'claude-code' }));
    record(row({ agent: 'opencode' }));
    record(row({ agent: 'opencode' }));
    expect(query({ agent: 'opencode' }).total).toBe(2);
  });

  test.each([
    ['tabId', { tabId: 'tab_9' }, { tabId: 'tab_9' }],
    ['tool', { tool: 'browser.type' }, { tool: 'browser.type' }],
    ['flowId', { flowId: 'flow_z' }, { flowId: 'flow_z' }],
    ['outcome', { outcome: 'error' as const, error: 'x' }, { outcome: 'error' as const }],
  ])('filters by %s', (_label, stored, filter) => {
    record(row());
    record(row(stored));
    const page = query(filter);
    expect(page.records).toHaveLength(1);
    expect(page.total).toBe(1);
  });

  test('limit is clamped to MAX_QUERY_LIMIT', () => {
    record(row());
    expect(query({ limit: 99_999 }).records.length).toBeLessThanOrEqual(MAX_QUERY_LIMIT);
  });

  test('sinceId tails without re-reading', () => {
    const first = record(row());
    const cursor = query().latestId;
    expect(cursor).toBe(first?.id);
    record(row({ selector: '#new' }));
    const page = query({ sinceId: cursor });
    expect(page.records.map((r) => r.selector)).toEqual(['#new']);
  });

  test('an empty tail page keeps the cursor instead of rewinding to 0', () => {
    record(row());
    const cursor = query().latestId;
    // Nothing new since — the caller must not be told to start over, or it
    // would re-render the whole trail on every idle poll.
    expect(query({ sinceId: cursor }).latestId).toBe(cursor);
  });

  test('beforeId pages backwards through history', () => {
    const a = record(row({ selector: '#a' }));
    record(row({ selector: '#b' }));
    const older = query({ beforeId: (a?.id ?? 0) + 1 });
    expect(older.records.map((r) => r.selector)).toEqual(['#a']);
  });
});

describe('listAgents', () => {
  test('groups and counts, most recently seen first', () => {
    record(row({ agent: 'opencode' }));
    record(row({ agent: 'claude-code' }));
    record(row({ agent: 'claude-code' }));
    expect(listAgents()).toEqual([
      { agent: 'claude-code', count: 2 },
      { agent: 'opencode', count: 1 },
    ]);
  });

  test('ignores rows with no agent', () => {
    record(row({ agent: null }));
    expect(listAgents()).toEqual([]);
  });
});

describe('clear', () => {
  test('without a cutoff removes everything', () => {
    record(row());
    record(row());
    expect(clear()).toBe(2);
    expect(query().total).toBe(0);
  });

  test('with a cutoff removes only what is older', () => {
    record(row());
    const cutoff = new Date(Date.now() + 60_000).toISOString();
    expect(clear(cutoff)).toBe(1);
    expect(query().total).toBe(0);
  });

  test('a cutoff in the past keeps everything', () => {
    record(row());
    expect(clear(new Date(Date.now() - 60_000).toISOString())).toBe(0);
    expect(query().total).toBe(1);
  });
});

describe('pruning', () => {
  test('ids stay monotonic across a prune, so a tailing cursor never skips', () => {
    const db = getActivityDb();
    const first = record(row());
    record(row());
    // Force a sweep that would delete everything if the ceiling were 0.
    db.prepare('DELETE FROM activity').run();
    const afterPrune = record(row());
    // AUTOINCREMENT: the new row must NOT reuse the deleted row's id, or a
    // panel holding `sinceId = 2` would never render it.
    expect(afterPrune?.id).toBeGreaterThan(first?.id ?? 0);
    expect(afterPrune?.id).toBeGreaterThan(2);
  });

  test('prune is a no-op while under the ceiling', () => {
    record(row());
    expect(pruneIfDue(getActivityDb(), true)).toBe(0);
    expect(query().total).toBe(1);
  });

  test('the ceiling is large enough for a heavy repeat flow', () => {
    // A single `repeat` step can dispatch hundreds of actions; a 200-row
    // ceiling like BridgeEventLog's would evict the run being audited.
    expect(MAX_ACTIVITY_ROWS).toBeGreaterThan(10_000);
  });
});

describe('stats', () => {
  test('an empty trail reports zero rows and no span', () => {
    getActivityDb();
    const s = stats();
    expect(s.rows).toBe(0);
    expect(s.oldestAt).toBeNull();
    expect(s.newestAt).toBeNull();
    expect(s.maxRows).toBe(MAX_ACTIVITY_ROWS);
  });

  test('counts rows and reports the span between oldest and newest', () => {
    record(row());
    record(row());
    const s = stats();
    expect(s.rows).toBe(2);
    expect(s.oldestAt).not.toBeNull();
    expect(s.newestAt).not.toBeNull();
    expect(s.oldestAt! <= s.newestAt!).toBe(true);
  });

  test('bytes counts the file actually on disk', () => {
    record(row());
    expect(stats().bytes).toBeGreaterThan(0);
  });

  test('bytes includes the WAL sidecar, not just the .db', () => {
    // WAL mode parks recent writes in activity.db-wal until a checkpoint. A
    // size that ignored it would understate a busy trail badly — which is
    // exactly the trail a user is trying to judge.
    for (let i = 0; i < 200; i += 1) record(row({ payload: 'x'.repeat(500) }));
    const dbOnly = statSync(join(dataDir, 'activity.db')).size;
    expect(stats().bytes).toBeGreaterThan(dbOnly);
  });
});

describe('countInRange', () => {
  test('an empty range counts everything', () => {
    record(row());
    record(row());
    expect(countInRange({})).toBe(2);
  });

  test('a window in the future counts nothing', () => {
    record(row());
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(countInRange({ from: future })).toBe(0);
  });

  test('bounds are inclusive at both ends', () => {
    const stored = record(row());
    expect(countInRange({ from: stored!.at, to: stored!.at })).toBe(1);
  });
});

describe('purgeRange', () => {
  test('deletes only what falls inside the range', () => {
    const keep = record(row({ selector: '#keep' }));
    const cutoff = new Date(Date.now() + 1).toISOString();
    // Everything recorded so far, nothing after.
    expect(purgeRange({ to: cutoff }, { vacuum: false })).toBe(1);
    expect(query().total).toBe(0);
    expect(keep).not.toBeNull();
  });

  test('an empty range purges the whole trail', () => {
    record(row());
    record(row());
    expect(purgeRange({}, { vacuum: false })).toBe(2);
    expect(query().total).toBe(0);
  });

  test('purging nothing is a no-op, not an error', () => {
    record(row());
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(purgeRange({ from: future }, { vacuum: false })).toBe(0);
    expect(query().total).toBe(1);
  });

  test('the count a dry run promised is the count the purge delivers', () => {
    for (let i = 0; i < 5; i += 1) record(row());
    const range = { to: new Date(Date.now() + 1000).toISOString() };
    const promised = countInRange(range);
    expect(purgeRange(range, { vacuum: false })).toBe(promised);
  });

  test('ids stay monotonic after a purge, so a tailing cursor never skips', () => {
    const first = record(row());
    purgeRange({}, { vacuum: false });
    const afterPurge = record(row());
    expect(afterPurge!.id).toBeGreaterThan(first!.id);
  });

  test('vacuum reclaims disk space, which is the whole point of purging', () => {
    for (let i = 0; i < 400; i += 1) record(row({ payload: 'y'.repeat(1000) }));
    const before = stats().bytes;
    purgeRange({});
    const after = stats().bytes;
    expect(after).toBeLessThan(before);
  });
});

describe('exportAll', () => {
  test('streams oldest first — an exported file reads as a story', () => {
    record(row({ selector: '#a' }));
    record(row({ selector: '#b' }));
    expect([...exportAll()].map((r) => r.selector)).toEqual(['#a', '#b']);
  });

  test('honours the same filters as query', () => {
    record(row({ agent: 'a' }));
    record(row({ agent: 'b' }));
    expect([...exportAll({ agent: 'b' })].map((r) => r.agent)).toEqual(['b']);
  });
});

describe('redact', () => {
  test('drops payload and title but keeps the shape', () => {
    const stored = record(row({ payload: 'hunter2' }));
    const safe = redact(stored!);
    expect(safe.payload).toBe('[redacted]');
    expect(safe.title).toBe('[redacted]');
    expect(safe.selector).toBe('#submit');
    expect(safe.tool).toBe('browser.click');
    expect(safe.durationMs).toBe(12);
  });

  test('strips the query string, where tokens live, but keeps the route', () => {
    const stored = record(row({ url: 'https://app.example.com/orders?token=abc123#x' }));
    expect(redact(stored!).url).toBe('https://app.example.com/orders');
  });

  test('nulls stay null rather than becoming the literal "[redacted]"', () => {
    const stored = record(row({ payload: null, title: null, url: null }));
    const safe = redact(stored!);
    expect(safe.payload).toBeNull();
    expect(safe.title).toBeNull();
    expect(safe.url).toBeNull();
  });

  test('an unparseable url is redacted wholesale rather than leaked', () => {
    const stored = record(row({ url: 'not a url' }));
    expect(redact(stored!).url).toBe('[redacted]');
  });
});
