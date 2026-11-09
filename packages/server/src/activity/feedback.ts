import type Database from 'better-sqlite3';

/**
 * Agent feedback about browser-link itself: a tool returned something the
 * agent did not expect. The agent records it (`browser.feedback`, or the
 * `feedback` field of `browser.wrap_up`); only the owner turns an entry into
 * a GitHub issue, from the console (`browser-link feedback issue <id>`).
 */

/** Longest stored `observed` / `expected` text, in characters. */
export const FEEDBACK_TEXT_MAX = 2_000;
/** Longest stored tool name, in characters. */
const TOOL_MAX = 100;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export interface FeedbackInput {
  tool: string;
  observed: string;
  expected: string;
  agentId?: string | null;
  origin?: string | null;
  build?: string | null;
}

export interface FeedbackRow {
  id: number;
  /** ISO timestamp of the insert. */
  at: string;
  tool: string;
  observed: string;
  expected: string;
  agentId: string | null;
  origin: string | null;
  build: string | null;
}

export interface ListFeedbackOptions {
  /** Rows to return, newest first (default 50, max 500). */
  limit?: number;
  /** Only rows with an id greater than this. */
  sinceId?: number;
}

function required(field: string, value: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') throw new Error(`feedback: \`${field}\` must be a non-empty string`);
  return text.slice(0, max);
}

function optional(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text.slice(0, TOOL_MAX * 2);
}

/** Store one feedback entry. Throws when `tool`, `observed` or `expected`
 * is empty; long text is capped, never rejected. */
export function recordFeedback(db: Database.Database, input: FeedbackInput): { id: number } {
  const tool = required('tool', input.tool, TOOL_MAX);
  const observed = required('observed', input.observed, FEEDBACK_TEXT_MAX);
  const expected = required('expected', input.expected, FEEDBACK_TEXT_MAX);
  const result = db
    .prepare(
      `INSERT INTO feedback (at, tool, observed, expected, agent_id, origin, build)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      tool,
      observed,
      expected,
      optional(input.agentId),
      optional(input.origin),
      optional(input.build),
    );
  return { id: Number(result.lastInsertRowid) };
}

interface FeedbackDbRow {
  id: number;
  at: string;
  tool: string;
  observed: string;
  expected: string;
  agent_id: string | null;
  origin: string | null;
  build: string | null;
}

function toRow(r: FeedbackDbRow): FeedbackRow {
  return {
    id: r.id,
    at: r.at,
    tool: r.tool,
    observed: r.observed,
    expected: r.expected,
    agentId: r.agent_id,
    origin: r.origin,
    build: r.build,
  };
}

/** Feedback entries, newest first. */
export function listFeedback(db: Database.Database, opts: ListFeedbackOptions = {}): FeedbackRow[] {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const sinceId = Math.trunc(opts.sinceId ?? 0);
  const rows = db
    .prepare('SELECT * FROM feedback WHERE id > ? ORDER BY id DESC LIMIT ?')
    .all(sinceId, limit) as FeedbackDbRow[];
  return rows.map(toRow);
}

/** One entry by id, or null. */
export function getFeedback(db: Database.Database, id: number): FeedbackRow | null {
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id) as
    FeedbackDbRow | undefined;
  return row ? toRow(row) : null;
}
