// Connecting a tab and the page driver wiring (design 6.1, slice 21d): the
// connect path (reservation, tab read, debugger attach, the hardened commit,
// the CDP domains, the page observer, the bridge socket), each tab's page
// driver and the deps the tool registry gets on it, and the wire tools'
// dispatch. No `chrome`: `background.ts` passes in the adapter factories
// (`CdpSession`, `PageInfo`, `Downloads`, `ContentSettings`), `TabEvents.get`
// and the debugger attach and detach.

import type { ExtensionToServer, ToolRequestMessage } from '@browser-link/shared';
import {
  createPageDriver,
  dispatchTool,
  sessionCaptureWatch,
  sessionDialogWatch,
  toolResponse,
  TOOL_REGISTRY,
  TabSession,
  type CdpSession,
  type Clock,
  type ContentSettings,
  type Downloads,
  type FlowHistory,
  type FlowRegistry,
  type PageDriverHandle,
  type PageInfo,
  type Requirement,
  type TabRegistry,
  type TabReservation,
  type ToolDeps,
} from '@browser-link/core';
import { CONNECT_IN_PROGRESS_ERROR, type ReconnectScheduler } from '../reconnect-policy.js';
import { workerFailure, type WorkerMessage } from '../worker-messages.js';
import { openBridge, type BridgeDeps, type ConnectResult, type TabIds } from './connection.js';
import { reportTopDocument } from './events.js';
import { createExtensionFlowControl } from './flow-control.js';
import type { TabEvents } from './tab-events.js';
import {
  commitConnection,
  debuggerIntake,
  newTabConnection,
  type TabConnection,
  type TabEventListener,
} from './tab-connection.js';

/** What the extension provides to the tool registry: every requirement but
 * `flow-cancel`, since it cancels a flow through the `tool.cancel` frame and
 * never receives a `flow_cancel` request (design revision 11). */
export const EXTENSION_PROVIDES: ReadonlySet<Requirement> = new Set<Requirement>([
  'evaluator',
  'keyboard',
  'pointer',
  'settler',
  'drag',
  'cdp-events',
  'page',
  'navigator',
  'screen-capture',
  'response-bodies',
  'capture-buffers',
  'canvas',
  'dialog-input',
  'downloads',
  'content-settings',
  'flows',
]);

/** Add a listener to one tab's CDP events; returns the unsubscribe function. */
export type TabEventSubscribe = (listener: TabEventListener) => () => void;

export interface TabDriversDeps {
  tabs: TabRegistry<TabConnection>;
  clock: Clock;
  /** The tab's debugger session (`adapters/chrome-cdp-session.ts`). */
  cdpSession(tabId: number, subscribe: TabEventSubscribe): CdpSession;
  /** What the browser knows about the tab (`adapters/chrome-page-info.ts`). */
  pageInfo(tabId: number, clock: Clock): PageInfo;
  /** The tab's downloads (`adapters/chrome-downloads.ts`), built per call. */
  downloads(tabId: number): Downloads;
  /** The content settings (`adapters/chrome-content-settings.ts`), built per call. */
  contentSettings(): ContentSettings;
}

/** Each tab's page driver and what the tools use on it. Stateless: the
 * drivers live in the tabs' sessions. */
export interface TabDrivers {
  /** A page driver over the tab's debugger session, whose events come from
   * `listeners`. */
  newPageDriver(tabId: number, listeners: Set<TabEventListener>): PageDriverHandle;
  /** The connected tab's page driver; for a tab with no connection (a call
   * racing its cleanup) a fresh one, whose commands fail as the debugger
   * does and whose observer is not installed, as before slice 9. */
  pageDriver(tabId: number): PageDriverHandle;
  /** Send one CDP command on the tab; nothing subscribes through it. */
  cdp: <T = unknown>(tabId: number, method: string, params?: Record<string, unknown>) => Promise<T>;
  /** What the core actions and the registry handlers use on one tab. Adapters
   * built per call hold no state; state lives in what they receive (the
   * worker-wide download capture, the tab's page driver), so a stateful
   * adapter is never built here (design revision 10). */
  actionDeps(tabId: number, session?: TabSession): ToolDeps;
}

