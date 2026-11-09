import type Database from 'better-sqlite3';
import { loadConfig } from '../config.js';
import { getDb } from './db.js';
import { resolveLearnerApp } from './queries.js';
import { incrementsStructural, type PreviousFailure } from './confidence.js';
import { durableTarget, pathPattern, type TargetKind } from './keys.js';
import { recordReaderFromDispatch } from './readers.js';
import { categorise } from '../errors/categories.js';

/**
 * The map learns from use.
 *
 * Every click/type/press/find/wait_for an agent dispatches already tells us
 * whether a target worked: a thrown `retargeted`, a `find` that resolved with
 * `matched: false`, a click whose `expect` was met. Until now that evidence
 * died with the tool result. This module turns it into ok/fail counters per
 * durable target in the map DB (`selector_outcomes`, see db.ts), so the
 * `list_tabs` hint and `browser.map.recall` can say "this selector failed
 * here before" without the agent doing any bookkeeping.
 *
 * Privacy rule: the stored target is the CSS selector string or the
 * `browser.find` semantic key, and nothing else. Typed text, evaluate
 * expressions, key names and any other value an action carried are never
 * read here.
 *
 * Two layers:
 *   - `classifyOutcome` is pure: (tool, args, result, error) → verdict.
 *   - `recordOutcome` persists one verdict; `learnFromDispatch` is the glue
 *     the dispatcher's `recordOutcome` dep calls, gated by the config switch.
 */

/** The fixed failure vocabulary. `last_reason` never holds anything else. */
export const LEARNED_REASONS = [
  'retargeted',
  'ref-stale',
  'expect-failed',
  'not-found',
  'multiple-matches',
  'unmatched',
  'timeout',
  'unsettled',
  'hit-mismatch',
] as const;
export type LearnedReason = (typeof LEARNED_REASONS)[number];

export type LearnedOutcome = { ok: true } | { ok: false; reason: LearnedReason };

export type { TargetKind };

/** Rows kept per app. Past it, the least used row is evicted. */
export const MAX_LEARNED_PER_APP = 200;

/** Tools whose outcome says something about a target, and the short action
 * name stored for them. */
