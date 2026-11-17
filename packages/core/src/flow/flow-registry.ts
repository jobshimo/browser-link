/**
 * `FlowRegistry`: every `browser.flow` running in this worker, across every
 * connected tab (design section 4) — the state behind the popup's Flows
 * panel, behind the runner's `shouldCancel` (see `flow-engine.ts`), and
 * behind the `flow_status` wire tool that backs `browser.flow_status`.
 *
 * Its rules: ONE detached flow per tab (`detachedForTab` is what the launch
 * asks); cancelling an unknown or finished id is a no-op; a run is finished
 * exactly once (`finish` hands it back once, then forgets it); and the
 * deadline of each foreground flow, the bound of its hold on the tab's idle
 * clock, lives and dies with its run here.
 *
 * In memory ON PURPOSE. If Chrome terminates the worker mid-flow the flow
 * dies with it, the registry goes with it, and the popup shows nothing
 * running — which is the truth. What outlives the worker is the detached
 * flow's record (`flow-history.ts`).
 */

import type { Clock } from '../ports/clock.js';
import type { DetachedFlowRecord, FlowState, FlowStopReason } from '../ports/values.js';
import { idleHoldUntil, type IdleFlowHold } from '../policies/idle-rules.js';
import { flowRunShouldStop, stopFlowRun, type FlowRun } from './flow-run.js';

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

export interface FlowRegistry {
  /** Start tracking a flow and hand back the live run, so the caller can
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
    /** The server's deadline of a foreground flow: the bound of its hold
     * on the tab's idle clock (`idleHolds`). Ignored for a detached one,
     * whose bound is `expiresAt`. */
    foregroundDeadlineAt?: number;
  }): FlowRun;
  get(flowId: string): FlowRun | undefined;
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
   * on. Returns the run so the rejection can NAME the flow already
   * running — an error that just says "busy" leaves the caller with no way
   * to find, inspect or stop the thing blocking it. */
  detachedForTab(tabId: number): FlowRun | undefined;
  /** The one question the runner asks between steps: should I stop? True
   * when the cancel flag is set OR a detached flow has outlived its
   * deadline (recorded as `'expired'`, `flowRunShouldStop`). Idempotent and
   * cheap: it runs once per step. */
  shouldStop(flowId: string, now: number): boolean;
  /** Stop tracking a finished flow and hand back its final run (or
   * `undefined` if it was never registered or already finished). */
  finish(flowId: string): FlowRun | undefined;
  /** Every live flow across every tab, oldest first. All tabs on purpose:
   * the popup's Stop button has to reach a flow running on a tab the user
   * is not currently looking at. */
  listRunning(now: number): RunningFlowView[];
  /** Owner decision D1: until when each running flow holds its tab's idle
   * clock (`idleHoldUntil`), oldest first. */
  idleHolds(): IdleFlowHold[];
}

export function createFlowRegistry(clock: Clock): FlowRegistry {
  const flows = new Map<string, FlowRun>();
  /** The server's deadline of each running FOREGROUND flow, by flow id. */
  const foregroundDeadlines = new Map<string, number>();

  return {
    register({ flowId, tabId, steps, title, detached, expiresAt, foregroundDeadlineAt }): FlowRun {
      const entry: FlowRun = {
        flowId,
        tabId,
        title: title ?? '',
        startedAt: clock.now(),
        steps,
        cancelled: false,
        // Step 0 of N until the runner reports its first step — "not
        // started yet" rather than a fake "step 1".
        progress: { step: 0, steps },
        detached: detached === true,
        ...(detached === true && expiresAt !== undefined ? { expiresAt } : {}),
      };
      flows.set(flowId, entry);
      if (detached !== true && foregroundDeadlineAt !== undefined) {
        foregroundDeadlines.set(flowId, foregroundDeadlineAt);
      }
      return entry;
    },

    get(flowId): FlowRun | undefined {
      return flows.get(flowId);
    },

    cancel(flowId, reason = 'cancelled'): boolean {
      const entry = flows.get(flowId);
      if (!entry) return false;
      return stopFlowRun(entry, reason);
    },

    cancelForTab(tabId): number {
      let cancelled = 0;
      for (const entry of flows.values()) {
        if (entry.tabId !== tabId) continue;
        if (stopFlowRun(entry, 'cancelled')) cancelled += 1;
      }
      return cancelled;
    },

    detachedForTab(tabId): FlowRun | undefined {
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
      return flowRunShouldStop(entry, now);
    },

    finish(flowId): FlowRun | undefined {
      foregroundDeadlines.delete(flowId);
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

    idleHolds(): IdleFlowHold[] {
      return [...flows.values()].map((entry) => ({
        tabId: entry.tabId,
        holdUntil: idleHoldUntil(entry, foregroundDeadlines.get(entry.flowId)),
      }));
    },
  };
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
 * about it. The live run wins for a running flow (it has up-to-the-step
 * progress the twice-written record cannot), the persisted record answers
 * for everything that already ended, and an id neither knows about comes
 * back as `state: 'unknown'` rather than as an error.
 */
export function toFlowStatus(
  flowId: string,
  entry: FlowRun | undefined,
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