export function createTabDrivers(deps: TabDriversDeps): TabDrivers {
  const { tabs, clock } = deps;

  function debuggerSession(tabId: number, listeners: Set<TabEventListener>): CdpSession {
    return deps.cdpSession(tabId, (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });
  }

  function newPageDriver(tabId: number, listeners: Set<TabEventListener>): PageDriverHandle {
    return createPageDriver({
      session: debuggerSession(tabId, listeners),
      page: deps.pageInfo(tabId, clock),
      clock,
      // The pending dialog of the tab's `TabSession` (its debugger intake), read live.
      dialogs: sessionDialogWatch(() => tabs.get(tabId)?.session),
    });
  }

  function pageDriver(tabId: number): PageDriverHandle {
    return tabs.get(tabId)?.session.driver ?? newPageDriver(tabId, new Set());
  }

  /** `cdp` only sends; nothing subscribes through it. */
  const NO_LISTENERS = new Set<TabEventListener>();

  return {
    newPageDriver,
    pageDriver,
    cdp: <T = unknown>(tabId: number, method: string, params: Record<string, unknown> = {}) =>
      debuggerSession(tabId, NO_LISTENERS).send<T>(method, params),
    actionDeps(tabId, session) {
      const driver = pageDriver(tabId);
      const { evaluator, keyboard, pointer, drag, events, settler, page, dialogs } = driver;
      const { navigator, screen, responses, dialog } = driver;
      return {
        'dialog-input': dialog,
        downloads: deps.downloads(tabId),
        'content-settings': deps.contentSettings(),
        evaluator,
        keyboard,
        pointer,
        drag,
        'cdp-events': events,
        settler,
        page,
        navigator,
        'screen-capture': screen,
        'response-bodies': responses,
        clock,
        dialogs,
        // The tab's captured console messages and requests.
        captureBuffers: session && sessionCaptureWatch(session),
      };
    },
  };
}

/** The CDP protocol version the debugger attaches with. */
export const CDP_VERSION = '1.3';

export interface ConnectDeps {
  tabs: TabRegistry<TabConnection>;
  clock: Clock;
  drivers: TabDrivers;
  /** What the browser answers about the tab (`TabEvents.get`). */
  tabEvents: Pick<TabEvents, 'get'>;
  /** Attach the debugger to the tab at `CDP_VERSION`; rejects with the browser's text. */
  attachDebugger(tabId: number): Promise<void>;
  /** Detach it; the hardened commit's rollback (`commitConnection`). */
  detachDebugger: (tabId: number) => Promise<void>;
  tabIds: TabIds;
  /** The worker's flows (the flow tools, the `tool.cancel` frame). */
  flows: FlowRegistry;
  history: FlowHistory;
  /** The title the browser shows for a tab (`adapters/chrome-tab-title.ts`). */
  tabTitle: (tabId: number) => Promise<string | undefined>;
  /** The recording of the tab reached its step cap (`Recording.finish`). */
  recordingCapped(tabId: number): void;
  /** Tear the tab's connection down (`closeTabConnection`). */
  cleanup: (tabId: number) => Promise<void>;
  /** The bridge socket's wiring (`app/connection.ts` `openBridge`). */
  bridge: Pick<BridgeDeps, 'openSocket' | 'url' | 'replies' | 'applySettings'> & {
    scheduler: ReconnectScheduler;
    extensionVersion(): string;
    diagnose: () => Promise<WorkerMessage>;
  };
}

export interface Connect {
  /** Connect a tab: debugger, CDP domains, page observer, bridge socket. */
  connectTab(tabId: number): Promise<ConnectResult>;
  /** Run one wire tool on the tab through core's registry. */
  handleTool(state: TabConnection, msg: ToolRequestMessage): Promise<ExtensionToServer>;
}

