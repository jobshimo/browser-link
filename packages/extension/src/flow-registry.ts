/**
 * In-flight flow registry + per-tab flow history — the state behind the
 * popup's Flows panel and behind `deps.shouldCancel` (see `flow.ts`).
 *
 * Extracted out of `background.ts` for the same reason `idle-policy.ts`,
 * `reconnect-policy.ts` and `flow-recording-policy.ts` were: the service
 * worker itself is untestable (it reaches for `chrome.*` at import time),
 * while THIS is the part with rules worth pinning down — the lifecycle of a
 * running flow, what a cancel does to an id nobody recognises, the 20-entry
 * history cap, and above all WHAT A HISTORY ENTRY IS ALLOWED TO CONTAIN.
 *
 * PRIVACY CONTRACT (same rule as the persistent map, enforced by
 * `toHistoryEntry` and asserted in the tests): a history entry holds UI
 * STRUCTURE AND OUTCOMES ONLY — counts, durations, a step index, a step
 * KIND. Never page text, never a selector, never typed input, never a
 * failure message. Flow error strings routinely quote the page (a
 * `find: multiple-matches` error carries candidate labels), which is
 * exactly why the failure message is dropped here rather than trimmed: the
 * operator needs to know WHICH STEP died, not what the page said.
 *
 * The history lives in `chrome.storage.session` (written by
 * `background.ts`, read by the popup through the same runtime-message
 * channel) and therefore dies with the browser session BY DESIGN. This is
 * an operator view, not an audit log.
 */

import type { FlowProgress, FlowResult } from './flow.js';

/** How many completed flows are kept per tab. Small on purpose — this is a
 * "what just happened on this tab" panel in a 320px-wide popup, not a log. */
export const MAX_FLOW_HISTORY_PER_TAB = 20;

/** `chrome.storage.session` key holding one tab's flow history. Keyed by
 * the CHROME tab id (not the browser-link `tab_N` id) because the popup
 * only ever knows the former, and a tab that reconnects under a new
 * browser-link id is still the same tab to the human looking at it. */
export function flowHistoryKey(tabId: number): string {
  return `flow-history:${tabId}`;
}

export type FlowOutcome = 'completed' | 'cancelled' | 'failed';

/** One live flow. Mutable on purpose: `cancelled` is what the runner's
 * `shouldCancel` reads on every step, and `progress` is overwritten in
 * place by its `onProgress`. */
export interface FlowRegistryEntry {
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
}

/** A running flow as the popup renders it. Flat and pre-computed
 * (`elapsedMs` rather than a raw clock) so the popup does no arithmetic on
 * a background-owned shape. */
export interface RunningFlowView {
  flowId: string;
  tabId: number;
  title: string;
  elapsedMs: number;
  steps: number;
  step: number;
  iteration?: number;
  iterations?: number;
  /** Stop was pressed and the runner has not reached its next check yet.
   * The button becomes "Stopping…" instead of vanishing, so the click is
   * visibly acknowledged during the up-to-one-step gap. */
  cancelling: boolean;
}

/** A finished flow, as stored in `chrome.storage.session`. Every field is
 * a number, an id or a fixed enum — see the PRIVACY CONTRACT above. */
export interface FlowHistoryEntry {
  flowId: string;
  startedAt: number;
  durationMs: number;
  outcome: FlowOutcome;
  /** Top-level steps the flow was asked to run. */
  steps: number;
  /** Top-level steps that actually completed. */
  stepsCompleted: number;
  /** Total completed repeat iterations across every `repeat` step in the
   * flow. Omitted when the flow had no `repeat` — "0 iterations" would
   * read as a failed loop rather than as "there was no loop". */
  iterationsCompleted?: number;
  /** 0-based index of the step that failed, for `failed` outcomes. */
  failedStep?: number;
  /** Step KIND of the failing step ('click', 'wait_for', …). A fixed
   * vocabulary, never page-derived text. */
  failedStepKind?: string;
}

