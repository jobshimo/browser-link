// GENERATED from packages/core/src/session/tab-session.ts. Do not edit.
// The per-tab page state of a connected tab (design section 4, `TabSession`):
// the idle clock and what holds it, the bounded console and network buffers,
// the pending JavaScript dialog (the `PendingDialog` of
// `session/dialog-intake.ts`, composed here) and the tab's page driver. No socket, no
// server metadata: the extension's `app/tab-connection.ts` holds a
// `TabSession`, never the other way round. Only the extension uses it;
// cdp-direct keeps its own idle model (design section 8, Q4).

import type { Clock } from '../ports/clock.js';
import {
  activityAfterFlowEnded,
  MAX_CALL_HOLD_MS,
  shouldDisconnectForIdle,
  type IdleFlowHold,
} from '../policies/idle-rules.js';
import type {
  CaptureWatch,
  ConsoleEntry,
  DialogWatch,
  NetworkEntry,
  PageDriverHandle,
} from './page-driver.js';
import { PendingDialog, type PendingDialogInfo } from './dialog-intake.js';

/** Console entries kept per tab; the oldest is dropped first. */
export const CONSOLE_BUFFER_MAX = 200;
/** Network entries kept per tab; the oldest request is dropped first. */
export const NETWORK_BUFFER_MAX = 200;

/** A tool call the tab is still answering. */
export interface CallInProgress {
  /** When its request arrived (the activity touch that started it). */
  readonly startedAt: number;
}

export interface TabSessionDeps {
  clock: Clock;
  /** The tab's page driver: its observer mirror is the observer state of
   * the session (`observer.installed === false` means actions report
   * `settle.changes: null`; `uninstall` removes the script id). */
  driver: PageDriverHandle;
}

/**
 * Invariants:
 * 1. Activity is touched with the clock's time; the end of a call sets it to
 *    `max(lastActivityAt, now)`, so with a clock that does not go backwards
 *    it never decreases.
 * 2. `runCall(fn)` holds the idle clock while `fn` runs and releases the
 *    hold on every exit path, throw included; a hold never counts past
 *    `MAX_CALL_HOLD_MS`.
 * 3. What counts as activity is the caller's choice: it calls `touch` (or
 *    `runCall`) for a tool request and a `tool.cancel`, and nothing else.
 * 4. A running flow holds the tab until its `idleHoldUntil` bound
 *    (`idleCandidate`); a finished flow's end is activity (`flowEnded`).
 * 5. The console buffer holds at most `CONSOLE_BUFFER_MAX` entries and the
 *    network buffer at most `NETWORK_BUFFER_MAX`, oldest dropped first;
 *    `networkOrder` and `networkBuffer` always hold the same ids.
 * 6. At most one pending dialog: opening replaces it, closing clears it
 *    (the invariant of `PendingDialog`, which `dialog` is).
 */
export class TabSession {
  readonly driver: PageDriverHandle;
  private readonly clock: Clock;
  private activityAt: number;
  private readonly calls = new Set<CallInProgress>();
  private readonly consoleEntries: ConsoleEntry[] = [];
  private readonly networkEntries = new Map<string, NetworkEntry>();
  private readonly networkIds: string[] = [];
  /** The tab's pending dialog: the state the dialog intake writes. */
  readonly dialog = new PendingDialog();

  constructor({ clock, driver }: TabSessionDeps) {
    this.clock = clock;
    this.driver = driver;
    this.activityAt = clock.now();
  }

  /** The last time the tab saw activity (a tool request, a `tool.cancel`,
   * the end of a call or of a flow, or the connect itself). */
  get lastActivityAt(): number {
    return this.activityAt;
  }

  /** Activity now: a tool request or a `tool.cancel` arrived. */
  touch(): void {
    this.activityAt = this.clock.now();
  }

  /** Run one tool call: touch the clock, hold it while `fn` runs, and on
   * every exit path release the hold and count the end as activity. */
  async runCall<T>(fn: () => Promise<T>): Promise<T> {
    this.touch();
    const call: CallInProgress = { startedAt: this.activityAt };
    this.calls.add(call);
    try {
      return await fn();
    } finally {
      this.calls.delete(call);
      this.activityAt = Math.max(this.activityAt, this.clock.now());
    }
  }

