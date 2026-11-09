import type Database from 'better-sqlite3';
import { getActivityDb } from './db.js';
import { isActivityFlag, type ActivityFlag } from './types.js';

/**
 * The friction report: what went wrong in a stretch of the trail, and for
 * which session, without reading every row.
 *
 * Everything is a GROUP BY over the stored columns (`flag`, `outcome`, `tool`,
 * `selector`, `agent_id`), so the cost is a handful of aggregate queries
 * regardless of how many rows matched. Consumed by `browser.activity`
 * (`summary: true`) and by `browser-link activity report`; the field names
 * are snake_case because the MCP result is the primary consumer.
 */

/** Rows the report reads. ANDed; absent means "the whole trail". */
export interface ActivitySummaryFilters {
  /** Rows at or after this ISO timestamp. */
  since?: string;
  /** Rows with `id` strictly greater than this (same cursor as `query`). */
  sinceId?: number;
  /** Only this session (`agent_id`). */
  agentId?: string;
}

export interface FailingTarget {
  selector: string;
  tool: string;
  /** Errored or flagged calls on this selector with this tool. */
  n: number;
  /** Flag of the most recent of those calls (null when it errored unflagged). */
  last_flag: ActivityFlag | null;
}

export interface SessionSummary {
  /** IPC session uuid, `'primary'`, or null for rows from before sessions
   * were recorded. */
  agent_id: string | null;
  /** Agent label of the session's most recent row. */
  agent: string | null;
  records: number;
  errors: number;
  flags: Partial<Record<ActivityFlag, number>>;
}

export interface ActivitySummary {
  records: number;
  errors: number;
  by_flag: Partial<Record<ActivityFlag, number>>;
  by_tool_errors: Record<string, number>;
  evaluate_calls: number;
  /** Rows flagged `timeout`, `flow-timeout` or `download-timeout`. */
  timeouts: number;
  /** Most failing selector + tool pairs, at most `MAX_FAILING_TARGETS`. */
  top_failing_targets: FailingTarget[];
  /** Most recently active first. */
  sessions: SessionSummary[];
}

export const MAX_FAILING_TARGETS = 10;

/** Upper bound on sessions listed. A report is read by a person or an agent's
 * context window; a long-lived data dir can hold thousands of sessions. */
const MAX_SESSIONS = 50;

const TIMEOUT_FLAGS: readonly ActivityFlag[] = ['timeout', 'flow-timeout', 'download-timeout'];

function buildWhere(filters: ActivitySummaryFilters): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.sinceId !== undefined) {
    clauses.push('id > ?');
    params.push(filters.sinceId);
  }
  if (filters.since !== undefined) {
    clauses.push('at >= ?');
    params.push(filters.since);
  }
  if (filters.agentId !== undefined) {
    clauses.push('agent_id = ?');
    params.push(filters.agentId);
  }
  return { clauses, params };
}

/** `WHERE` for the base filter plus any extra clauses. */
function where(base: string[], ...extra: string[]): string {
  const all = [...base, ...extra];
  return all.length > 0 ? `WHERE ${all.join(' AND ')}` : '';
}

function flagCounts(
  rows: { flag: string | null; n: number }[],
): Partial<Record<ActivityFlag, number>> {
  const out: Partial<Record<ActivityFlag, number>> = {};
  for (const row of rows) if (isActivityFlag(row.flag)) out[row.flag] = row.n;
  return out;
}

export function summarizeActivity(
  db: Database.Database = getActivityDb(),
  filters: ActivitySummaryFilters = {},
): ActivitySummary {
  const { clauses, params } = buildWhere(filters);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS records,
              COALESCE(SUM(outcome = 'error'), 0) AS errors,
              COALESCE(SUM(tool = 'browser.evaluate'), 0) AS evaluate_calls,
              COALESCE(SUM(flag IN (${TIMEOUT_FLAGS.map(() => '?').join(', ')})), 0) AS timeouts
       FROM activity ${where(clauses)}`,
    )
    .get(...TIMEOUT_FLAGS, ...params) as {
    records: number;
    errors: number;
    evaluate_calls: number;
    timeouts: number;
  };

  const byFlag = db
    .prepare(
      `SELECT flag, COUNT(*) AS n FROM activity ${where(clauses, 'flag IS NOT NULL')}
       GROUP BY flag ORDER BY n DESC, flag ASC`,
    )
    .all(...params) as { flag: string | null; n: number }[];

  const byToolErrors = db
    .prepare(
      `SELECT tool, COUNT(*) AS n FROM activity ${where(clauses, "outcome = 'error'")}
       GROUP BY tool ORDER BY n DESC, tool ASC`,
    )
    .all(...params) as { tool: string; n: number }[];

  // SQLite returns the bare `flag` column from the row that holds MAX(id) —
  // documented behaviour for a single MIN/MAX aggregate — which is exactly
  // "the flag of the most recent failure" without a correlated subquery.
  const targets = db
    .prepare(
      `SELECT selector, tool, COUNT(*) AS n, MAX(id) AS last_id, flag
       FROM activity
       ${where(clauses, 'selector IS NOT NULL', "(outcome = 'error' OR flag IS NOT NULL)")}
       GROUP BY selector, tool ORDER BY n DESC, last_id DESC LIMIT ?`,
    )
    .all(...params, MAX_FAILING_TARGETS) as {
    selector: string;
    tool: string;
    n: number;
    flag: string | null;
  }[];

  const sessions = db
    .prepare(
      `SELECT agent_id, MAX(id) AS last_id, agent, COUNT(*) AS records,
              COALESCE(SUM(outcome = 'error'), 0) AS errors
       FROM activity ${where(clauses)}
       GROUP BY agent_id ORDER BY last_id DESC LIMIT ?`,
    )
    .all(...params, MAX_SESSIONS) as {
    agent_id: string | null;
    agent: string | null;
    records: number;
    errors: number;
  }[];

  const sessionFlags = db
    .prepare(
      `SELECT agent_id, flag, COUNT(*) AS n FROM activity ${where(clauses, 'flag IS NOT NULL')}
       GROUP BY agent_id, flag ORDER BY n DESC, flag ASC`,
    )
    .all(...params) as { agent_id: string | null; flag: string | null; n: number }[];

  return {
    records: totals.records,
    errors: totals.errors,
    by_flag: flagCounts(byFlag),
    by_tool_errors: Object.fromEntries(byToolErrors.map((r) => [r.tool, r.n])),
    evaluate_calls: totals.evaluate_calls,
    timeouts: totals.timeouts,
    top_failing_targets: targets.map((t) => ({
      selector: t.selector,
      tool: t.tool,
      n: t.n,
      last_flag: isActivityFlag(t.flag) ? t.flag : null,
    })),
    sessions: sessions.map((s) => ({
      agent_id: s.agent_id,
      agent: s.agent,
      records: s.records,
      errors: s.errors,
      flags: flagCounts(sessionFlags.filter((f) => f.agent_id === s.agent_id)),
    })),
  };
}