export interface FlowRegistry {
  /** Start tracking a flow. Returns the live entry so the caller can hand
   * `shouldCancel` / `onProgress` closures straight over it. */
  register(input: { flowId: string; tabId: number; steps: number; title?: string }): void;
  get(flowId: string): FlowRegistryEntry | undefined;
  /** Flip a running flow to cancelled. Returns whether this call is the
   * one that flipped it — `false` for an unknown id, an id that already
   * finished, or a second Stop press. A clean no-op either way: the popup,
   * an agent and the flow's own completion race by nature, and every one
   * of those races ends with the flow not running, which is what the
   * caller asked for. */
  cancel(flowId: string): boolean;
  /** Cancel every flow running against one Chrome tab — the tab closed,
   * the debugger detached, or the bridge was disconnected. Returns how
   * many were flipped. */
  cancelForTab(tabId: number): number;
  /** Stop tracking a finished flow and hand back its final entry (or
   * `undefined` if it was never registered). */
  finish(flowId: string): FlowRegistryEntry | undefined;
  /** Every live flow across every tab, oldest first. All tabs on purpose:
   * the popup's Stop button has to reach a flow running on a tab the user
   * is not currently looking at. */
  listRunning(now: number): RunningFlowView[];
}

export function createFlowRegistry(): FlowRegistry {
  const flows = new Map<string, FlowRegistryEntry>();

  return {
    register({ flowId, tabId, steps, title }): void {
      flows.set(flowId, {
        flowId,
        tabId,
        title: title ?? '',
        startedAt: Date.now(),
        steps,
        cancelled: false,
        // Step 0 of N until the runner reports its first step — "not
        // started yet" rather than a fake "step 1".
        progress: { step: 0, steps },
      });
    },

    get(flowId): FlowRegistryEntry | undefined {
      return flows.get(flowId);
    },

    cancel(flowId): boolean {
      const entry = flows.get(flowId);
      if (!entry || entry.cancelled) return false;
      entry.cancelled = true;
      return true;
    },

    cancelForTab(tabId): number {
      let cancelled = 0;
      for (const entry of flows.values()) {
        if (entry.tabId !== tabId || entry.cancelled) continue;
        entry.cancelled = true;
        cancelled += 1;
      }
      return cancelled;
    },

    finish(flowId): FlowRegistryEntry | undefined {
      const entry = flows.get(flowId);
      flows.delete(flowId);
      return entry;
    },

    listRunning(now): RunningFlowView[] {
      const views: RunningFlowView[] = [];
      for (const entry of flows.values()) {
        views.push({
          flowId: entry.flowId,
          tabId: entry.tabId,
          title: entry.title,
          // Clamped at 0: `now` is supplied by the caller and a clock that
          // stepped backwards should read "0s", never "-4s".
          elapsedMs: Math.max(0, now - entry.startedAt),
          steps: entry.steps,
          step: entry.progress.step,
          ...(entry.progress.iteration === undefined
            ? {}
            : { iteration: entry.progress.iteration }),
          ...(entry.progress.iterations === undefined
            ? {}
            : { iterations: entry.progress.iterations }),
          cancelling: entry.cancelled,
        });
      }
      // Insertion order is start order (Map preserves it and a flow is
      // registered exactly once), so the oldest — the one most likely to
      // be the runaway — sits at the top of the panel.
      return views;
    },
  };
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
 * Reduce a finished flow to a history entry — the ONE place a `FlowResult`
 * is allowed to turn into stored state, and therefore the one place the
 * privacy contract has to hold. Nothing is copied across by spread: every
 * field is named, typed and numeric/enum.
 *
 * `result === null` means the flow threw instead of returning (a detached
 * debugger, a closed tab). That is a `failed` outcome with no step
 * attribution, which is honest — the runner never got to report one.
 */
export function toHistoryEntry(
  entry: FlowRegistryEntry,
  result: FlowResult | null,
  endedAt: number,
): FlowHistoryEntry {
  const base = {
    flowId: entry.flowId,
    startedAt: entry.startedAt,
    durationMs: Math.max(0, endedAt - entry.startedAt),
    steps: entry.steps,
  };
  if (result === null) {
    // No result to read, so fall back to the last progress report: the
    // runner had announced step N, which means N-1 finished.
    return { ...base, outcome: 'failed', stepsCompleted: Math.max(0, entry.progress.step - 1) };
  }
  if (!result.ok) {
    return {
      ...base,
      outcome: 'failed',
      stepsCompleted: result.steps_completed,
      failedStep: result.failed_step,
      // A fixed vocabulary from `stepKind()` ('click', 'wait_for',
      // 'unknown', 'none'), never free text — see the privacy contract.
      failedStepKind: result.step_kind,
    };
  }
  const iterations = countIterations(result.results);
  return {
    ...base,
    outcome: result.stopped_by === 'cancelled' ? 'cancelled' : 'completed',
    stepsCompleted: result.steps_completed,
    ...(iterations === undefined ? {} : { iterationsCompleted: iterations }),
  };
}

/** Prepend a finished flow to a tab's history and enforce the cap. Newest
 * first — the panel shows the most recent flow at the top, and the cap
 * drops the oldest. Pure so the cap is testable without touching
 * `chrome.storage`. */
export function appendFlowHistory(
  existing: readonly FlowHistoryEntry[],
  entry: FlowHistoryEntry,
): FlowHistoryEntry[] {
  return [entry, ...existing].slice(0, MAX_FLOW_HISTORY_PER_TAB);
}

/** Narrow whatever `chrome.storage.session` hands back into a history
 * list. Storage is not a trusted, typed channel (an older extension
 * version may have written a different shape, and the value survives a
 * service-worker restart), so an entry that does not carry the required
 * primitives is dropped rather than rendered as `undefined`. */
export function parseFlowHistory(raw: unknown): FlowHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const parsed: FlowHistoryEntry[] = [];
  for (const item of raw as readonly unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Partial<FlowHistoryEntry>;
    if (typeof candidate.flowId !== 'string') continue;
    if (typeof candidate.startedAt !== 'number') continue;
    if (typeof candidate.durationMs !== 'number') continue;
    if (typeof candidate.steps !== 'number') continue;
    if (typeof candidate.stepsCompleted !== 'number') continue;
    if (
      candidate.outcome !== 'completed' &&
      candidate.outcome !== 'cancelled' &&
      candidate.outcome !== 'failed'
    ) {
      continue;
    }
    parsed.push({
      flowId: candidate.flowId,
      startedAt: candidate.startedAt,
      durationMs: candidate.durationMs,
      outcome: candidate.outcome,
      steps: candidate.steps,
      stepsCompleted: candidate.stepsCompleted,
      ...(typeof candidate.iterationsCompleted === 'number'
        ? { iterationsCompleted: candidate.iterationsCompleted }
        : {}),
      ...(typeof candidate.failedStep === 'number' ? { failedStep: candidate.failedStep } : {}),
      ...(typeof candidate.failedStepKind === 'string'
        ? { failedStepKind: candidate.failedStepKind }
        : {}),
    });
  }
  return parsed.slice(0, MAX_FLOW_HISTORY_PER_TAB);
}

