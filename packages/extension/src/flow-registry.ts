/**
 * In-flight flow registry + per-tab flow history + detached-flow records —
 * the state behind the popup's Flows panel, behind `deps.shouldCancel` (see
 * `flow.ts`), and behind the `flow_status` wire tool that backs
 * `browser.flow_status`.
 *
 * Extracted out of `background.ts` for the same reason `idle-policy.ts`,
 * `reconnect-policy.ts` and `flow-recording-policy.ts` were: the service
 * worker itself is untestable (it reaches for `chrome.*` at import time),
 * while THIS is the part with rules worth pinning down — the lifecycle of a
 * running flow, what a cancel does to an id nobody recognises, the 20-entry
 * history cap, the detached ceiling, and above all WHAT A HISTORY ENTRY IS
 * ALLOWED TO CONTAIN.
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
 *
 * DETACHED-FLOW RECORDS ARE A DIFFERENT ANIMAL and the distinction matters.
 * A record (`DetachedFlowRecord`, keyed `detached-flow:<flow_id>`) carries
 * the flow's ACTION MANIFEST — the very `results[]` a synchronous flow
 * returns to its caller — plus the failure message, so the agent that
 * launched a detached run can still answer "which things did you just
 * delete?" after the fact. That is page-derived data at rest in
 * `chrome.storage.session`, deliberately, because a detached flow has no
 * open tool call to return it through. It is NEVER shown in the popup, it
 * is only ever handed back over the bridge to an agent that can already
 * read the page, and it dies with the browser session like everything else
 * here.
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

/** Absolute wall-clock ceiling on a DETACHED flow, from the moment it is
 * registered. Mirrors `MAX_DETACHED_FLOW_TIMEOUT_MS` in the server's
 * `browser-dispatch.ts` (which rejects an over-ceiling flow up front) and
 * `cdp/detached-flows.ts` (the cdp-direct runner's own copy); kept in sync
 * manually, since the three packages share no module for it.
 *
 * A detached flow escapes `MAX_FLOW_TIMEOUT_MS` — nothing is parked on it,
 * so the 60s "do not hold a tool call open longer than this" rule simply
 * does not apply. What it must NOT escape is having an end: a flow that
 * keeps acting with no agent attached and no upper bound is exactly the
 * runaway this whole program exists to make impossible. Past the ceiling
 * the flow self-cancels and reports `stopped_by: 'expired'` — a distinct
 * outcome from a human pressing Stop, because "I ran out of time" and
 * "someone stopped me" are different facts about the same partial work.
 *
 * Enforced as a DEADLINE checked at the same points as the cancel flag
 * (see `shouldStop`), never as a timer: a timer would fire while the
 * runner is mid-step and could not stop anything anyway, and a
 * request-derived `setTimeout` duration is a resource-exhaustion finding
 * waiting to happen. */
export const MAX_DETACHED_FLOW_MS = 30 * 60_000;

export type FlowOutcome = 'completed' | 'cancelled' | 'failed' | 'expired';

/** Why a flow was told to stop. A fixed vocabulary — it reaches both the
 * popup (as a history label) and the agent (as `stopped_by`), so it can
 * never carry free text. */
export type FlowStopReason = 'cancelled' | 'expired' | 'worker-terminated';

/** Lifecycle state of a flow as `browser.flow_status` reports it.
 * `'unknown'` is the answer for an id this worker has no record of — a
 * flow that finished before the last service-worker restart, a synchronous
 * flow that already returned, or an id that never existed. Deliberately a
 * state rather than an error, for the same reason cancelling an unknown id
 * is a no-op: the caller asked "what is this doing?", and "nothing I know
 * of" is a truthful answer, not a failure. */
export type FlowState = 'running' | 'completed' | 'cancelled' | 'failed' | 'expired' | 'unknown';

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
  /** Rendered as a badge on the row. The human needs to know WHICH of the
   * running flows is the one that will keep clicking after every agent has
   * gone home — that is the whole reason the Stop button exists. */
  detached: boolean;
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
  /** The flow ran detached. Worth a badge in the panel: a detached entry is
   * work the browser did with nobody watching. */
  detached?: true;
  /** Why it stopped, when that is not obvious from `outcome` alone — a
   * `failed` entry reads very differently once you know the service worker
   * was killed under it rather than a step going wrong. */
  stoppedBy?: FlowStopReason;
}

