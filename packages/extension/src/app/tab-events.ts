// What the worker does when the browser reports a tab event (design 6.1,
// slice 21): a closed tab, a tab opened by a connected one (auto-connect for
// `browser.wait_for_tab`), and a debugger the browser detached. No `chrome`:
// `background.ts` subscribes the `TabEvents` adapter
// (`adapters/chrome-tab-events.ts`) at top level and calls these handlers.

import type { Clock, TabRegistry } from '@browser-link/core';
import type { ReconnectScheduler } from '../reconnect-policy.js';
import type { ConnectResult, TabIds } from './connection.js';
import { SOCKET_OPEN, send, type TabConnection } from './tab-connection.js';

/** One tab update, as `TabEvents.onUpdated` hands it on. */
export interface TabUpdate {
  tabId: number;
  /** The tab's load status of the update (`complete` ends a load). */
  status?: string;
  /** The tab's URL after the update. */
  url?: string;
}

/** A tab the browser just created, and the tab that opened it, if any. */
export interface CreatedTab {
  tabId?: number;
  openerTabId?: number;
}

/** What the browser answers about one tab. */
export interface TabInfo {
  url?: string;
  pendingUrl?: string;
  title?: string;
}

/**
 * The tab events the extension uses (design 3.1 `TabEvents`,
 * `adapters/chrome-tab-events.ts`). `get` and `onUpdated` serve flow
 * recording and the auto-connect below; `onRemoved`, `onCreated` and
 * `onDebuggerDetach` are wake listeners, subscribed only at the top level of
 * `background.ts` (R1).
 */
export interface TabEvents {
  /** The tab's current URLs and title; rejects for a closed tab. */
  get(tabId: number): Promise<TabInfo>;
  /** Report every tab update; returns the function that stops the reports. */
  onUpdated(listener: (update: TabUpdate) => void): () => void;
  /** Called with the id of every tab that closes. */
  onRemoved(listener: (tabId: number) => void): void;
  /** Called with every tab the browser creates. */
  onCreated(listener: (tab: CreatedTab) => void): void;
  /** Called with the tab id (undefined for a target that is not a tab) of
   * every debugger session the browser detached. */
  onDebuggerDetach(listener: (tabId: number | undefined) => void): void;
}

/** How long a tab opened by a connected tab may take to report a real URL. */
export const OPENED_TAB_URL_WAIT_MS = 5_000;
/** How often its URL is read in the meantime. */
export const OPENED_TAB_URL_POLL_MS = 50;

export interface TabEventDeps {
  tabs: TabRegistry<TabConnection>;
  tabEvents: Pick<TabEvents, 'get'>;
  clock: Clock;
  scheduler: Pick<ReconnectScheduler, 'cancel'>;
  tabIds: Pick<TabIds, 'forget'>;
  connect(tabId: number): Promise<ConnectResult>;
  /** Tear the tab's connection down (`closeTabConnection`). */
  cleanup(tabId: number): Promise<void>;
  /** Drop the tab's flow history (`FlowHistory.dropTab`). */
  dropFlowHistory(tabId: number): void;
}

export interface TabEventHandlers {
  removed(tabId: number): void;
  created(tab: CreatedTab): void;
  debuggerDetached(tabId: number | undefined): void;
}

/** Stateless: everything it changes lives in what it is given. */
export function createTabEventHandlers(deps: TabEventDeps): TabEventHandlers {
  /** Connect the tab a connected tab opened and announce it as `tab-created`. */
  async function autoConnect(newTabId: number, openedFrom: string): Promise<void> {
    // Wait until the browser reports a real `url`. `pendingUrl` alone
    // is NOT enough — connectTab's guard short-circuits on `!tab.url`.
    // Bound at 5 s so a never-navigating tab doesn't park us forever.
    const deadline = deps.clock.now() + OPENED_TAB_URL_WAIT_MS;
    let ready = false;
    while (deps.clock.now() < deadline) {
      try {
        const t = await deps.tabEvents.get(newTabId);
        if (t.url && t.url.length > 0) {
          ready = true;
          break;
        }
      } catch {
        return;
      }
      await deps.clock.sleep(OPENED_TAB_URL_POLL_MS);
    }
    if (!ready) return;

    try {
      const result = await deps.connect(newTabId);
      if (!result.ok || !result.serverTabId) return;
      const newState = deps.tabs.get(newTabId);
      if (!newState?.ws || newState.ws.readyState !== SOCKET_OPEN) return;
      let resolvedUrl = '';
      try {
        const settled = await deps.tabEvents.get(newTabId);
        resolvedUrl = settled.url ?? settled.pendingUrl ?? '';
      } catch {
        // Tab vanished between attach and read.
      }
      send(newState.ws, {
        kind: 'bridge.event',
        eventKind: 'tab-created',
        tabId: newState.serverTabId,
        data: {
          opened_from: openedFrom,
          url: resolvedUrl,
        },
      });
    } catch {
      // Auto-connect is best-effort.
    }
  }

  return {
    removed(tabId) {
      // No tab, no reconnect — abort any pending retry cycle for it.
      deps.scheduler.cancel(tabId);
      void deps.cleanup(tabId).catch(() => {
        // Best effort.
      });
      // The Chrome tab is gone — drop any cached browser-link id for it.
      void deps.tabIds.forget(tabId);
      // …and its flow history. Chrome reuses tab ids within a session, so a
      // stale key would eventually show one tab's flows under another's;
      // `cleanup` above only ASKS the tab's flows to stop, so the drop also
      // keeps them from writing it back (`FlowHistory.dropTab`).
      deps.dropFlowHistory(tabId);
    },

    /* Auto-connect tabs spawned by a connected tab.
     *
     * When a tab the user has connected via the popup opens a new tab
     * (window.open, target="_blank", a click handler doing window.open, etc.),
     * the browser reports it as created with `openerTabId` pointing at the
     * source. We use that link to:
     *   1. Wait for the new tab to settle on a real URL (the first created
     *      report often says `about:blank` even when a destination is set).
     *   2. Auto-connect the new tab through the same flow as the popup
     *      "Connect" button — attach debugger, register with the server.
     *   3. Emit a `tab-created` bridge.event tagged with `opened_from = the
     *      opener's server tab id`. The MCP `browser.wait_for_tab` tool reads
     *      that event and auto-claims the new tab for the waiting agent.
     *
     * If the opener is not connected (regular browsing), we do nothing —
     * background tabs the user opens for themselves stay out of the bridge.
     */
    created(tab) {
      const newTabId = tab.tabId;
      const openerTabId = tab.openerTabId;
      if (typeof newTabId !== 'number') return;
      if (typeof openerTabId !== 'number') return;
      const openerState = deps.tabs.get(openerTabId);
      if (!openerState) return;
      const openedFrom = openerState.serverTabId;
      if (!openedFrom) return;
      void autoConnect(newTabId, openedFrom);
    },

    debuggerDetached(tabId) {
      if (tabId === undefined) return;
      const state = deps.tabs.get(tabId);
      if (!state) return;
      state.debuggerAttached = false;
      void deps.cleanup(tabId).catch(() => {
        // Best effort.
      });
    },
  };
}