/** Compact duration for the popup: "0.4s" under a second, "12s" under a
 * minute, "3m 07s" beyond. Seconds are zero-padded in the minute form so
 * the column does not jitter as a flow runs. */
export function formatFlowDuration(ms: number): string {
  const safe = ms > 0 ? ms : 0;
  if (safe < 1000) return `${(safe / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(safe / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** What the popup calls a flow's tab. The title is best-effort (it is
 * captured asynchronously at flow start and can legitimately be empty on
 * a blank or still-loading tab), so the Chrome tab id is the fallback —
 * an unlabelled Stop button next to an unlabelled flow would be exactly
 * the wrong thing to hand someone trying to stop the right one. */
export function flowTabLabel(view: { title: string; tabId: number }): string {
  const trimmed = view.title.trim();
  return trimmed.length > 0 ? trimmed : `Tab ${view.tabId}`;
}

/** The progress line for one running flow: "step 2/5" outside a repeat,
 * "step 2/5 · iteration 12/50" inside one, "starting…" before the runner
 * has reported its first step. */
export function describeFlowProgress(view: RunningFlowView): string {
  if (view.step < 1) return 'starting…';
  const base = `step ${view.step}/${view.steps}`;
  if (view.iteration === undefined || view.iterations === undefined) return base;
  return `${base} · iteration ${view.iteration}/${view.iterations}`;
}

/** The one-line summary for a finished flow: outcome, what it got through,
 * and how long it took. Structure and counts only. */
export function describeFlowHistoryEntry(entry: FlowHistoryEntry): string {
  const progress =
    entry.iterationsCompleted === undefined
      ? `${entry.stepsCompleted}/${entry.steps} steps`
      : `${entry.stepsCompleted}/${entry.steps} steps · ${entry.iterationsCompleted} iterations`;
  const failure =
    entry.outcome === 'failed' && entry.failedStep !== undefined
      ? ` · failed at step ${entry.failedStep + 1}${
          entry.failedStepKind === undefined ? '' : ` (${entry.failedStepKind})`
        }`
      : '';
  return `${progress} · ${formatFlowDuration(entry.durationMs)}${failure}`;
}