export interface FlowRegistry {
  /** Start tracking a flow and hand back the live entry, so the caller can
   * stamp late-arriving fields (the tab title) on it and close its
   * `shouldCancel` / `onProgress` over the same object. */
  register(input: {
    flowId: string;
    tabId: number;
    steps: number;
    title?: string;
    detached?: boolean;
    /** Wall-clock deadline for a detached flow. Ignored (and never set)
     * for a synchronous one. */
    expiresAt?: number;
  }): FlowRegistryEntry;
  get(flowId: string): FlowRegistryEntry | undefined;
  /** Flip a running flow to cancelled. Returns whether this call is the
   * one that flipped it — `false` for an unknown id, an id that already
   * finished, or a second Stop press. A clean no-op either way: the popup,
   * an agent and the flow's own completion race by nature, and every one
   * of those races ends with the flow not running, which is what the
   * caller asked for. */
  cancel(flowId: string, reason?: FlowStopReason): boolean;
  /** Cancel every flow running against one Chrome tab — the tab closed,
   * the debugger detached, or the bridge was disconnected. Returns how
   * many were flipped. */
  cancelForTab(tabId: number): number;
  /** The single rule the whole "one detached flow per tab" contract rests
   * on. Returns the entry so the rejection can NAME the flow already
   * running — an error that just says "busy" leaves the caller with no way
   * to find, inspect or stop the thing blocking it. */
  detachedForTab(tabId: number): FlowRegistryEntry | undefined;
  /** The one question the runner asks between steps: should I stop? True
   * when the cancel flag is set OR a detached flow has outlived its
   * deadline — and in that second case this call is also what RECORDS the
   * reason, so the outcome comes out as `'expired'` rather than as an
   * indistinguishable `'cancelled'`. Idempotent and cheap: it runs once
   * per step. */
  shouldStop(flowId: string, now: number): boolean;
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

  /** Shared by `cancel` and `cancelForTab`: flip once, remember why. A
   * second call never overwrites the first reason — the first thing that
   * told the flow to stop is the thing that stopped it. */
  function flip(entry: FlowRegistryEntry, reason: FlowStopReason): boolean {
    if (entry.cancelled) return false;
    entry.cancelled = true;
    entry.stopReason = reason;
    return true;
  }

