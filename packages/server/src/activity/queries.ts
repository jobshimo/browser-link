import type Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { getActivityDb, MAX_ACTIVITY_ROWS, pruneIfDue } from './db.js';
import { getActivityDbPath } from './paths.js';
import type {
  ActivityInput,
  ActivityPage,
  ActivityQuery,
  ActivityRecord,
  ActivityTransport,
} from './types.js';

/** Hard ceiling on rows a single read can return, whatever `limit` asks for.
 * The panel pages; nothing needs ten thousand rows in one response, and an
 * unbounded read is how a renderer freezes a browser. */
export const MAX_QUERY_LIMIT = 500;
const DEFAULT_QUERY_LIMIT = 200;

/** Longest stored `payload` / `error`. A `browser.evaluate` expression can be
 * arbitrarily long and an error can carry a page's worth of text; neither is
 * more legible at 40 KB than at 4 KB, and the trail is meant to stay
 * greppable. Truncation is marked so a reader never mistakes a cut string for
 * the whole thing. */
export const MAX_TEXT_LEN = 4_000;
const TRUNCATION_MARK = '…[truncated]';

export function truncate(value: string | null, max = MAX_TEXT_LEN): string | null {
  if (value === null) return null;
  if (value.length <= max) return value;
  return value.slice(0, max - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}

interface ActivityRow {
  id: number;
  at: string;
  tool: string;
  tab_id: string | null;
  transport: string | null;
  url: string | null;
  title: string | null;
  agent: string | null;
  agent_pid: number | null;
  selector: string | null;
  payload: string | null;
  outcome: string;
  error: string | null;
  duration_ms: number;
  flow_id: string | null;
}

function toRecord(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    at: row.at,
    tool: row.tool,
    tabId: row.tab_id,
    transport: (row.transport as ActivityTransport | null) ?? null,
    url: row.url,
    title: row.title,
    agent: row.agent,
    agentPid: row.agent_pid,
    selector: row.selector,
    payload: row.payload,
    outcome: row.outcome === 'error' ? 'error' : 'ok',
    error: row.error,
    durationMs: row.duration_ms,
    flowId: row.flow_id,
  };
}

/**
 * Append one dispatched call to the trail.
 *
 * NEVER THROWS. Recording is observation, not the work: an agent's click must
 * not fail because the disk is full or the DB is locked. The caller
 * (`browser-dispatch.ts`) treats this as fire-and-forget, and a lost row is
 * strictly better than a lost action.
 */
