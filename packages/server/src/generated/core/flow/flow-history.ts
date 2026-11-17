// GENERATED from packages/core/src/flow/flow-history.ts. Do not edit.
/**
 * `FlowHistory`: what outlives a flow (design section 4) — each tab's
 * history of finished flows, over `FlowHistoryStore`, and the records of
 * detached flows, over `DetachedFlowStore`.
 *
 * Its rules: storage stays bounded (`MAX_FLOW_HISTORY_PER_TAB` entries per
 * tab, `MAX_DETACHED_FLOW_RECORDS` records, `MAX_DETACHED_MANIFEST_BYTES` per
 * manifest); every write goes through ONE serialized chain, and a failed
 * write never breaks it; a closed tab's history is never resurrected by a
 * flow that finishes after the drop; a detached flow gets one terminal
 * record and one `flow-finished` event; and a record still `running` at
 * worker start becomes `worker-terminated`, never resumed.
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
 * The history lives in `chrome.storage.session` (read by the popup through
 * the worker) and therefore dies with the browser session BY DESIGN. This
 * is an operator view, not an audit log.
 */

import type { Clock } from '../ports/clock.js';
import type { DetachedFlowStore } from '../ports/detached-flow-store.js';
import type { FlowHistoryStore } from '../ports/flow-history-store.js';
import type { DetachedFlowRecord, FlowHistoryEntry } from '../ports/values.js';
import {
  detachedFlowRecordsToEvict,
  finishedDetachedFlowRecord,
  minimalDetachedFlowRecord,
  startedDetachedFlowRecord,
  terminatedDetachedFlowRecord,
} from './detached-flows.js';
import type { FlowResult } from './flow-engine.js';
import { isFlowOutcome, isFlowStopReason, summarizeFlow, type FlowRun } from './flow-run.js';

/** How many completed flows are kept per tab. Small on purpose — this is a
 * "what just happened on this tab" panel in a 320px-wide popup, not a log. */
export const MAX_FLOW_HISTORY_PER_TAB = 20;

/** Storage key holding one tab's flow history. Keyed by the CHROME tab id
 * (not the browser-link `tab_N` id) because the popup only ever knows the
 * former, and a tab that reconnects under a new browser-link id is still
 * the same tab to the human looking at it. */
export function flowHistoryKey(tabId: number): string {
  return `flow-history:${tabId}`;
}

/**
 * Reduce a finished flow to a history entry — the ONE place a summary is
 * allowed to turn into POPUP-visible stored state, and therefore the one
 * place the privacy contract has to hold. Nothing is copied across by
 * spread: every field is named, typed and numeric/enum, and the summary's
 * `error` is deliberately not among them.
 */
export function toHistoryEntry(
  entry: FlowRun,
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
 * drops the oldest. */
export function appendFlowHistory(
  existing: readonly FlowHistoryEntry[],
  entry: FlowHistoryEntry,
): FlowHistoryEntry[] {
  return [entry, ...existing].slice(0, MAX_FLOW_HISTORY_PER_TAB);
}

/** Narrow whatever the store hands back into a history list. Storage is
 * not a trusted, typed channel (an older extension version may have
 * written a different shape, and the value survives a service-worker
 * restart), so an entry that does not carry the required primitives is
 * dropped rather than rendered as `undefined`. */
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

/** The history entry for a flow the service worker was killed under. The
 * live run is gone, so this is reconstructed from the persisted record —
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

export interface FlowHistoryDeps {
  history: FlowHistoryStore;
  detached: DetachedFlowStore;
  clock: Clock;
  /** Push the one-per-flow `flow-finished` event of a detached flow toward
   * the server; false when it did not go out (the tab's socket is closed). */
  publish: (tabId: number, record: DetachedFlowRecord) => boolean;
  /** Told when a terminal record could not be stored even without its
   * manifest. */
  onRecordLost: (flowId: string) => void;
}