  /** The calls this tab is still answering. */
  callsInProgress(): readonly CallInProgress[] {
    return [...this.calls];
  }

  /** A flow on this tab ended at `endedAt`: its last step is the tab's last
   * activity (owner decision D1). */
  flowEnded(endedAt: number): void {
    this.activityAt = activityAfterFlowEnded(this.activityAt, endedAt);
  }

  /** Whether the idle sweep disconnects this tab at `now`, given the TTL and
   * the `idleHoldUntil` bound of every flow running on it. A call in
   * progress holds it like a flow, up to `MAX_CALL_HOLD_MS`. */
  idleCandidate(now: number, idleTtlMinutes: number, flowHoldsUntil: readonly number[]): boolean {
    return shouldDisconnectForIdle(this.activityAt, now, idleTtlMinutes, [
      ...flowHoldsUntil,
      ...[...this.calls].map((c) => c.startedAt + MAX_CALL_HOLD_MS),
    ]);
  }

  get consoleBuffer(): readonly ConsoleEntry[] {
    return this.consoleEntries;
  }

  get networkBuffer(): ReadonlyMap<string, NetworkEntry> {
    return this.networkEntries;
  }

  get networkOrder(): readonly string[] {
    return this.networkIds;
  }

  pushConsole(entry: ConsoleEntry): void {
    this.consoleEntries.push(entry);
    if (this.consoleEntries.length > CONSOLE_BUFFER_MAX) this.consoleEntries.shift();
  }

  /** The network entry of `requestId`, created (and the oldest dropped past
   * the bound) the first time the request is seen. */
  networkEntry(requestId: string): NetworkEntry {
    let entry = this.networkEntries.get(requestId);
    if (!entry) {
      entry = { request_id: requestId, url: '', method: '', started_at: this.clock.now() };
      this.networkEntries.set(requestId, entry);
      this.networkIds.push(requestId);
      while (this.networkIds.length > NETWORK_BUFFER_MAX) {
        const oldId = this.networkIds.shift();
        if (oldId !== undefined) this.networkEntries.delete(oldId);
      }
    }
    return entry;
  }

  get pendingDialog(): PendingDialogInfo | undefined {
    return this.dialog.current;
  }

  dialogOpened(info: PendingDialogInfo): void {
    this.dialog.opened(info);
  }

  dialogClosed(): void {
    this.dialog.closed();
  }
}

/** A dialog watch that reads, on every call, the pending dialog of the
 * session `current()` returns (none: no dialog). */
export function sessionDialogWatch(current: () => TabSession | undefined): DialogWatch {
  return { isOpen: () => current()?.dialog.isOpen() === true };
}

/** A capture watch over `session`'s console and network buffers, read
 * live on every call: the console messages, the requests in the order they
 * were first seen, and the URLs of those that have finished. */
export function sessionCaptureWatch(session: TabSession): CaptureWatch {
  return {
    *finishedUrls() {
      for (const id of session.networkOrder) {
        const entry = session.networkBuffer.get(id);
        if (entry?.finished_at !== undefined) yield entry.url;
      }
    },
    consoleEntries: () => session.consoleBuffer,
    networkEntries: () =>
      session.networkOrder
        .map((id) => session.networkBuffer.get(id))
        .filter((entry): entry is NetworkEntry => entry !== undefined),
  };
}

/** The tabs one idle-sweep tick disconnects: every session whose
 * `idleCandidate` holds at `now`, given the running flows' holds. */
export function idleTabs(
  sessions: Iterable<readonly [number, TabSession]>,
  holds: readonly IdleFlowHold[],
  now: number,
  idleTtlMinutes: number,
): number[] {
  const idle: number[] = [];
  for (const [tabId, session] of sessions) {
    const tabHolds = holds.filter((h) => h.tabId === tabId).map((h) => h.holdUntil);
    if (session.idleCandidate(now, idleTtlMinutes, tabHolds)) idle.push(tabId);
  }
  return idle;
}
