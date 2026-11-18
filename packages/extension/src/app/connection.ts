// The extension's connection lifecycle (design 6.1, slice 19): the tab ids
// remembered across reconnects, the reconnect wiring (scheduler, persisted
// state, the alarm safety net, the resume after a worker restart), the
// tab's bridge socket with its server-message switch, and the correlated
// round trips other windows make over any open socket. No `chrome`:
// `background.ts` passes in the adapters and the Chrome calls.

import type {
  ActivityPurgeResultMessage,
  ActivityResultMessage,
  AdminActionResultMessage,
  AdminStateMessage,
  BridgeRepairResultMessage,
  ExtensionToServer,
  ServerToExtension,
  SettingsUpdatePayload,
  TabRegisterPayload,
  ToolRequestMessage,
} from '@browser-link/shared';
import type { Clock, PendingReplies, TabRegistry } from '@browser-link/core';
import { createConnectFailureTracker } from '../connect-failure-policy.js';
import { pendingDocInfoEvent } from '../doc-info-event.js';
import {
  ALARM_MIN_DELAY_MS,
  createReconnectScheduler,
  isInvoluntaryClose,
  planResume,
  reconnectStorageKey,
  tabIdFromReconnectKey,
  type ReconnectScheduler,
} from '../reconnect-policy.js';
import { prevTabIdKey } from '../repair-policy.js';
import { workerFailure, type WorkerMessage } from '../worker-messages.js';
import { SOCKET_OPEN, send, type BridgeSocket, type TabConnection } from './tab-connection.js';

export interface ConnectResult {
  ok: boolean;
  error?: string;
  serverTabId?: string;
}

export interface StatusResult {
  connected: boolean;
  serverTabId?: string;
  /** Present (true) only while the auto-reconnect scheduler has a retry
   * pending for this tab — lets the popup show "Reconnecting" instead of
   * a flat "Not connected" that would misrepresent the in-flight retry. */
  reconnecting?: boolean;
}

/** Named one-shot wake-ups (`adapters/chrome-alarms.ts`). */
export interface Alarms {
  /** Fire `name` at `when` (ms since the epoch); replaces an alarm of that name. */
  set(name: string, when: number): Promise<void>;
  clear(name: string): Promise<void>;
  /** Called with the name of every alarm that fires. A wake listener:
   * subscribed only at the top level of `background.ts` (R1). */
  onFire(listener: (name: string) => void): void;
}

/** Opens the tab's socket to the bridge (`adapters/web-socket.ts`). */
export type SocketFactory = (url: string) => BridgeSocket;