/** Stateless: the connections live in `tabs`. */
export function createConnect(deps: ConnectDeps): Connect {
  const { tabs, clock, drivers } = deps;

  /** Every wire tool runs through core's registry (design 3.3) and maps its
   * outcome to the wire once (3.4); an unregistered one answers
   * `Unknown tool: <name>`. The flow tools' `FlowControl` on the tab
   * (`app/flow-control.ts`), over the worker's flow registry and history, is
   * built per call and holds no state. */
  async function handleTool(
    state: TabConnection,
    msg: ToolRequestMessage,
  ): Promise<ExtensionToServer> {
    const tabId = state.tabId;
    const flows = createExtensionFlowControl({
      tabId,
      registry: deps.flows,
      history: deps.history,
      clock,
      tabTitle: deps.tabTitle,
      stepDeps: () => drivers.actionDeps(tabId),
      waitDeps: () => drivers.actionDeps(tabId, state.session),
      driver: () => drivers.pageDriver(tabId),
      flowEnded: (id, endedAt) => {
        tabs.get(id)?.session.flowEnded(endedAt);
      },
    });
    const outcome = await dispatchTool(
      TOOL_REGISTRY,
      EXTENSION_PROVIDES,
      { ...drivers.actionDeps(tabId, state.session), flows },
      'extension',
      msg.tool,
      msg.params,
    );
    return toolResponse(msg.id, outcome);
  }

  /** Body of `connectTab` — call only through it, which holds the tab's
   * reservation for the full duration of the attempt. */
  async function doConnectTab(reservation: TabReservation): Promise<ConnectResult> {
    const { tabId } = reservation;
    if (tabs.has(tabId)) {
      return workerFailure({ code: 'tab-already-connected' });
    }

    // Whatever tab holds this Chrome id now, it is not the closed one whose
    // history was dropped — so its own flows are free to write history again.
    deps.history.tabConnected(tabId);

    const tab = await deps.tabEvents.get(tabId);
    if (!tab.url || !tab.title) {
      return workerFailure({ code: 'tab-no-url' });
    }

    const previousTabId = await deps.tabIds.previous(tabId);

    try {
      await deps.attachDebugger(tabId);
    } catch (err) {
      return workerFailure({
        code: 'debugger-attach-failed',
        values: { detail: err instanceof Error ? err.message : String(err) },
      });
    }

    const eventListeners = new Set<TabEventListener>();
    const driver = drivers.newPageDriver(tabId, eventListeners);
    const state = newTabConnection(tabId, new TabSession({ clock, driver }), eventListeners);
    const failed = commitConnection(tabs, reservation, state, deps.detachDebugger);
    if (failed) return failed;
    state.debuggerListener = debuggerIntake(state, {
      clock,
      onRecordingCapped: (id) => {
        deps.recordingCapped(id);
      },
    });

    try {
      for (const domain of ['Page', 'Runtime', 'Log', 'Network', 'DOM'])
        await drivers.cdp(tabId, `${domain}.enable`);
    } catch (err) {
      await deps.cleanup(tabId);
      return workerFailure({
        code: 'cdp-enable-failed',
        values: { detail: err instanceof Error ? err.message : String(err) },
      });
    }

    // The page observer: non-fatal. On failure the tab connects as before and
    // actions report `settle.changes: null` with `observer-unavailable`.
    const installed = await state.session.driver.install({
      enableRuntime: false,
      onTopDocument: (outcome) => reportTopDocument(state, outcome),
    });
    if (!installed.ok) console.warn('browser-link: page observer not installed', installed.error);

    const { bridge } = deps;
    return openBridge({
      tabs,
      state,
      openSocket: bridge.openSocket,
      url: bridge.url,
      // Captured now that they were null-checked above.
      register: {
        url: tab.url,
        title: tab.title,
        previousTabId,
        extensionVersion: bridge.extensionVersion(),
      },
      tabIds: deps.tabIds,
      scheduler: bridge.scheduler,
      replies: bridge.replies,
      flushPendingEvents: (id) => void deps.history.flushPendingEvents(id),
      applySettings: bridge.applySettings,
      handleTool: (msg) => handleTool(state, msg),
      cancelFlow: (flowId, reason) => deps.flows.cancel(flowId, reason),
      cleanup: deps.cleanup,
      diagnose: bridge.diagnose,
    });
  }

  return {
    handleTool,
    /** The `has` check inside `doConnectTab` alone cannot prevent two
     * concurrent connects — the connection lands only after three awaited
     * browser calls — so the registry's SYNCHRONOUS reservation is the real
     * per-tab reentrancy guard, held for the whole attempt. */
    async connectTab(tabId) {
      const reservation = tabs.reserve(tabId);
      if (!reservation) {
        // A concurrent connect (popup Connect racing a scheduled reconnect
        // attempt, or vice versa) — the in-flight attempt owns the tab.
        // Answer benignly instead of letting a second attempt fail its
        // debugger attach with a confusing error; the popup renders this
        // exact message as the "Reconnecting" card, not an error.
        return { ok: false, error: CONNECT_IN_PROGRESS_ERROR };
      }
      try {
        return await doConnectTab(reservation);
      } finally {
        tabs.release(reservation);
      }
    },
  };
}