export function record(input: ActivityInput, db?: Database.Database): ActivityRecord | null {
  try {
    const handle = db ?? getActivityDb();
    const at = new Date().toISOString();
    const result = handle
      .prepare(
        `INSERT INTO activity
           (at, tool, tab_id, transport, url, title, agent, agent_pid,
            selector, payload, outcome, error, duration_ms, flow_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        at,
        input.tool,
        input.tabId,
        input.transport,
        truncate(input.url),
        truncate(input.title, 300),
        input.agent,
        input.agentPid,
        truncate(input.selector),
        truncate(input.payload),
        input.outcome,
        truncate(input.error),
        Math.max(0, Math.round(input.durationMs)),
        input.flowId,
      );
    pruneIfDue(handle);
    return { ...input, id: Number(result.lastInsertRowid), at };
  } catch {
    return null;
  }
}

/** Build the shared WHERE clause + bindings for a filter. Kept in one place
 * so `query` and its COUNT can never drift apart and report a total that does
 * not match the rows beside it. */
function buildFilter(q: ActivityQuery): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (q.sinceId !== undefined) {
    clauses.push('id > ?');
    params.push(q.sinceId);
  }
  if (q.beforeId !== undefined) {
    clauses.push('id < ?');
    params.push(q.beforeId);
  }
  if (q.tabId !== undefined) {
    clauses.push('tab_id = ?');
    params.push(q.tabId);
  }
  if (q.agent !== undefined) {
    clauses.push('agent = ?');
    params.push(q.agent);
  }
  if (q.tool !== undefined) {
    clauses.push('tool = ?');
    params.push(q.tool);
  }
  if (q.flowId !== undefined) {
    clauses.push('flow_id = ?');
    params.push(q.flowId);
  }
  if (q.outcome !== undefined) {
    clauses.push('outcome = ?');
    params.push(q.outcome);
  }
  if (q.since !== undefined) {
    clauses.push('at >= ?');
    params.push(q.since);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * Read a page of the trail, NEWEST FIRST.
 *
 * Newest-first is what both readers want and it is the only ordering that
 * makes `limit` honest: with oldest-first, "the last 200" would require
 * counting the whole table before choosing an offset. The window reverses the
 * page for display; the CLI prints it as-is.
 */
export function query(q: ActivityQuery = {}, db?: Database.Database): ActivityPage {
  const handle = db ?? getActivityDb();
  const limit = Math.min(Math.max(1, q.limit ?? DEFAULT_QUERY_LIMIT), MAX_QUERY_LIMIT);
  const { where, params } = buildFilter(q);

  const rows = handle
    .prepare(`SELECT * FROM activity ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as ActivityRow[];

  const { total } = handle
    .prepare(`SELECT COUNT(*) AS total FROM activity ${where}`)
    .get(...params) as {
    total: number;
  };

  const records = rows.map(toRecord);
  // `latestId` is the highest id in the page — rows come back DESC, so that is
  // the first one. Falls back to the request's cursor (not 0) when the page is
  // empty, so a tailing caller that polls an idle bridge does not rewind and
  // re-read everything on the next tick.
  const latestId = records.length > 0 ? records[0].id : (q.sinceId ?? 0);
  return { records, latestId, total };
}

/** Every distinct agent that appears in the trail, most recently seen first.
 * Feeds the window's filter chips — a hardcoded list would go stale the
 * moment someone wires up a new MCP client. */
export function listAgents(db?: Database.Database): { agent: string; count: number }[] {
  const handle = db ?? getActivityDb();
  return handle
    .prepare(
      `SELECT agent, COUNT(*) AS count FROM activity
       WHERE agent IS NOT NULL
       GROUP BY agent ORDER BY MAX(id) DESC`,
    )
    .all() as { agent: string; count: number }[];
}

/** Delete the trail, or the part of it older than `before`. Returns rows
 * removed. VACUUM is the caller's call (the CLI offers it) — it rewrites the
 * whole file and has no business running inside a tool dispatch. */
export function clear(before?: string, db?: Database.Database): number {
  const handle = db ?? getActivityDb();
  if (before === undefined) {
    return handle.prepare('DELETE FROM activity').run().changes;
  }
  return handle.prepare('DELETE FROM activity WHERE at < ?').run(before).changes;
}

/** An inclusive date window. Both ends optional: `{ from }` alone means
 * "everything since", `{ to }` alone means "everything up to", `{}` means the
 * whole trail. ISO-8601 strings, compared lexically — which is exactly right
 * for the UTC ISO timestamps `record` writes. */
export interface ActivityRange {
  from?: string;
  to?: string;
}

function rangeFilter(range: ActivityRange): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (range.from !== undefined) {
    clauses.push('at >= ?');
    params.push(range.from);
  }
  if (range.to !== undefined) {
    clauses.push('at <= ?');
    params.push(range.to);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * How many rows a purge of this range WOULD remove.
 *
 * Exists so the UI can tell the user the number before they confirm, not
 * after. "Delete 4,812 of 12,483 actions" is a decision; "Delete?" is a
 * gamble, and this delete is permanent.
 */
export function countInRange(range: ActivityRange, db?: Database.Database): number {
  const handle = db ?? getActivityDb();
  const { where, params } = rangeFilter(range);
  const row = handle.prepare(`SELECT COUNT(*) AS n FROM activity ${where}`).get(...params) as {
    n: number;
  };
  return row.n;
}

/**
 * Delete every row inside an inclusive date range. Returns rows removed.
 *
 * `vacuum` defaults ON here, unlike `clear`. The whole point of purging from
 * the UI is that the file got big, and a DELETE alone leaves the pages
 * allocated — the user would purge half the trail, watch the reported size not
 * move, and reasonably conclude it did nothing. VACUUM rewrites the file so
 * the number they are watching actually drops.
 */
export function purgeRange(
  range: ActivityRange,
  options: { vacuum?: boolean } = {},
  db?: Database.Database,
): number {
  const handle = db ?? getActivityDb();
  const { where, params } = rangeFilter(range);
  const removed = handle.prepare(`DELETE FROM activity ${where}`).run(...params).changes;
  if (removed > 0 && options.vacuum !== false) {
    try {
      // VACUUM ALONE IS NOT ENOUGH IN WAL MODE, and getting this wrong is
      // invisible in the worst way: the rows go, the reported size does not
      // move, and the user reasonably concludes the purge did nothing.
      //
      // In WAL mode the freed pages land in `activity.db-wal` rather than
      // being handed back to the filesystem, so the file set stays exactly as
      // large as before. TRUNCATE checkpoints fold the WAL back into the main
      // DB and then truncate the sidecar to zero — once before, so VACUUM
      // rewrites a DB that already contains everything, and once after, so the
      // pages VACUUM itself freed are actually released.
      handle.pragma('wal_checkpoint(TRUNCATE)');
      handle.exec('VACUUM');
      handle.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // A checkpoint or VACUUM can fail while another connection holds the
      // file. The rows are already gone, which is what was asked for; the
      // space comes back on the next successful purge.
    }
  }
  return removed;
}

/** What the trail currently costs, for the panel that must always show it. */
export interface ActivityStats {
  rows: number;
  /** Bytes on disk: the DB plus its WAL and shared-memory sidecars. Reporting
   * only the .db file would understate a busy trail badly — WAL mode parks
   * recent writes in `activity.db-wal` until a checkpoint folds them in. */
  bytes: number;
  /** ISO timestamps of the oldest and newest row, or null on an empty trail.
   * Lets the UI say "since Aug 3" instead of a bare row count. */
  oldestAt: string | null;
  newestAt: string | null;
  /** The ceiling from `db.ts`, so the UI can show how close the trail is to
   * pruning itself rather than hardcoding a number that could drift. */
  maxRows: number;
}

export function stats(db?: Database.Database): ActivityStats {
  const handle = db ?? getActivityDb();
  const row = handle
    .prepare('SELECT COUNT(*) AS rows, MIN(at) AS oldest, MAX(at) AS newest FROM activity')
    .get() as { rows: number; oldest: string | null; newest: string | null };
  return {
    rows: row.rows,
    bytes: activityBytesOnDisk(),
    oldestAt: row.oldest,
    newestAt: row.newest,
    maxRows: MAX_ACTIVITY_ROWS,
  };
}

/** Sum the SQLite file set. Missing sidecars are simply 0 — a freshly
 * checkpointed DB has no -wal, and that is not an error. */
function activityBytesOnDisk(): number {
  const base = getActivityDbPath();
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += statSync(`${base}${suffix}`).size;
    } catch {
      // Not present — nothing to add.
    }
  }
  return total;
}

/**
 * Stream the whole trail for export, oldest first, in batches.
 *
 * A generator rather than an array on purpose: an export of 50k rows must not
 * materialise 50k objects to hand to a JSON serializer. Oldest-first because
 * an exported file is read top-to-bottom as a story, which is the opposite of
 * how a live panel is read.
 */
export function* exportAll(
  filter: ActivityQuery = {},
  db?: Database.Database,
): Generator<ActivityRecord> {
  const handle = db ?? getActivityDb();
  const { where, params } = buildFilter(filter);
  const stmt = handle.prepare(`SELECT * FROM activity ${where} ORDER BY id ASC`);
  for (const row of stmt.iterate(...params) as Iterable<ActivityRow>) {
    yield toRecord(row);
  }
}

/** Strip the free-text columns from a record on its way out of the machine.
 * Applied at EXPORT time, never at record time — see the PRIVACY CONTRACT in
 * `types.ts`. The row keeps its shape so a redacted export is still a valid,
 * diffable trail; only what was typed or evaluated goes. */
export function redact(record: ActivityRecord): ActivityRecord {
  return {
    ...record,
    payload: record.payload === null ? null : '[redacted]',
    title: record.title === null ? null : '[redacted]',
    url: record.url === null ? null : redactUrl(record.url),
  };
}

/** Keep origin + pathname, drop query string and fragment — that is where
 * tokens, search terms and session ids live. A trail that says
 * `https://app.example.com/orders` is still useful; one that says
 * `?token=abc123` is a leak. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[redacted]';
  }
}