/** The worker's session storage, as `chrome.storage.session` answers it. */
export interface SessionStorage {
  get(keys: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
}

// === Tab ids ==============================================================

/**
 * The browser-link tab_id each Chrome tab had, kept in session storage
 * (cleared when the browser restarts), so a reconnect after a primary swap
 * asks the new primary to keep the same tab_id and the agent does not see
 * stale ids after a re-election. Every failure is non-fatal: the worst case
 * is a fresh id on the next reconnect.
 */
export interface TabIds {
  previous(chromeTabId: number): Promise<string | undefined>;
  store(chromeTabId: number, serverTabId: string): Promise<void>;
  forget(chromeTabId: number): Promise<void>;
}

export function createTabIds(storage: SessionStorage): TabIds {
  return {
    async previous(chromeTabId) {
      const key = prevTabIdKey(chromeTabId);
      try {
        const data = await storage.get(key);
        const v = data[key];
        return typeof v === 'string' ? v : undefined;
      } catch {
        return undefined;
      }
    },
    async store(chromeTabId, serverTabId) {
      try {
        await storage.set({ [prevTabIdKey(chromeTabId)]: serverTabId });
      } catch {
        /* storage failure is non-fatal — worst case the next reconnect gets a fresh id */
      }
    },
    async forget(chromeTabId) {
      try {
        await storage.remove(prevTabIdKey(chromeTabId));
      } catch {
        /* ignore */
      }
    },
  };
}

// === Reconnect wiring =====================================================

export interface ReconnectDeps {
  storage: SessionStorage;
  alarms: Alarms;
  clock: Clock;
  tabs: TabRegistry<TabConnection>;
  /** Resolves while the Chrome tab exists, rejects once it is gone. */
  tabExists(tabId: number): Promise<unknown>;
  connect(tabId: number): Promise<ConnectResult>;
}

export interface Reconnect {
  readonly scheduler: ReconnectScheduler;
  /** Resume the cycles a killed service worker left behind. */
  resume(): Promise<void>;
  /** The `Alarms.onFire` listener: a reconnect alarm resumes from storage. */
  onAlarm(name: string): void;
}

/*
 * Auto-reconnect after an involuntary WS close (retried for up to 10 minutes).
 *
 * When a REGISTERED tab's WebSocket dies under us (unclean close — the
 * primary MCP server crashed or restarted), the scheduler retries `connect`
 * with per-tab backoff (RECONNECT_DELAYS_MS in reconnect-policy.ts), reusing
 * the preserved `prevTabId:*` id so the new primary can keep the same tab_id
 * (or emit `tab-renamed` if it can't). Every EXTENSION-initiated teardown
 * (explicit disconnect, tab removal, idle park, debugger detach) runs
 * `cleanup` BEFORE the close event dispatches, so the close handler sees an
 * untracked socket and never schedules; a CLEAN close from the server
 * (browser.reset) is a deliberate goodbye and never schedules either — the
 * popup Connect button stays the fallback for both.
 *
 * MV3 durability: each scheduled attempt is mirrored into session storage
 * (`pendingReconnect:*`, next to the `prevTabId:*` keys). Plain timers cover
 * the common case — the backoff span sits inside the service worker's idle
 * grace, and every attempt touches chrome.* APIs which resets the idle
 * clock — but if the worker is killed anyway, `resume` picks the budget
 * back up on the next wake, and entries older than RECONNECT_STATE_TTL_MS
 * are discarded rather than surprising the user long after they moved on.
 * An alarm (same key) wakes the worker for the long 30s steps, and a
 * resumed attempt waits only the time that was left.
 */
export function createReconnect(deps: ReconnectDeps): Reconnect {
  const { storage, alarms, clock, tabs } = deps;

  async function storeState(tabId: number, attempt: number, delayMs: number): Promise<void> {
    const now = clock.now();
    const dueAt = now + delayMs;
    try {
      await storage.set({ [reconnectStorageKey(tabId)]: { attempt, updatedAt: now, dueAt } });
    } catch {
      /* non-fatal — worst case a killed service worker cannot resume this retry */
    }
    // Safety net for the 30s plateau: Chrome may tear the worker down between
    // attempts, and a plain timer dies with it. The alarm (keyed like the
    // storage entry) wakes the worker, which resumes from storage. Setting
    // an alarm with the same name replaces it, so each arm moves it forward.
    try {
      await alarms.set(reconnectStorageKey(tabId), Math.max(dueAt, now + ALARM_MIN_DELAY_MS));
    } catch {
      /* non-fatal — the in-worker timer still runs while the worker lives */
    }
  }

  async function clearState(tabId: number): Promise<void> {
    try {
      await storage.remove(reconnectStorageKey(tabId));
    } catch {
      /* ignore */
    }
    try {
      await alarms.clear(reconnectStorageKey(tabId));
    } catch {
      /* ignore */
    }
  }

  const scheduler = createReconnectScheduler({
    attempt: async (tabId) => {
      try {
        await deps.tabExists(tabId);
      } catch {
        // The Chrome tab itself is gone — nothing left to reconnect.
        return 'stop';
      }
      const existing = tabs.get(tabId);
      if (existing) {
        // A live bridge already exists (e.g. the user pressed Connect while
        // a retry was pending) — done. A connection whose socket is not OPEN
        // yet belongs to a connect attempt still mid-flight (cleanup removes
        // it synchronously, so it never lingers here); keep the backoff going
        // instead of declaring victory early.
        return existing.ws?.readyState === SOCKET_OPEN ? 'connected' : 'retry';
      }
      try {
        const result = await deps.connect(tabId);
        return result.ok ? 'connected' : 'retry';
      } catch {
        return 'retry';
      }
    },
    onStateChange: (tabId, state) => {
      if (state) void storeState(tabId, state.attempt, state.delayMs);
      else void clearState(tabId);
    },
  });

  // Session storage survives worker restarts but not browser restarts,
  // which is exactly the lifetime the retry budget should have.
  async function resume(): Promise<void> {
    // Take the cancellation epoch BEFORE the async read: a disconnect / manual
    // Connect / tab removal landing while the get is in flight leaves the
    // snapshot holding a stale entry, and planResume skips any tab cancelled
    // since (see ReconnectScheduler.cancel, which also always clears storage).
    const epoch = scheduler.epoch();
    let stored: Record<string, unknown>;
    try {
      stored = await storage.get(null);
    } catch {
      return;
    }
    const plan = planResume(stored, clock.now(), {
      isLive: (tabId) => tabs.has(tabId),
      cancelledSince: (tabId) => scheduler.wasCancelledSince(tabId, epoch),
    });
    // Wait only what was left of the pending step (0 = due already).
    for (const r of plan.resume) scheduler.schedule(r.tabId, r.attempt, r.delayMs);
    for (const tabId of plan.discard) void clearState(tabId);
  }

  return {
    scheduler,
    resume,
    // Tabs whose cycle is already live in this worker are skipped by `schedule`.
    onAlarm: (name) => {
      if (tabIdFromReconnectKey(name) !== null) void resume();
    },
  };
}

/** Explicit disconnect from the popup. */
export async function disconnectTab(
  tabId: number,
  deps: { scheduler: ReconnectScheduler; cleanup(tabId: number): Promise<void>; tabIds: TabIds },
): Promise<{ ok: boolean }> {
  // Explicit user intent beats any pending auto-reconnect — cancel it
  // first so a scheduled retry cannot resurrect the bridge right after
  // the user asked for it to go away.
  deps.scheduler.cancel(tabId);
  await deps.cleanup(tabId);
  // Explicit user-driven disconnect → forget the previous tab id so the
  // next "Connect" starts from a clean slate (vs. an involuntary
  // reconnect where we WANT to keep the id for continuity).
  await deps.tabIds.forget(tabId);
  return { ok: true };
}

/** What the popup shows for a tab. */
export function tabStatus(
  tabs: TabRegistry<TabConnection>,
  scheduler: ReconnectScheduler,
  tabId: number,
): StatusResult {
  const state = tabs.get(tabId);
  if (!state) {
    // Keep the popup truthful while auto-reconnect is working: "not
    // connected, but actively retrying" rather than a flat idle state.
    // The registry's reservation covers the short gap inside a live attempt
    // before its connection lands — without it the popup's poll could
    // misread that gap as idle and freeze the card there.
    if (scheduler.isPending(tabId) || tabs.isReservedOrLive(tabId)) {
      return { connected: false, reconnecting: true };
    }
    return { connected: false };
  }
  return { connected: true, serverTabId: state.serverTabId };
}

// === Round trips over any open socket =====================================

/** `activity.query` / `activity.purge` replies. */
export type ActivityReply = ActivityResultMessage | ActivityPurgeResultMessage;
/** `admin.describe` / `admin.action` replies. */
export type AdminReply = AdminStateMessage | AdminActionResultMessage;
/** A `bridge.repair` reply, or its timeout. */
export type RepairReply = BridgeRepairResultMessage | 'timeout';

/**
 * The in-flight round trips, by request id: the Activity window can have
 * several reads outstanding (an initial page, a tail poll, a filter change),
 * the popup re-describes the Admin state after every applied action, and a
 * repair waits for its answer. A reply whose id is no longer waited for is
 * a superseded or timed-out request and is dropped.
 */
export interface BridgeReplies {
  activity: PendingReplies<ActivityReply>;
  admin: PendingReplies<AdminReply>;
  repair: PendingReplies<RepairReply>;
}

/**
 * The open socket of any connected tab. The trail, the console and the
 * repair are server-wide, so which tab carries the question is irrelevant;
 * but the socket is the only channel the extension has, so without one the
 * caller answers `not-connected`.
 */
export function anyOpenSocket(tabs: TabRegistry<TabConnection>): BridgeSocket | undefined {
  return [...tabs.values()]
    .map((s) => s.ws)
    .find((ws): ws is BridgeSocket => ws !== undefined && ws.readyState === SOCKET_OPEN);
}

/** Send the frame of a new request id on `socket` and wait for its reply;
 * after `timeoutMs` the answer is `onTimeout(requestId)`. */
export function roundTrip<T>(
  replies: PendingReplies<T>,
  socket: BridgeSocket,
  frame: (requestId: string) => ExtensionToServer,
  timeoutMs: number,
  onTimeout: (requestId: string) => T,
): Promise<T> {
  const requestId = crypto.randomUUID();
  const reply = replies.wait(requestId, timeoutMs, () => onTimeout(requestId));
  send(socket, frame(requestId));
  return reply;
}

// === The tab's bridge socket ==============================================

export interface BridgeDeps {
  tabs: TabRegistry<TabConnection>;
  /** The connection the socket belongs to, already live in `tabs`. */
  state: TabConnection;
  openSocket: SocketFactory;
  url: string;
  /** The `tab.register` payload sent when the socket opens. */
  register: TabRegisterPayload;
  tabIds: TabIds;
  scheduler: ReconnectScheduler;
  replies: BridgeReplies;
  /** Deliver the `flow-finished` events deferred while the tab was disconnected. */
  flushPendingEvents(tabId: number): void;
  applySettings(settings: SettingsUpdatePayload): void;
  handleTool(msg: ToolRequestMessage): Promise<ExtensionToServer>;
  cancelFlow(flowId: string, reason: 'expired' | undefined): void;
  cleanup(tabId: number): Promise<void>;
  /** Asks the bridge why a connect failed. */
  diagnose(): Promise<WorkerMessage>;
}

function safeParse(raw: string): ServerToExtension | null {
  try {
    return JSON.parse(raw) as ServerToExtension;
  } catch {
    return null;
  }
}

/**
 * Open the tab's socket, register the tab when it opens, route every server
 * message, and settle with the registration (or the failure before it).
 */
export function openBridge(deps: BridgeDeps): Promise<ConnectResult> {
  const { tabs, state, replies } = deps;
  const { tabId } = state;
  const ws = deps.openSocket(deps.url);
  state.ws = ws;

  return new Promise<ConnectResult>((resolve) => {
    let settled = false;
    const settle = (result: ConnectResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    ws.addEventListener('open', () => {
      send(ws, { kind: 'tab.register', payload: deps.register });
    });

    ws.addEventListener('message', (ev) => {
      void (async () => {
        const msg = safeParse(typeof ev.data === 'string' ? ev.data : '');
        if (!msg) return;
        // Exhaustive routing over ServerToExtension. The `default` branch
        // pins `msg` to `never`, so adding a message kind to the union fails
        // to COMPILE here instead of silently misrouting it.
        switch (msg.kind) {
          case 'tab.registered': {
            // A successful registration ends any reconnect cycle for this
            // tab. Covers the resume path re-arming a tab the user just
            // connected manually (resume's live check races the connect);
            // when the SCHEDULER drove this very connect, its in-flight
            // guard makes this cancel a clean, notify-once end of the cycle.
            deps.scheduler.cancel(tabId);
            state.serverTabId = msg.payload.tabId;
            // serverVersion is optional on the wire so older servers that
            // predate the field still parse — narrow on `typeof string`.
            if (typeof msg.payload.serverVersion === 'string') {
              state.serverVersion = msg.payload.serverVersion;
            }
            // Same narrowing for the 0.41.0 fields.
            if (typeof msg.payload.installedVersion === 'string') {
              state.installedVersion = msg.payload.installedVersion;
            }
            if (typeof msg.payload.serverPid === 'number') {
              state.serverPid = msg.payload.serverPid;
            }
            // Remember this id so the next reconnect (after a primary swap)
            // asks the new primary to honour it. The primary emits
            // `tab-renamed` in the bridge event log if it can't.
            void deps.tabIds.store(tabId, msg.payload.tabId);
            // First moment there is a socket to send them on: deliver the
            // summary events of any detached flow that ended while this
            // tab was disconnected, including everything the worker was
            // killed under.
            deps.flushPendingEvents(tabId);
            // A fingerprint the observer pushed before this registration.
            const docInfo = pendingDocInfoEvent(state.session.driver.observer, msg.payload.tabId);
            if (docInfo) send(ws, docInfo);
            settle({ ok: true, serverTabId: msg.payload.tabId });
            return;
          }
          case 'settings.update': {
            // Housekeeping, not agent activity — deliberately does NOT touch
            // the session's activity: counting a server-pushed settings sync
            // as activity would let it keep an otherwise-idle tab connected
            // forever, defeating the idle TTL it is updating.
            deps.applySettings(msg.settings);
            return;
          }
          case 'flow.recorded.result': {
            // Not agent/tool activity either — same rationale as above.
            const pending = state.pendingFlowSave;
            if (!pending) return;
            if (msg.ok) pending({ ok: true });
            else pending({ ok: false, error: msg.error });
            return;
          }
          case 'tool.request': {
            // The request is activity, the call holds the idle clock while it
            // runs, and its reply is activity too (BL-EXT-098).
            const response = await state.session.runCall(() => deps.handleTool(msg));
            if (ws.readyState === SOCKET_OPEN) send(ws, response);
            return;
          }
          case 'tool.cancel': {
            // Deliberately answered with SILENCE: the cancelled flow is
            // still parked in its own tool.request and replies there,
            // cleanly, with stopped_by:'cancelled' and its partial
            // results. An unknown or already-finished flow_id is a no-op.
            //
            // Counts as activity: an agent reaching for the kill switch is
            // very much using this tab, and letting the idle sweeper close
            // the bridge underneath it would be perverse.
            state.session.touch();
            deps.cancelFlow(msg.flow_id, msg.reason === 'expired' ? 'expired' : undefined);
            return;
          }
          // Both activity replies settle the same way — a purge is just a
          // request that happens to change something. Deliberately NOT counted
          // as tab activity: the human reading the trail is not using the tab,
          // and refreshing a panel must never keep an idle bridge alive.
          case 'activity.purge.result':
          case 'activity.result': {
            replies.activity.settle(msg.request_id, msg);
            return;
          }
          // Not tab activity either: only the popup's Admin section waits on it.
          case 'admin.state':
          case 'admin.action.result': {
            replies.admin.settle(msg.request_id, msg);
            return;
          }
          case 'bridge.repair.result': {
            // Not tab activity: the popup's Repair button is waiting on it.
            replies.repair.settle(msg.request_id, msg);
            return;
          }
          default: {
            // Compile-time exhaustiveness check; at runtime an unknown kind
            // (newer server, older extension) is ignored defensively.
            const _exhaustive: never = msg;
            return;
          }
        }
      })();
    });

    // A WebSocket 'error' is always followed by a 'close', so teardown
    // lives in the close handler alone; settling a pre-registration connect
    // failure (with the bridge's diagnosis after an error) is
    // connect-failure-policy.ts's.
    const connectFailure = createConnectFailureTracker({
      isSettled: () => settled,
      settle: (message) => {
        settle(workerFailure(message));
      },
      diagnose: () => deps.diagnose(),
    });
    ws.addEventListener('error', () => {
      connectFailure.onError();
    });

    ws.addEventListener('close', (ev) => {
      const current = tabs.get(tabId);
      if (current !== undefined && current.ws !== ws) {
        // A newer connection already owns this tab — this close belongs to
        // a superseded socket, and tearing state down here would kill the
        // NEW bridge rather than the one that just died.
        settle(workerFailure({ code: 'ws-closed-before-registration' }));
        return;
      }
      // Decide BEFORE cleanup wipes the evidence: an unclean close of a
      // still-tracked, registered connection means the server died under
      // us — the one case the auto-reconnect scheduler exists for. Every
      // other close (explicit disconnect, tab removal, idle park,
      // browser.reset's clean goodbye) falls out of this predicate.
      const involuntary = isInvoluntaryClose({
        tracked: current?.ws === ws,
        registered: current?.serverTabId !== undefined,
        wasClean: ev.wasClean,
      });
      void deps.cleanup(tabId).catch(() => {
        // Best effort — already-detached state is fine.
      });
      connectFailure.onClose();
      if (involuntary) deps.scheduler.schedule(tabId);
    });
  });
}
