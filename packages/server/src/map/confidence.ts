/**
 * Confidence, not verdicts (knowledge-loop S2).
 *
 * Every item the map offers carries `confidence` plus the raw evidence it
 * was computed from, so the agent decides; the map never deletes or hides
 * something because it failed.
 *
 *   - `fresh`: it worked on the build the tab runs now;
 *   - `unverified`: it worked before, with no proof on the current build
 *     (or the current build is unknown);
 *   - `failing`: two or more structural failures on the current build since
 *     it last worked.
 *
 * Failure reasons are classified statically. Structural ones say the target
 * itself is wrong (gone, ambiguous, covered); situational ones say the
 * moment was wrong (slow, busy, stale ref) and never change confidence by
 * themselves. `expect-failed` counts as structural only when repeated on
 * the same build, which is exactly the `failing` threshold.
 *
 * Pure: no DB access, so it is table-tested and reused by every reader.
 */

export const STRUCTURAL_REASONS = [
  'not-found',
  'multiple-matches',
  'retargeted',
  'hit-mismatch',
] as const;

export const SITUATIONAL_REASONS = ['timeout', 'unsettled', 'unmatched', 'ref-stale'] as const;

/** Failures on one build from which an item counts as `failing`. */
export const FAILING_THRESHOLD = 2;

export type Confidence = 'fresh' | 'unverified' | 'failing';

/** What the outcome counters of one row say, verbatim. */
export interface Evidence {
  ok_n: number;
  fail_n: number;
  last_reason: string | null;
  last_ok_build: string | null;
  last_fail_build: string | null;
  last_ok_at: string | null;
}

/**
 * A row with outcome counters. `struct_fail_n` counts failures that count
 * as structural (see `countsAsStructural`) on `struct_fail_build` since the
 * row last worked; rows written before those columns existed read as zero.
 */
export interface ConfidenceRow extends Evidence {
  struct_fail_n?: number | null;
  struct_fail_build?: string | null;
}

/** True when a failure reason is of a kind that can count toward
 * `failing`: every structural reason, and `expect-failed`. Whether one
 * particular failure increments the counter is `incrementsStructural`. */
export function countsAsStructural(reason: string | null): boolean {
  if (reason === null) return false;
  return reason === 'expect-failed' || (STRUCTURAL_REASONS as readonly string[]).includes(reason);
}

/** What the row said before the failure being recorded. */
export interface PreviousFailure {
  last_reason: string | null;
  last_fail_build: string | null;
}

/**
 * True when a failure with `reason` on `build` increments `struct_fail_n`.
 * A structural reason always does. `expect-failed` does only when it
 * repeats: the row's `last_reason` was already `expect-failed` on the same
 * build (null builds compare equal, as the counter's `IS` does). An unmet
 * expectation alone may be a slow page, not a broken selector, so a single
 * one never moves an item toward `failing`.
 */
export function incrementsStructural(
  reason: string | null,
  previous: PreviousFailure | null,
  build: string | null,
): boolean {
  if (reason !== 'expect-failed') return countsAsStructural(reason);
  return (
    previous !== null &&
    previous.last_reason === 'expect-failed' &&
    previous.last_fail_build === build
  );
}

/** Confidence of one row on `currentBuild` (null when the tab's build is
 * unknown: nothing can then be proven fresh or failing). */
export function confidenceOf(
  row: ConfidenceRow,
  currentBuild: string | null,
): { confidence: Confidence; evidence: Evidence } {
  const evidence: Evidence = {
    ok_n: row.ok_n,
    fail_n: row.fail_n,
    last_reason: row.last_reason,
    last_ok_build: row.last_ok_build,
    last_fail_build: row.last_fail_build,
    last_ok_at: row.last_ok_at,
  };
  let confidence: Confidence = 'unverified';
  if (currentBuild !== null) {
    if ((row.struct_fail_n ?? 0) >= FAILING_THRESHOLD && row.struct_fail_build === currentBuild) {
      confidence = 'failing';
    } else if (row.ok_n > 0 && row.last_ok_build === currentBuild) {
      confidence = 'fresh';
    }
  }
  return { confidence, evidence };
}
