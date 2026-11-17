/**
 * `FlowRun`: one flow's state, as the registry holds it while the flow runs
 * (design section 4). Its rules: the runner's stop question turns true on
 * cancel or once a detached flow reaches `expiresAt`; a stop is recorded
 * once (the first reason wins, a second request is a no-op); and the run is
 * reduced to its outcome in ONE place (`summarizeFlow`), so the popup's
 * history and the agent's `flow_status` can never disagree about it.
 * "Finished exactly once" is the registry's `finish` (`flow-registry.ts`).
 */

import type { FlowOutcome, FlowStopReason } from '../ports/values.js';
import type { FlowProgress, FlowResult } from './flow-engine.js';

/** One live flow. Mutable on purpose: `cancelled` is what the runner's
 * `shouldCancel` reads on every step, and `progress` is overwritten in
 * place by its `onProgress`. */
export interface FlowRun {
  flowId: string;
  /** Chrome tab id the flow is running against. */
  tabId: number;
  /** Tab title captured when the flow started, best effort — it is what
   * lets the popup tell two concurrent flows apart. Empty until the
   * asynchronous `chrome.tabs.get` lands (or forever, if it fails). */
  title: string;
  startedAt: number;
  /** Top-level step count — the N in "step 3/N". */
  steps: number;
  cancelled: boolean;
  progress: FlowProgress;
  /** Started with `detach: true` — nothing is waiting on its result, so it
   * keeps acting between agent turns and is the one thing here that
   * outlives the call that launched it. */
  detached: boolean;
  /** Wall-clock instant past which a detached flow self-cancels as
   * `'expired'`. Set only for detached flows (a synchronous one is already
   * bounded by `MAX_FLOW_TIMEOUT_MS` on the server side). */
  expiresAt?: number;
  /** Set the moment the flow is told to stop, alongside `cancelled`. What
   * turns an otherwise-identical `stopped_by: 'cancelled'` from the runner
   * into `'expired'` in the record the agent reads. */
  stopReason?: FlowStopReason;
}

/** Flip a run to stopped, once, remembering why. A second call never
 * overwrites the first reason — the first thing that told the flow to stop
 * is the thing that stopped it. Returns whether this call flipped it. */
export function stopFlowRun(run: FlowRun, reason: FlowStopReason): boolean {
  if (run.cancelled) return false;
  run.cancelled = true;
  run.stopReason = reason;
  return true;
}

/** The runner's stop question for a live run: true once it was stopped, or
 * once a detached run reached its deadline — and in that second case this
 * call is also what RECORDS the reason, so the outcome comes out as
 * `'expired'` rather than as an indistinguishable `'cancelled'`. */
export function flowRunShouldStop(run: FlowRun, now: number): boolean {
  if (run.cancelled) return true;
  if (run.expiresAt !== undefined && now >= run.expiresAt) {
    stopFlowRun(run, 'expired');
    return true;
  }
  return false;
}

/** Sum the completed iterations of every `repeat` step in a finished
 * flow's results. Reads ONLY the numeric `iterations_completed` field off
 * entries that carry one; everything else in a result entry is ignored, so
 * nothing page-derived can reach the history. */
function countIterations(results: readonly unknown[]): number | undefined {
  let total: number | undefined;
  for (const entry of results) {
    if (typeof entry !== 'object' || entry === null) continue;
    const value = (entry as { iterations_completed?: unknown }).iterations_completed;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

/**
 * What a finished flow amounted to, in fields that are the same whether
 * the reader is the popup or an agent. Shared by `toHistoryEntry` and
 * `finishedDetachedFlowRecord` precisely so the two can never disagree
 * about the same run — a popup showing `cancelled` next to a
 * `flow_status` reporting `expired` would be worse than either being
 * wrong on its own.
 *
 * `error` is the one field with page-derived free text in it. It is
 * produced here but consumed ONLY by the detached record (which the agent
 * reads); `toHistoryEntry` drops it on the floor. See the privacy contract
 * in `flow-history.ts`.
 */
export interface FlowOutcomeSummary {
  outcome: FlowOutcome;
  stepsCompleted: number;
  iterationsCompleted?: number;
  failedStep?: number;
  failedStepKind?: string;
  stoppedBy?: FlowStopReason;
  error?: string;
}

/**
 * Reduce a finished flow to its outcome. The ONE place a `FlowResult` is
 * interpreted, so "what happened" has a single definition.
 *
 * `result === null` means the flow threw instead of returning (a detached
 * debugger, a closed tab). That is a `failed` outcome with no step
 * attribution, which is honest — the runner never got to report one.
 *
 * The runner only ever reports `stopped_by: 'cancelled'`: it flips when
 * `shouldCancel` goes true and has no idea WHY it went true. The run
 * does (`stopReason`), which is what promotes a run that outlived its
 * ceiling from `cancelled` to `expired` here.
 */
export function summarizeFlow(entry: FlowRun, result: FlowResult | null): FlowOutcomeSummary {
  if (result === null) {
    // No result to read, so fall back to the last progress report: the
    // runner had announced step N, which means N-1 finished.
    return {
      outcome: 'failed',
      stepsCompleted: Math.max(0, entry.progress.step - 1),
      ...(entry.stopReason === undefined ? {} : { stoppedBy: entry.stopReason }),
    };
  }
  if (!result.ok) {
    return {
      outcome: 'failed',
      stepsCompleted: result.steps_completed,
      failedStep: result.failed_step,
      // A fixed vocabulary from `stepKind()` ('click', 'wait_for',
      // 'unknown', 'none'), never free text — see the privacy contract.
      failedStepKind: result.step_kind,
      error: result.error,
    };
  }
  const iterations = countIterations(result.results);
  const tail = iterations === undefined ? {} : { iterationsCompleted: iterations };
  if (result.stopped_by === 'timeout') {
    // The runner hit its own deadline (a foreground flow outlasting its
    // time budget). It ran out of time rather than being stopped by a
    // human, which is exactly what `expired` already means.
    return {
      outcome: 'expired',
      stepsCompleted: result.steps_completed,
      ...tail,
      stoppedBy: 'expired',
    };
  }
  if (result.stopped_by !== 'cancelled') {
    return { outcome: 'completed', stepsCompleted: result.steps_completed, ...tail };
  }
  const stoppedBy: FlowStopReason = entry.stopReason ?? 'cancelled';
  return {
    outcome: stoppedBy === 'expired' ? 'expired' : 'cancelled',
    stepsCompleted: result.steps_completed,
    ...tail,
    stoppedBy,
  };
}

export function isFlowOutcome(value: unknown): value is FlowOutcome {
  return (
    value === 'completed' || value === 'cancelled' || value === 'failed' || value === 'expired'
  );
}

export function isFlowStopReason(value: unknown): value is FlowStopReason {
  return value === 'cancelled' || value === 'expired' || value === 'worker-terminated';
}