  return {
    register({ flowId, tabId, steps, title, detached, expiresAt }): FlowRegistryEntry {
      const entry: FlowRegistryEntry = {
        flowId,
        tabId,
        title: title ?? '',
        startedAt: Date.now(),
        steps,
        cancelled: false,
        // Step 0 of N until the runner reports its first step — "not
        // started yet" rather than a fake "step 1".
        progress: { step: 0, steps },
        detached: detached === true,
        ...(detached === true && expiresAt !== undefined ? { expiresAt } : {}),
      };
      flows.set(flowId, entry);
      return entry;
    },

    get(flowId): FlowRegistryEntry | undefined {
      return flows.get(flowId);
    },

    cancel(flowId, reason = 'cancelled'): boolean {
      const entry = flows.get(flowId);
      if (!entry) return false;
      return flip(entry, reason);
    },

    cancelForTab(tabId): number {
      let cancelled = 0;
      for (const entry of flows.values()) {
        if (entry.tabId !== tabId) continue;
        if (flip(entry, 'cancelled')) cancelled += 1;
      }
      return cancelled;
    },

    detachedForTab(tabId): FlowRegistryEntry | undefined {
      for (const entry of flows.values()) {
        if (entry.tabId === tabId && entry.detached) return entry;
      }
      return undefined;
    },

    shouldStop(flowId, now): boolean {
      const entry = flows.get(flowId);
      // An id the registry has forgotten is not "still allowed to run" —
      // it is a flow whose bookkeeping is gone, and continuing to dispatch
      // irreversible actions on behalf of something nobody can see or stop
      // is the one outcome this module exists to prevent.
      if (!entry) return true;
      if (entry.cancelled) return true;
      if (entry.expiresAt !== undefined && now >= entry.expiresAt) {
        flip(entry, 'expired');
        return true;
      }
      return false;
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
          detached: entry.detached,
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
 * in the module header.
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
 * `shouldCancel` goes true and has no idea WHY it went true. The registry
 * entry does (`stopReason`), which is what promotes a run that outlived
 * its ceiling from `cancelled` to `expired` here.
 */
export function summarizeFlow(
  entry: FlowRegistryEntry,
  result: FlowResult | null,
): FlowOutcomeSummary {
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

/**
 * Reduce a finished flow to a history entry — the ONE place a summary is
 * allowed to turn into POPUP-visible stored state, and therefore the one
 * place the privacy contract has to hold. Nothing is copied across by
 * spread: every field is named, typed and numeric/enum, and the summary's
 * `error` is deliberately not among them.
 */
export function toHistoryEntry(
  entry: FlowRegistryEntry,
  result: FlowResult | null,
  endedAt: number,
): FlowHistoryEntry {
  const summary = summarizeFlow(entry, result);
  return {
    flowId: entry.flowId,
    startedAt: entry.startedAt,
    durationMs: Math.max(0, endedAt - entry.startedAt),
    steps: entry.steps,
    outcome: summary.outcome,
    stepsCompleted: summary.stepsCompleted,
    ...(summary.iterationsCompleted === undefined
      ? {}
      : { iterationsCompleted: summary.iterationsCompleted }),
    ...(summary.failedStep === undefined ? {} : { failedStep: summary.failedStep }),
    ...(summary.failedStepKind === undefined ? {} : { failedStepKind: summary.failedStepKind }),
    ...(entry.detached ? { detached: true as const } : {}),
    ...(summary.stoppedBy === undefined ? {} : { stoppedBy: summary.stoppedBy }),
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
    if (!isFlowOutcome(candidate.outcome)) continue;
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
      ...(candidate.detached === true ? { detached: true as const } : {}),
      ...(isFlowStopReason(candidate.stoppedBy) ? { stoppedBy: candidate.stoppedBy } : {}),
    });
  }
  return parsed.slice(0, MAX_FLOW_HISTORY_PER_TAB);
}

function isFlowOutcome(value: unknown): value is FlowOutcome {
  return (
    value === 'completed' || value === 'cancelled' || value === 'failed' || value === 'expired'
  );
}

function isFlowStopReason(value: unknown): value is FlowStopReason {
  return value === 'cancelled' || value === 'expired' || value === 'worker-terminated';
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
 * has reported its first step. A detached flow is labelled as such: it is
 * the one row where the human is the ONLY party still watching. */
export function describeFlowProgress(view: RunningFlowView): string {
  const prefix = view.detached ? 'detached · ' : '';
  if (view.step < 1) return `${prefix}starting…`;
  const base = `${prefix}step ${view.step}/${view.steps}`;
  if (view.iteration === undefined || view.iterations === undefined) return base;
  return `${base} · iteration ${view.iteration}/${view.iterations}`;
}

/** How a stop reason reads in the panel. `worker-terminated` gets a real
 * sentence because it is the one outcome a user cannot otherwise explain:
 * Chrome killed the extension's service worker and the flow died with it. */
const STOP_REASON_LABEL: Readonly<Record<FlowStopReason, string>> = {
  cancelled: 'stopped by you',
  expired: 'hit the 30-minute detached ceiling',
  'worker-terminated': 'extension worker was terminated — not resumed',
};

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
  // Only when it adds something: a `cancelled` entry already says
  // "cancelled" in its own badge, so repeating "stopped by you" there
  // would be noise.
  const reason =
    entry.stoppedBy !== undefined && entry.stoppedBy !== 'cancelled'
      ? ` · ${STOP_REASON_LABEL[entry.stoppedBy]}`
      : '';
  const detached = entry.detached === true ? 'detached · ' : '';
  return `${detached}${progress} · ${formatFlowDuration(entry.durationMs)}${failure}${reason}`;
}

// === Detached-flow records ================================================

/** `chrome.storage.session` key holding ONE detached flow's record. Keyed
 * by `flow_id` (not by tab): the id is what `browser.flow_status` and
 * `browser.flow_cancel` address, and it stays valid across a tab
 * reconnecting under a new browser-link id. */
export function detachedFlowKey(flowId: string): string {
  return `detached-flow:${flowId}`;
}

const DETACHED_FLOW_KEY_PREFIX = 'detached-flow:';

/** Inverse of `detachedFlowKey`, for the worker-start sweep over
 * `chrome.storage.session.get(null)`. Returns null for every other key. */
export function flowIdFromDetachedFlowKey(key: string): string | null {
  if (!key.startsWith(DETACHED_FLOW_KEY_PREFIX)) return null;
  const flowId = key.slice(DETACHED_FLOW_KEY_PREFIX.length);
  return flowId.length > 0 ? flowId : null;
}

/** How many detached-flow records are kept at once, across every tab.
 * Small on purpose: each terminal record carries a full action manifest,
 * `chrome.storage.session` is a shared, quota-bounded store, and the
 * realistic access pattern is "the agent that launched it polls it, reads
 * the manifest once, and moves on". Oldest-first eviction. */
export const MAX_DETACHED_FLOW_RECORDS = 10;

/** Byte ceiling on ONE stored record's serialized manifest. A 500-iteration
 * repeat over a 20-step body can produce a manifest far larger than
 * anything a session store should hold, and losing the whole record to a
 * quota rejection would be strictly worse than losing the manifest: the
 * counts, the outcome and the failing step all still fit. Over the ceiling
 * the manifest is dropped and `manifestTruncated` says so out loud, rather
 * than a silently short array the agent would read as "that's all that
 * happened". */
export const MAX_DETACHED_MANIFEST_BYTES = 128_000;

/**
 * The durable record of one detached flow — what `browser.flow_status`
 * answers from once the flow is no longer in the live registry, and what
 * makes MV3 service-worker termination detectable at all.
 *
 * Written twice per flow and no more: once at launch (`state: 'running'`)
 * and once when it ends. There is deliberately NO per-step write — a
 * 200-iteration flow would otherwise hammer `chrome.storage.session`
 * hundreds of times to keep a progress counter warm that the live registry
 * already holds for free.
 */
export interface DetachedFlowRecord {
  flowId: string;
  /** Chrome tab id. The server stamps the browser-link `tab_id` onto the
   * status payload itself — the extension only ever knows this one. */
  tabId: number;
  state: Exclude<FlowState, 'unknown'>;
  startedAt: number;
  endedAt?: number;
  /** Top-level step count the flow was launched with. */
  steps: number;
  stepsCompleted: number;
  iterationsCompleted?: number;
  stoppedBy?: FlowStopReason;
  /** The flow failure message. Page-derived free text — agent-facing only,
   * never rendered in the popup. */
  error?: string;
  /** The action manifest: `runFlow`'s `results[]`, verbatim. Absent while
   * the flow is still running (the runner holds them until it returns) and
   * when `manifestTruncated` is set. */
  manifest?: unknown[];
  manifestTruncated?: true;
  /** The one-per-flow summary `bridge.event` has not reached the server
   * yet — either the socket was closed when the flow ended, or the record
   * was only reconciled at worker start, when no tab is connected. Flushed
   * on that tab's next registration. */
  eventPending?: true;
}

/** The record written the instant a detached flow is launched. Its whole
 * job is to exist: a `running` record with no live registry entry behind it
 * is the ONLY evidence that Chrome killed the service worker mid-flow. */
export function startedDetachedFlowRecord(entry: FlowRegistryEntry): DetachedFlowRecord {
  return {
    flowId: entry.flowId,
    tabId: entry.tabId,
    state: 'running',
    startedAt: entry.startedAt,
    steps: entry.steps,
    stepsCompleted: 0,
  };
}

/** The terminal record, manifest included. `endedAt` is passed in rather
 * than read off the clock so the caller can use the same instant for the
 * record, the history entry and the audit event. */
export function finishedDetachedFlowRecord(
  entry: FlowRegistryEntry,
  result: FlowResult | null,
  endedAt: number,
): DetachedFlowRecord {
  const summary = summarizeFlow(entry, result);
  const manifest = result !== null && result.ok ? result.results : [];
  // Measured on the manifest alone: the rest of the record is a handful of
  // numbers and a bounded error string, and charging them against the
  // ceiling would make the cutoff depend on an error message's length.
  const oversized = measureJsonBytes(manifest) > MAX_DETACHED_MANIFEST_BYTES;
  return {
    flowId: entry.flowId,
    tabId: entry.tabId,
    state: summary.outcome,
    startedAt: entry.startedAt,
    endedAt,
    steps: entry.steps,
    stepsCompleted: summary.stepsCompleted,
    ...(summary.iterationsCompleted === undefined
      ? {}
      : { iterationsCompleted: summary.iterationsCompleted }),
    ...(summary.stoppedBy === undefined ? {} : { stoppedBy: summary.stoppedBy }),
    ...(summary.error === undefined ? {} : { error: summary.error }),
    ...(oversized ? { manifestTruncated: true as const } : { manifest }),
  };
}

/** Serialized size of a value, or `Infinity` when it cannot be serialized
 * at all (a cycle, a BigInt). Unserializable is treated as over the
 * ceiling: the alternative is letting `chrome.storage.session.set` throw
 * and losing the entire record. */
function measureJsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json.length : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Reconcile a persisted record against the fact that this service worker
 * has no live registry entry for it — i.e. Chrome terminated the worker
 * while the flow was mid-run.
 *
 * THE RULE, and it is not negotiable: mark it `failed` /
 * `'worker-terminated'` and NEVER resume. A detached flow exists to do
 * irreversible bulk work; a resume that could not know how far the dead run
 * actually got would double-act on some prefix of it. A loud, honest
 * failure is strictly better than a silent second pass, and a phantom
 * `running` state — a flow that looks alive while nothing is executing it —
 * is worse than both.
 *
 * The manifest of the dead run is genuinely unrecoverable: it lived in the
 * runner's closure, and there was never a per-step write that could have
 * saved it. `manifestTruncated` says so rather than presenting an empty
 * array as "nothing happened".
 *
 * Returns `null` for a record that is already terminal — a second worker
 * restart must not rewrite an outcome, nor re-fire its audit event.
 */
export function terminatedDetachedFlowRecord(
  record: DetachedFlowRecord,
  endedAt: number,
): DetachedFlowRecord | null {
  if (record.state !== 'running') return null;
  const { manifest: _dropped, ...rest } = record;
  return {
    ...rest,
    state: 'failed',
    endedAt,
    stoppedBy: 'worker-terminated',
    manifestTruncated: true,
    eventPending: true,
  };
}

/** The same terminal record without its manifest — what gets written when
 * storage refuses the full one. The manifest is the only part large enough
 * to be refused; state, `stoppedBy`, the counters and the error are a few
 * hundred bytes. Losing the manifest is a documented outcome; losing the
 * write is not: the stale `running` record becomes `worker-terminated`. */
export function minimalDetachedFlowRecord(record: DetachedFlowRecord): DetachedFlowRecord {
  const { manifest: _dropped, ...rest } = record;
  return { ...rest, manifestTruncated: true };
}

/** The history entry for a flow the service worker was killed under. The
 * live entry is gone, so this is reconstructed from the persisted record —
 * counts and enums only, same privacy contract as every other entry. */
export function terminatedFlowHistoryEntry(record: DetachedFlowRecord): FlowHistoryEntry {
  return {
    flowId: record.flowId,
    startedAt: record.startedAt,
    durationMs: Math.max(0, (record.endedAt ?? record.startedAt) - record.startedAt),
    steps: record.steps,
    outcome: 'failed',
    stepsCompleted: record.stepsCompleted,
    detached: true,
    stoppedBy: 'worker-terminated',
  };
}

/** Narrow whatever `chrome.storage.session` hands back into a record.
 * Same posture as `parseFlowHistory`: storage is not a typed channel, and a
 * record written by an older extension version must be dropped rather than
 * rendered as a half-`undefined` status payload. */
export function parseDetachedFlowRecord(raw: unknown): DetachedFlowRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Partial<DetachedFlowRecord>;
  if (typeof c.flowId !== 'string' || c.flowId.length === 0) return null;
  if (typeof c.tabId !== 'number') return null;
  if (typeof c.startedAt !== 'number') return null;
  if (typeof c.steps !== 'number') return null;
  if (typeof c.stepsCompleted !== 'number') return null;
  if (
    c.state !== 'running' &&
    c.state !== 'completed' &&
    c.state !== 'cancelled' &&
    c.state !== 'failed' &&
    c.state !== 'expired'
  ) {
    return null;
  }
  return {
    flowId: c.flowId,
    tabId: c.tabId,
    state: c.state,
    startedAt: c.startedAt,
    steps: c.steps,
    stepsCompleted: c.stepsCompleted,
    ...(typeof c.endedAt === 'number' ? { endedAt: c.endedAt } : {}),
    ...(typeof c.iterationsCompleted === 'number'
      ? { iterationsCompleted: c.iterationsCompleted }
      : {}),
    ...(isFlowStopReason(c.stoppedBy) ? { stoppedBy: c.stoppedBy } : {}),
    ...(typeof c.error === 'string' ? { error: c.error } : {}),
    ...(Array.isArray(c.manifest) ? { manifest: c.manifest } : {}),
    ...(c.manifestTruncated === true ? { manifestTruncated: true as const } : {}),
    ...(c.eventPending === true ? { eventPending: true as const } : {}),
  };
}

/** Which stored records to evict so `MAX_DETACHED_FLOW_RECORDS` holds,
 * oldest-start first. RUNNING records are never evicted regardless of age:
 * dropping one would erase the only evidence that a flow was in flight, and
 * a worker restart would then have nothing to mark `worker-terminated`.
 * Records still owing their summary event (`eventPending`) go LAST, reached
 * only when nothing else is left: evicting one destroys an audit event no
 * one has received, but a cap that can never be enforced would block every
 * new record. The exemption lapses when the flush clears the flag. */
export function detachedFlowRecordsToEvict(
  records: readonly DetachedFlowRecord[],
): DetachedFlowRecord[] {
  const terminal = records
    .filter((r) => r.state !== 'running')
    .sort((a, b) => a.startedAt - b.startedAt);
  const keep = Math.max(0, MAX_DETACHED_FLOW_RECORDS - (records.length - terminal.length));
  const excess = terminal.length - keep;
  if (excess <= 0) return [];
  return [
    ...terminal.filter((r) => r.eventPending !== true),
    ...terminal.filter((r) => r.eventPending === true),
  ].slice(0, excess);
}

// === browser.flow_status payload ==========================================

/** The wire shape `browser.flow_status` returns (the server additionally
 * stamps `tab_id` onto it — the extension does not know the browser-link
 * id). snake_case because this one crosses the bridge to an agent, unlike
 * every other type in this module. */
export interface FlowStatusPayload {
  flow_id: string;
  state: FlowState;
  detached: boolean;
  started_at?: number;
  ended_at?: number;
  steps?: number;
  steps_completed?: number;
  iterations_completed?: number;
  stopped_by?: FlowStopReason;
  error?: string;
  /** A stop has been requested and the runner has not reached its next
   * check yet — the up-to-one-step gap. Distinguishes "asked to stop" from
   * "stopped", which is exactly the ambiguity an agent polling right after
   * `browser.flow_cancel` needs resolved. */
  cancelling?: true;
  /** When a detached flow will self-cancel as `expired`. */
  expires_at?: number;
  /** `runFlow`'s `results[]`. Present only in a terminal state: while a
   * flow runs, the runner is still holding them. */
  manifest?: unknown[];
  /** The manifest existed but is not retrievable — over the storage
   * ceiling, or lost with the service worker that was running the flow. */
  manifest_truncated?: true;
}

/**
 * Build the status payload for a flow id, from whichever source knows
 * about it. The live registry entry wins for a running flow (it has
 * up-to-the-step progress the twice-written record cannot), the persisted
 * record answers for everything that already ended, and an id neither
 * knows about comes back as `state: 'unknown'` rather than as an error.
 */
export function toFlowStatus(
  flowId: string,
  entry: FlowRegistryEntry | undefined,
  record: DetachedFlowRecord | undefined,
): FlowStatusPayload {
  if (entry) {
    return {
      flow_id: flowId,
      state: 'running',
      detached: entry.detached,
      started_at: entry.startedAt,
      steps: entry.steps,
      // The runner reports the step it is ABOUT to dispatch, so N announced
      // means N-1 finished. Same derivation the history uses for a flow
      // that threw.
      steps_completed: Math.max(0, entry.progress.step - 1),
      ...(entry.progress.iteration === undefined
        ? {}
        : { iterations_completed: Math.max(0, entry.progress.iteration - 1) }),
      ...(entry.cancelled ? { cancelling: true as const } : {}),
      ...(entry.expiresAt === undefined ? {} : { expires_at: entry.expiresAt }),
    };
  }
  if (record) {
    return {
      flow_id: flowId,
      state: record.state,
      detached: true,
      started_at: record.startedAt,
      ...(record.endedAt === undefined ? {} : { ended_at: record.endedAt }),
      steps: record.steps,
      steps_completed: record.stepsCompleted,
      ...(record.iterationsCompleted === undefined
        ? {}
        : { iterations_completed: record.iterationsCompleted }),
      ...(record.stoppedBy === undefined ? {} : { stopped_by: record.stoppedBy }),
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.manifest === undefined ? {} : { manifest: record.manifest }),
      ...(record.manifestTruncated === true ? { manifest_truncated: true as const } : {}),
    };
  }
  return { flow_id: flowId, state: 'unknown', detached: false };
}