const LEARNABLE_ACTIONS: Readonly<Record<string, string | undefined>> = {
  'browser.click': 'click',
  'browser.type': 'type',
  'browser.press': 'press',
  'browser.find': 'find',
  'browser.wait_for': 'wait_for',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Results normally arrive raw; an MCP `{ content: [{ type: 'text', text }] }`
 * envelope is read through its first text block. Unparseable text is no
 * result at all. */
function unwrapEnvelope(result: unknown): unknown {
  const content = asRecord(result)?.content;
  if (!Array.isArray(content)) return result;
  const first = asRecord(content[0]);
  if (first?.type !== 'text' || typeof first.text !== 'string') return null;
  try {
    return JSON.parse(first.text) as unknown;
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

/** Thrown failures with a known meaning, from the shared error-category
 * table with the map learner's overrides (`errors/categories.ts`). Anything
 * else (argument validation, claim conflicts, a disconnected tab) says
 * nothing about the target and is not learned. */
function classifyError(error: unknown): LearnedOutcome | null {
  const reason = categorise(errorText(error), 'map-learner');
  return reason === null ? null : { ok: false, reason };
}

/**
 * Classify one dispatched call.
 *
 * Returns `{ ok: true }`, `{ ok: false, reason }`, or null when there is
 * nothing to learn: a tool outside click/type/press/find/wait_for, a call
 * without a durable target, or a result that proves neither success nor
 * failure (a quiet click with no `expect`: quiet is not effect).
 */
export function classifyOutcome(
  tool: string,
  args: unknown,
  result: unknown,
  error: unknown,
): LearnedOutcome | null {
  if (LEARNABLE_ACTIONS[tool] === undefined) return null;
  const target = durableTarget(tool, args);
  if (!target) return null;
  if (error !== undefined) return classifyError(error);

  const r = asRecord(unwrapEnvelope(result)) ?? {};
  if (tool === 'browser.find' || tool === 'browser.wait_for') {
    if (r.matched === true) return { ok: true };
    if (r.matched !== false) return null;
    if (tool === 'browser.find' && r.reason === 'not-found') {
      return { ok: false, reason: 'not-found' };
    }
    if (tool === 'browser.find' && r.reason === 'multiple-matches') {
      return { ok: false, reason: 'multiple-matches' };
    }
    return { ok: false, reason: 'unmatched' };
  }

  // click / type / press resolved.
  if (
    typeof r.hit_element === 'string' &&
    target.target_kind === 'selector' &&
    r.hit_element !== target.target
  ) {
    return { ok: false, reason: 'hit-mismatch' };
  }
  // An `expect` that did not hold would have thrown, so a resolved call
  // carrying one is proof of effect.
  if (asRecord(args)?.expect !== undefined) return { ok: true };
  const settle = asRecord(r.settle);
  if (settle?.settled === false) return { ok: false, reason: 'unsettled' };
  if (typeof settle?.mutation_count === 'number' && settle.mutation_count > 0) {
    return { ok: true };
  }
  return null;
}

export interface RecordOutcomeInput {
  origin: string;
  /** Stored as given: `learnFromDispatch` passes the path pattern. */
  pathname: string;
  target: string;
  target_kind: TargetKind;
  action: string;
  outcome: LearnedOutcome;
  /** Build fingerprint of the page when the call settled, when known. */
  build?: string | null;
  /** View signature of the page when the call settled, when known. */
  view_sig?: string | null;
}

/**
 * Persist one verdict: upsert the counters of the (app, route, target,
 * kind, action) row, then enforce the per-app cap.
 *
 * The app is resolved by `resolveLearnerApp`: the most recently seen app
 * of the origin (the one `list_tabs` and `recall` show), left untouched,
 * or a new app keyed by the origin host when the origin has none. The tab
 * title is never an input: a title such as "Inbox (3) - My App" would mint
 * a fresh app that then hides the saved map.
 */
export function recordOutcome(db: Database.Database, input: RecordOutcomeInput): void {
  if (!input.outcome.ok && !LEARNED_REASONS.includes(input.outcome.reason)) return;
  const app = resolveLearnerApp(db, input.origin);
  const ts = new Date().toISOString();
  const ok = input.outcome.ok;
  const reason = input.outcome.ok ? null : input.outcome.reason;
  const build = input.build ?? null;

  db.transaction(() => {
    const previous =
      reason === 'expect-failed'
        ? ((db
            .prepare(
              `SELECT last_reason, last_fail_build FROM selector_outcomes
                WHERE app_id = ? AND url_pattern = ? AND target = ? AND target_kind = ? AND action = ?`,
            )
            .get(app.id, input.pathname, input.target, input.target_kind, input.action) as
            PreviousFailure | undefined) ?? null)
        : null;
    // A failure that counts toward `failing` (see confidence.ts) on this build.
    const structural = !ok && incrementsStructural(reason, previous, build);
    db.prepare(
      `INSERT INTO selector_outcomes
         (app_id, url_pattern, target, target_kind, action, ok_n, fail_n, last_reason, last_ok_at, last_fail_at,
          view_sig, last_ok_build, last_fail_build, struct_fail_n, struct_fail_build)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id, url_pattern, target, target_kind, action) DO UPDATE SET
         ok_n = ok_n + excluded.ok_n,
         fail_n = fail_n + excluded.fail_n,
         last_reason = COALESCE(excluded.last_reason, last_reason),
         last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at),
         last_fail_at = COALESCE(excluded.last_fail_at, last_fail_at),
         view_sig = COALESCE(excluded.view_sig, view_sig),
         last_ok_build = COALESCE(excluded.last_ok_build, last_ok_build),
         last_fail_build = COALESCE(excluded.last_fail_build, last_fail_build),
         struct_fail_n = CASE
           WHEN excluded.ok_n = 1 THEN 0
           WHEN excluded.struct_fail_n = 1 AND struct_fail_build IS excluded.struct_fail_build
             THEN struct_fail_n + 1
           WHEN excluded.struct_fail_n = 1 THEN 1
           ELSE struct_fail_n
         END,
         struct_fail_build = CASE
           WHEN excluded.struct_fail_n = 1 THEN excluded.struct_fail_build
           ELSE struct_fail_build
         END`,
    ).run(
      app.id,
      input.pathname,
      input.target,
      input.target_kind,
      input.action,
      ok ? 1 : 0,
      ok ? 0 : 1,
      reason,
      ok ? ts : null,
      ok ? null : ts,
      input.view_sig ?? null,
      ok ? build : null,
      ok ? null : build,
      structural ? 1 : 0,
      structural ? build : null,
    );

    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM selector_outcomes WHERE app_id = ?')
      .get(app.id) as { n: number };
    if (n <= MAX_LEARNED_PER_APP) return;
    // Evict the least used rows, oldest first on a tie, never the row just
    // written: evicting the newcomer would freeze a full app forever.
    db.prepare(
      `DELETE FROM selector_outcomes WHERE id IN (
         SELECT id FROM selector_outcomes
         WHERE app_id = ?
           AND NOT (url_pattern = ? AND target = ? AND target_kind = ? AND action = ?)
         ORDER BY ok_n + fail_n ASC,
                  MAX(COALESCE(last_ok_at, ''), COALESCE(last_fail_at, '')) ASC,
                  id ASC
         LIMIT ?
       )`,
    ).run(
      app.id,
      input.pathname,
      input.target,
      input.target_kind,
      input.action,
      n - MAX_LEARNED_PER_APP,
    );
  })();
}

/** What the dispatcher hands the learner after a call settles. */
export interface DispatchOutcomeContext {
  tool: string;
  args: unknown;
  result: unknown;
  error: unknown;
  /** The tab's URL after the call, from the live tab table. */
  url: string | null;
  /** The tab's title. Part of the dispatcher contract but deliberately
   * ignored by the learner: it never resolves apps from or stores titles. */
  title: string | null;
  /** The page's build fingerprint (`doc_info`), when the tab reported one. */
  build?: string | null;
  /** The page's view signature (`doc_info`), when the tab reported one. */
  viewSig?: string | null;
}

/**
 * The dispatcher's `recordOutcome` dep in production (wired in server.ts).
 * `browser.evaluate` goes to the JS registry (map/readers.ts). Every other
 * call is classified first, so calls with nothing to learn cost no config
 * read and no DB access; then the `mapLearningEnabled` switch is honoured,
 * read on every call so `browser-link config set map-learning off` applies
 * at once. The row is keyed by the path pattern (`/facturas/:id`, see
 * keys.ts) and stamped with the tab's build and view signature.
 *
 * Never throws: a failed write logs one line and the call it learns from is
 * untouched.
 */
export function learnFromDispatch(ctx: DispatchOutcomeContext): void {
  try {
    if (ctx.tool === 'browser.evaluate') {
      if (loadConfig().mapLearningEnabled === false) return;
      recordReaderFromDispatch({ ...ctx, build: ctx.build ?? null });
      return;
    }
    const outcome = classifyOutcome(ctx.tool, ctx.args, ctx.result, ctx.error);
    if (!outcome) return;
    const target = durableTarget(ctx.tool, ctx.args);
    const action = LEARNABLE_ACTIONS[ctx.tool];
    if (!target || !action || !ctx.url) return;
    let url: URL;
    try {
      url = new URL(ctx.url);
    } catch {
      return;
    }
    if (url.origin === 'null') return;
    if (loadConfig().mapLearningEnabled === false) return;
    recordOutcome(getDb(), {
      origin: url.origin,
      pathname: pathPattern(url.pathname),
      target: target.target,
      target_kind: target.target_kind,
      action,
      outcome,
      build: ctx.build ?? null,
      view_sig: ctx.viewSig ?? null,
    });
  } catch (err) {
    // Learning must never break the call it learns from.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[browser-link] map learning failed for ${ctx.tool}: ${message}`);
  }
}