export interface FlowHistory {
  /** The tab's history, newest first; `[]` when the store cannot be read. */
  entries(tabId: number): Promise<FlowHistoryEntry[]>;
  /** Retire a finished run: prepend its outcome to its tab's history (unless
   * the tab was dropped after the run started) and, for a detached run,
   * publish its event (deferred onto the record when it cannot go out) and
   * store its terminal record. Never throws. */
  recordFinished(run: FlowRun, result: FlowResult | null, endedAt: number): void;
  /** Store a detached run's launch record, pruning old manifests and
   * retrying once when the store refuses. False: genuinely unstored, and
   * the flow must not start. */
  persistLaunch(run: FlowRun): Promise<boolean>;
  /** The record of one detached flow, after every queued write landed;
   * `undefined` when there is none or the store cannot be read. */
  record(flowId: string): Promise<DetachedFlowRecord | undefined>;
  /** Worker start: every record still `running` is orphaned; it becomes
   * `failed` / `worker-terminated` with its history entry, never resumed. */
  recover(): Promise<void>;
  /** Publish the events still owed by the tab's detached flows, once each. */
  flushPendingEvents(tabId: number): Promise<void>;
  /** The tab closed: drop its history, and keep runs that started before
   * now from writing it back. */
  dropTab(tabId: number): void;
  /** A tab connected under this Chrome id: its flows write history again. */
  tabConnected(tabId: number): void;
}

export function createFlowHistory(deps: FlowHistoryDeps): FlowHistory {
  /** Serializes EVERY flow-related store mutation — history appends,
   * detached-record writes, and the history drop when a tab closes.
   * Appending is a read-modify-write over an async store, so two flows on
   * the same tab finishing microseconds apart would otherwise both read the
   * same list and the second save would drop the first's entry; and a
   * tab-removal drop OUTSIDE the chain could be overtaken by a still-running
   * flow's late append, resurrecting the key it just dropped. One global
   * chain (rather than one per tab or one per concern) is enough: these
   * writes happen a handful of times per flow, never in a hot path. */
  let writes: Promise<void> = Promise.resolve();

  /** Chrome tab ids whose flow history has been dropped because the tab
   * closed, and WHEN. Chrome reuses tab ids within a session, so the
   * timestamp matters: a flow that started before the removal belongs to
   * the tab that is gone and must not be written back (that is the
   * resurrection the serialized chain alone cannot prevent, since the late
   * write is queued after the drop); a flow that started after it belongs
   * to whatever tab holds the id now. Cleared when a tab connects under the
   * id again, so this never grows past live-plus-recently-closed tabs. */
  const droppedAt = new Map<number, number>();

  /** Flows whose summary event is being flushed right now. `eventPending`
   * is only cleared by a write queued AFTER the event goes out, so two fast
   * reconnects of the same tab can both read the same still-pending record
   * and publish its event twice — an audit trail that double-counts a flow
   * is as wrong as one that drops it. Membership holds from the send until
   * the clearing write settles; a write that failed leaves the flag set,
   * and the next flush legitimately retries. */
  const flushing = new Set<string>();

  /** Append one unit of work to the chain. Swallows failures so a single
   * storage error cannot poison every later write — the session store dies
   * with the browser anyway, so a lost entry is not worth surfacing. */
  function queue(work: () => Promise<void>): Promise<void> {
    writes = writes.then(work).catch(() => {
      // Best effort, and the chain must survive.
    });
    return writes;
  }

  /** Same chain, but the caller learns whether the write landed. A lost
   * detached-flow record is not a lost entry: the launch record is a flow's
   * only evidence, and a lost terminal write leaves a stale `running` record
   * the next worker start reads as an orphan. The rejection is converted to
   * `false`, never rethrown, so the chain survives as it does above. */
  function queueTracked(work: () => Promise<void>): Promise<boolean> {
    const tracked = writes.then(work).then(
      () => true,
      () => false,
    );
    writes = tracked.then(() => undefined);
    return tracked;
  }

  /** Every stored record; none when the store cannot be read. */
  function allRecords(): Promise<DetachedFlowRecord[]> {
    return deps.detached.list().catch(() => []);
  }

  /** Prepend one entry to a tab's history, on the chain. */
  function append(tabId: number, entry: FlowHistoryEntry): void {
    void queue(async () => {
      const existing = await deps.history.load(tabId);
      await deps.history.save(tabId, appendFlowHistory(existing, entry));
    });
  }

  /** Store one record and enforce the record cap, on the chain, so a launch
   * write and the matching terminal write can never land out of order.
   * Reports whether THE RECORD landed; the cap sweep that follows is best
   * effort and must not make a stored record look lost. */
  function write(record: DetachedFlowRecord): Promise<boolean> {
    return queueTracked(async () => {
      await deps.detached.put(record);
      try {
        const evict = detachedFlowRecordsToEvict(await allRecords());
        if (evict.length === 0) return;
        await deps.detached.remove(evict.map((r) => r.flowId));
      } catch {
        // Over the cap until the next write sweeps again.
      }
    });
  }

  /** Free quota by dropping every terminal record not still owing its
   * summary event. Only after a refused write: at that point old manifests
   * are worth less than the launch record of a flow about to act.
   *
   * The sweep is deliberately GLOBAL, not scoped to the launching tab: it
   * can discard a finished flow's manifest that another tab's agent had not
   * read yet. That is the accepted trade. The alternative is refusing the
   * launch, which leaves a flow about to do irreversible work with no
   * record proving it started — and an unread manifest is recoverable by
   * looking at the page, while a missing launch record makes a killed
   * worker undetectable. */
  function prune(): Promise<boolean> {
    return queueTracked(async () => {
      const stale = (await allRecords()).filter(
        (r) => r.state !== 'running' && r.eventPending !== true,
      );
      if (stale.length === 0) return;
      await deps.detached.remove(stale.map((r) => r.flowId));
    });
  }

  /** Store the terminal record and prove it landed. The retry STRIPS the
   * manifest instead of repeating the same write: a failed terminal write
   * does not lose an outcome, it invents a wrong one, because the stale
   * `running` record left behind is read as `worker-terminated` next start.
   * If the minimal record is refused too there is nothing left to try. */
  async function persistTerminal(record: DetachedFlowRecord): Promise<void> {
    if (await write(record)) return;
    if (await write(minimalDetachedFlowRecord(record))) return;
    deps.onRecordLost(record.flowId);
  }

  return {
    entries(tabId) {
      return deps.history.load(tabId).catch(() => []);
    },

    recordFinished(run, result, endedAt) {
      const dropped = droppedAt.get(run.tabId);
      // Skip the append entirely for a tab that has already been removed —
      // see `droppedAt`. Ordering on the chain is not enough on its own,
      // because this write is queued AFTER the drop was.
      if (dropped === undefined || dropped <= run.startedAt) {
        append(run.tabId, toHistoryEntry(run, result, endedAt));
      }
      if (!run.detached) return;
      const record = finishedDetachedFlowRecord(run, result, endedAt);
      // Exactly ONE summary event per detached flow, pushed here and
      // nowhere else — never per iteration. `BridgeEventLog` holds 200
      // entries, so a single 200-iteration run emitting per-iteration events
      // would silently evict every other event in the log, which is the
      // opposite of an audit trail. If the socket is already gone the event
      // is deferred onto the record and flushed when the tab next registers.
      if (!deps.publish(run.tabId, record)) record.eventPending = true;
      void persistTerminal(record);
    },

    async persistLaunch(run) {
      const record = startedDetachedFlowRecord(run);
      if (await write(record)) return true;
      await prune();
      return write(record);
    },

    async record(flowId) {
      // Drains the chain first so a status poll landing microseconds after
      // a flow ended never reports the stale `running` launch record.
      try {
        await writes;
        return (await deps.detached.list()).find((r) => r.flowId === flowId);
      } catch {
        return undefined;
      }
    },

    async recover() {
      // Runs ONCE per worker start, before anything can register a flow, so
      // every `running` record found is by definition orphaned: the loop
      // that owned it lived in the dead worker's memory (see
      // `terminatedDetachedFlowRecord` for why it is never resumed).
      const now = deps.clock.now();
      for (const record of await allRecords()) {
        const terminated = terminatedDetachedFlowRecord(record, now);
        if (!terminated) continue;
        void write(terminated);
        append(terminated.tabId, terminatedFlowHistoryEntry(terminated));
      }
    },

    async flushPendingEvents(tabId) {
      // Drain the chain first: a terminal record still queued reads as a
      // stale `running` one, with no event to flush.
      await writes;
      for (const record of await allRecords()) {
        if (record.tabId !== tabId || record.eventPending !== true) continue;
        if (flushing.has(record.flowId)) continue;
        flushing.add(record.flowId);
        if (!deps.publish(tabId, record)) {
          flushing.delete(record.flowId);
          return;
        }
        const { eventPending: _sent, ...flushed } = record;
        void write(flushed).then((stored) => {
          // A refused clearing write must keep the flag: storage still says
          // eventPending, so releasing it here would republish a sent event.
          if (stored) flushing.delete(record.flowId);
        });
      }
    },

    dropTab(tabId) {
      droppedAt.set(tabId, deps.clock.now());
      void queue(() => deps.history.drop(tabId));
    },

    tabConnected(tabId) {
      droppedAt.delete(tabId);
    },
  };
}
