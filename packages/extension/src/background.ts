import type { ExtensionToServer, ToolRequestMessage } from '@browser-link/shared';
import {
  DEFAULT_IDLE_TTL_MINUTES,
  clampIdleTtlMinutes,
  shouldScheduleIdleSweep,
  idleTabs,
  sessionCaptureWatch,
  sessionDialogWatch,
  PendingReplies,
  TabRegistry,
  type TabReservation,
  TabSession,
  createPageDriver,
  dispatchTool,
  type Requirement,
  TOOL_REGISTRY,
  type ToolDeps,
  toolResponse,
  type CdpSession,
  type ObserverMessageOutcome,
  type PageDriverHandle,
  type FlowControl,
  createFlowHistory,
  createFlowRegistry,
  type DetachedFlowRecord,
} from '@browser-link/core';
import { docInfoEvent } from './doc-info-event.js';
import { systemClock } from './adapters/system-clock.js';
import { createChromeCdpSession } from './adapters/chrome-cdp-session.js';
import { createChromePageInfo } from './adapters/chrome-page-info.js';
import { createChromeContentSettings } from './adapters/chrome-content-settings.js';
import { createChromeDownloads } from './adapters/chrome-downloads.js';
import { chromeFlowHistoryStore } from './adapters/chrome-flow-history-store.js';
import { chromeDetachedFlowStore } from './adapters/chrome-detached-flow-store.js';
import { chromeTabTitle } from './adapters/chrome-tab-title.js';
import { chromeAlarms } from './adapters/chrome-alarms.js';
import { chromeTabEvents } from './adapters/chrome-tab-events.js';
import { chromeRuntime } from './adapters/chrome-runtime.js';
import { chromeWindows } from './adapters/chrome-windows.js';
import { openWebSocket } from './adapters/web-socket.js';
import {
  closeTabConnection,
  commitConnection,
  debuggerIntake,
  deliverCdpEvent,
  newTabConnection,
  registeredSocket,
  send,
  sendBridgeEvent,
  SOCKET_OPEN,
  type TabConnection,
  type TabEventListener,
} from './app/tab-connection.js';
import {
  createReconnect,
  createTabIds,
  openBridge,
  type BridgeReplies,
  type ConnectResult,
} from './app/connection.js';
import { createActivityAdmin } from './app/activity-admin.js';
import { createPopupRouter } from './app/popup-router.js';
import { currentVersionCheck, repairConnection } from './app/repair.js';
import { createTabEventHandlers } from './app/tab-events.js';
import { createAppWindow } from './app/windows.js';
import { createExtensionFlowControl } from './app/flow-control.js';
import { createRecording } from './app/recording.js';
import { createDownloadCapture } from './download-capture.js';
import {
  CONSOLE_IDLE_TTL_STORAGE_KEY,
  effectiveIdleTtlMinutes,
  parseIncomingSettings,
  shouldAcceptIncomingSettings,
  type IncomingIdleSettings,
} from './idle-settings.js';
import {
  DEFAULT_FLOW_RECORDING_ENABLED,
  FLOW_RECORDING_STORAGE_KEY,
  FLOW_RECORDING_UPDATED_AT_STORAGE_KEY,
  normalizeFlowRecordingEnabled,
  parseIncomingFlowRecordingSettings,
  type IncomingFlowRecordingSettings,
} from './flow-recording-policy.js';
import { CONNECT_IN_PROGRESS_ERROR } from './reconnect-policy.js';
import { workerFailure } from './worker-messages.js';
import { diagnoseConnectFailure, HANDSHAKE_CHECK_PATH } from './handshake-diagnosis.js';

/** Copy of `@browser-link/shared`'s BRIDGE_PORT: the extension is compiled
 * by plain tsc, so a runtime import of the workspace package would not
 * resolve in Chrome. The server's `config.drift.test.ts` keeps it equal. */
const BRIDGE_PORT = 17529;
const WS_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;
const HANDSHAKE_CHECK_URL = `http://127.0.0.1:${BRIDGE_PORT}${HANDSHAKE_CHECK_PATH}`;
const CDP_VERSION = '1.3';

/* Idle TTL for a tab's WebSocket bridge.
 *
 * After this many minutes without a tool.request from the server, the
 * extension closes its side of the WS and detaches the debugger. The
 * popup then shows "Not connected" again and the user explicitly
 * re-presses Connect when they want to reactivate — unless the console
 * set "never", in which case the sweep never fires.
 *
 * This replaces the previous behaviour where the bridge implicitly
 * died together with the MCP server subprocess (parent_death_guard,
 * removed in v0.9.0). Lifecycle is now client-side: agent activity
 * keeps the tab warm, silence eventually parks it (or never does, if
 * the user opted out).
 *
 * The TTL has one value, owned by the console (`browser-link config set
 * idle-ttl`, 1.3.0): the server pushes it in `settings.update` and it is
 * stored under `CONSOLE_IDLE_TTL_STORAGE_KEY` (see idle-settings.ts). A value
 * the popup stored before 1.3.0 is never applied. `idleTtlMinutesCache` is
 * the in-memory mirror the sweep reads on every tick: chrome.storage is
 * async, the sweep loop below is not, so the value is loaded once at
 * startup and kept current via `chrome.storage.onChanged` instead of being
 * awaited inside the interval callback. */
const WS_IDLE_SWEEP_MS = 60 * 1000;
let idleTtlMinutesCache = DEFAULT_IDLE_TTL_MINUTES;

async function loadIdleTtlMinutes(): Promise<void> {
  try {
    const data = await chrome.storage.local.get(CONSOLE_IDLE_TTL_STORAGE_KEY);
    idleTtlMinutesCache = effectiveIdleTtlMinutes(data);
  } catch {
    idleTtlMinutesCache = DEFAULT_IDLE_TTL_MINUTES;
  }
}

void loadIdleTtlMinutes();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!(CONSOLE_IDLE_TTL_STORAGE_KEY in changes)) return;
  idleTtlMinutesCache = effectiveIdleTtlMinutes({
    [CONSOLE_IDLE_TTL_STORAGE_KEY]: changes[CONSOLE_IDLE_TTL_STORAGE_KEY].newValue,
  });
});

/**
 * Apply an incoming `settings.update` push from the server (see
 * the server-message switch of `app/connection.ts` `openBridge`).
 * The server sends this both right after `tab.registered` (when
 * `browser-link config set idle-ttl` was run at least once) AND on demand
 * when the CLI pushes a change to an already-connected tab.
 *
 * The console owns the value (1.3.0, S2): it is applied whatever its
 * `updatedAt` says, and whatever the popup stored before 1.3.0. Writing
 * through `chrome.storage.local.set` here is enough to take effect: the
 * `onChanged` listener above keeps `idleTtlMinutesCache` current, and the
 * popup re-reads storage on its own refresh interval.
 */
async function applyIncomingSettings(settings: IncomingIdleSettings): Promise<void> {
  try {
    await chrome.storage.local.set({
      [CONSOLE_IDLE_TTL_STORAGE_KEY]: clampIdleTtlMinutes(settings.idleTtlMinutes),
    });
  } catch {
    // Best effort — a failed sync just leaves the local value as-is; the
    // next settings.update (or a popup edit) can still apply it.
  }
}

/* Opt-in flow-recording toggle — mirrors the idle-ttl cache/apply pair
 * above exactly, independent storage keys, independent updatedAt. The
 * recorder is gated behind `flowRecordingEnabledCache`: `Recording.start`
 * refuses when it is false, and turning it off WHILE a recording is in
 * progress force-stops and DISCARDS it immediately (see the
 * chrome.storage.onChanged listener below) — "nothing records when the
 * popup toggle is off" is enforced the instant the toggle flips, not just
 * for recordings started afterward. */
let flowRecordingEnabledCache = DEFAULT_FLOW_RECORDING_ENABLED;

async function loadFlowRecordingEnabled(): Promise<void> {
  try {
    const data = await chrome.storage.local.get(FLOW_RECORDING_STORAGE_KEY);
    flowRecordingEnabledCache = normalizeFlowRecordingEnabled(data[FLOW_RECORDING_STORAGE_KEY]);
  } catch {
    flowRecordingEnabledCache = DEFAULT_FLOW_RECORDING_ENABLED;
  }
}

void loadFlowRecordingEnabled();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!(FLOW_RECORDING_STORAGE_KEY in changes)) return;
  flowRecordingEnabledCache = normalizeFlowRecordingEnabled(
    changes[FLOW_RECORDING_STORAGE_KEY].newValue,
  );
  if (flowRecordingEnabledCache) return;
  // Turned off (popup toggle, or a losing settings.update — either way the
  // new effective value is false): stop AND discard every in-progress
  // recording right now, across every connected tab (`app/recording.ts`).
  for (const tabId of tabConnections.keys()) {
    void recording.forceStopAndDiscard(tabId).catch(() => {
      // Best effort — the tab may already be mid-teardown.
    });
  }
});

async function applyIncomingFlowRecordingSettings(
  settings: IncomingFlowRecordingSettings,
): Promise<void> {
  try {
    const data = await chrome.storage.local.get(FLOW_RECORDING_UPDATED_AT_STORAGE_KEY);
    const rawLocalUpdatedAt = data[FLOW_RECORDING_UPDATED_AT_STORAGE_KEY];
    const localUpdatedAt = typeof rawLocalUpdatedAt === 'number' ? rawLocalUpdatedAt : undefined;
    if (!shouldAcceptIncomingSettings(localUpdatedAt, settings.updatedAt)) return;
    await chrome.storage.local.set({
      [FLOW_RECORDING_STORAGE_KEY]: settings.flowRecordingEnabled,
      [FLOW_RECORDING_UPDATED_AT_STORAGE_KEY]: settings.updatedAt,
    });
  } catch {
    // Best effort — same degrade-gracefully rule as applyIncomingSettings.
  }
}

const tabConnections = new TabRegistry<TabConnection>();

/** The in-flight Activity, Admin and Repair round trips, by request id
 * (core `PendingReplies`; `app/connection.ts` `BridgeReplies`). */
const replies: BridgeReplies = {
  activity: new PendingReplies(systemClock),
  admin: new PendingReplies(systemClock),
  repair: new PendingReplies(systemClock),
};

/** The Activity and Admin windows' round trips to the server
 * (`app/activity-admin.ts`); stateless, over `replies`. */
const activityAdmin = createActivityAdmin({ tabs: tabConnections, replies });

/** The Activity and Admin windows (`app/windows.ts`): each remembers the
 * window it opened, so each is built once. The Activity window is wide
 * enough for the full row (time, agent, tool, target, outcome) without
 * wrapping, which is the entire reason it is not the 320px popup; the Admin
 * window is a form of labelled rows, narrower but tall enough for every
 * section. */
const pageUrl = (path: string): string => chromeRuntime.pageUrl(path);
const activityWindow = createAppWindow({
  windows: chromeWindows,
  pageUrl,
  page: 'activity.html',
  size: { width: 1100, height: 760 },
});
const adminWindow = createAppWindow({
  windows: chromeWindows,
  pageUrl,
  page: 'admin.html',
  size: { width: 560, height: 720 },
});
chromeWindows.onClosed((windowId) => {
  activityWindow.closed(windowId);
});
chromeWindows.onClosed((windowId) => {
  adminWindow.closed(windowId);
});

/** Every `browser.flow` running in this worker (core `FlowRegistry`): the
 * kill switch, the foreground deadlines and the popup's running list. */
const flowRegistry = createFlowRegistry(systemClock);

/** What outlives a flow (core `FlowHistory`): each tab's history and the
 * detached flows' records in `chrome.storage.session`, written in order. */
const flowHistory = createFlowHistory({
  history: chromeFlowHistoryStore,
  detached: chromeDetachedFlowStore,
  clock: systemClock,
  publish: publishFlowFinished,
  onRecordLost: (flowId) => {
    console.warn('browser-link: detached-flow terminal record not persisted', flowId);
  },
});

/** Flow recording by demonstration (`app/recording.ts`), over the worker's
 * tabs; stateful (each recording tab's navigation subscription), so built
 * once. */
const recording = createRecording({
  tabs: tabConnections,
  tabEvents: chromeTabEvents,
  clock: systemClock,
  enabled: () => flowRecordingEnabledCache,
  cdp,
  evaluate: (tabId, expression) => pageDriver(tabId).evaluator.evaluate(expression),
});

/** A page driver over a tab's `chrome.debugger` session, whose events come
 * from `listeners`. */
function newPageDriver(tabId: number, listeners: Set<TabEventListener>): PageDriverHandle {
  return createPageDriver({
    session: debuggerSession(tabId, listeners),
    page: createChromePageInfo(tabId, systemClock),
    clock: systemClock,
    // The pending dialog of the tab's `TabSession` (its debugger intake), read live.
    dialogs: sessionDialogWatch(() => tabConnections.get(tabId)?.session),
  });
}

/** What the extension provides to the tool registry: every requirement but
 * `flow-cancel`, since it cancels a flow through the `tool.cancel` frame and
 * never receives a `flow_cancel` request (design revision 11). */
const EXTENSION_PROVIDES: ReadonlySet<Requirement> = new Set<Requirement>([
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

/** One worker-wide capture: `chrome.downloads` events are not tied to a tab,
 * so only one `browser.download` may wait for a download at a time. */
const downloadCapture = createDownloadCapture(chrome.downloads);

/** What the core actions and the registry handlers use on one tab. Adapters
 * built per call hold no state; state lives in what they receive (the
 * worker-wide `downloadCapture`, the tab's page driver), so a stateful
 * adapter is never built here (design revision 10). */
function actionDeps(tabId: number, session?: TabSession): ToolDeps {
  const driver = pageDriver(tabId);
  const { evaluator, keyboard, pointer, drag, events, settler, page, dialogs } = driver;
  const { navigator, screen, responses, dialog } = driver;
  return {
    'dialog-input': dialog,
    downloads: createChromeDownloads(downloadCapture, tabId),
    'content-settings': createChromeContentSettings(),
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
    clock: systemClock,
    dialogs,
    // The tab's captured console messages and requests.
    captureBuffers: session && sessionCaptureWatch(session),
  };
}

function debuggerSession(tabId: number, listeners: Set<TabEventListener>): CdpSession {
  return createChromeCdpSession(tabId, (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
}

/** The connected tab's page driver; for a tab with no connection (a call
 * racing its cleanup) a fresh one, whose commands fail as `chrome.debugger`
 * does and whose observer is not installed, as before slice 9. */
function pageDriver(tabId: number): PageDriverHandle {
  return tabConnections.get(tabId)?.session.driver ?? newPageDriver(tabId, new Set());
}

/** `cdp` only sends; nothing subscribes through it. */
const NO_LISTENERS = new Set<TabEventListener>();

function cdp<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return debuggerSession(tabId, NO_LISTENERS).send<T>(method, params);
}

/**
 * Report a top-document page-observer message the page driver applied: a
 * `doc_info` as a `tab-doc-info` bridge event (build fingerprint and view
 * signature; before registration the mirror keeps it and the
 * `tab.registered` handler delivers it), a `doc_start` / `nav` as a
 * `tab-navigated` bridge event so the server keeps the tab's URL and title
 * current.
 */
async function reportTopDocument(
  state: TabConnection,
  outcome: ObserverMessageOutcome,
): Promise<void> {
  if (outcome.kind === 'doc_info') {
    const open = registeredSocket(state);
    if (open) send(open.ws, docInfoEvent(open.serverTabId, outcome));
    return;
  }
  if (outcome.kind !== 'doc_start' && outcome.kind !== 'nav') return;
  let title = '';
  try {
    title = (await state.session.driver.page.info()).title;
  } catch {
    // Best effort — the tab may be closing; the URL is still worth sending.
  }
  sendBridgeEvent(state, 'tab-navigated', { url: outcome.url, title });
}

/** Push the one-per-flow summary `bridge.event`. Returns whether it
 * actually went out — the caller defers it onto the record when it did
 * not, so an audit trail is never quietly dropped just because the tab's
 * socket happened to be closed. Counts and enums only: the manifest itself
 * is addressable by `flow_id` through `browser.flow_status` and has no
 * business in a 200-entry ring buffer. */
function publishFlowFinished(tabId: number, record: DetachedFlowRecord): boolean {
  const state = tabConnections.get(tabId);
  if (!state?.ws || state.ws.readyState !== SOCKET_OPEN) return false;
  send(state.ws, {
    kind: 'bridge.event',
    eventKind: 'flow-finished',
    ...(state.serverTabId === undefined ? {} : { tabId: state.serverTabId }),
    data: {
      flow_id: record.flowId,
      state: record.state,
      detached: true,
      steps: record.steps,
      steps_completed: record.stepsCompleted,
      ...(record.iterationsCompleted === undefined
        ? {}
        : { iterations_completed: record.iterationsCompleted }),
      duration_ms: Math.max(0, (record.endedAt ?? record.startedAt) - record.startedAt),
      ...(record.stoppedBy === undefined ? {} : { stopped_by: record.stoppedBy }),
      manifest_available: record.manifest !== undefined,
    },
  });
  return true;
}

/** The flow tools' `FlowControl` on one tab (`app/flow-control.ts`), over
 * the worker's flow registry and history; built per call, it holds no state. */
function flowControl(tabId: number, session: TabSession): FlowControl {
  return createExtensionFlowControl({
    tabId,
    registry: flowRegistry,
    history: flowHistory,
    clock: systemClock,
    tabTitle: chromeTabTitle,
    stepDeps: () => actionDeps(tabId),
    waitDeps: () => actionDeps(tabId, session),
    driver: () => pageDriver(tabId),
    flowEnded: (id, endedAt) => {
      tabConnections.get(id)?.session.flowEnded(endedAt);
    },
  });
}

/** Every wire tool runs through core's registry (design 3.3) and maps its
 * outcome to the wire once (3.4); an unregistered one answers
 * `Unknown tool: <name>`. */
async function handleTool(
  state: TabConnection,
  msg: ToolRequestMessage,
): Promise<ExtensionToServer> {
  const tabId = state.tabId;
  const outcome = await dispatchTool(
    TOOL_REGISTRY,
    EXTENSION_PROVIDES,
    { ...actionDeps(tabId, state.session), flows: flowControl(tabId, state.session) },
    'extension',
    msg.tool,
    msg.params,
  );
  return toolResponse(msg.id, outcome);
}

const detachDebugger = (id: number) => chrome.debugger.detach({ tabId: id });
/** Tear the tab's connection down (`app/tab-connection.ts` `closeTabConnection`). */
function cleanup(tabId: number): Promise<void> {
  return closeTabConnection(tabConnections, tabId, {
    cancelFlows: (id) => flowRegistry.cancelForTab(id),
    removeRecordingNavListener: (id) => {
      recording.removeNavListener(id);
    },
    teardownRecorder: (id, stopFn) => recording.teardownRecorder(id, stopFn),
    detachDebugger,
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return;
  deliverCdpEvent(tabConnections.get(source.tabId), method, params);
});

/** The browser-link tab_id each Chrome tab had (`app/connection.ts` `TabIds`). */
const tabIds = createTabIds(chrome.storage.session);

/** The reconnect scheduler, its persisted state and the alarm safety net
 * (`app/connection.ts` `createReconnect`). */
const reconnect = createReconnect({
  storage: chrome.storage.session,
  alarms: chromeAlarms,
  clock: systemClock,
  tabs: tabConnections,
  tabExists: (tabId) => chrome.tabs.get(tabId),
  connect: (tabId) => connectTab(tabId),
});

// Resume the reconnect cycles a killed service worker left behind: once per
// worker start.
void reconnect.resume();
// The alarm that wakes a sleeping worker mid-window. Registered at top level
// (MV3 requires listeners to be added synchronously on worker start).
chromeAlarms.onFire((name) => {
  reconnect.onAlarm(name);
});
// Same worker-start slot, same rationale: `chrome.storage.session` outlives
// the service worker but not the browser, which is exactly the lifetime a
// detached flow's record should have: a record still `running` here is a
// flow the dead worker was running (`FlowHistory.recover`).
void flowHistory.recover();

/** Connect a tab. The `has` check inside `doConnectTab` alone cannot prevent
 * two concurrent connects — the connection lands only after three awaited
 * chrome.* calls — so the registry's SYNCHRONOUS reservation is the real
 * per-tab reentrancy guard, held for the whole attempt. */
async function connectTab(tabId: number): Promise<ConnectResult> {
  const reservation = tabConnections.reserve(tabId);
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
    tabConnections.release(reservation);
  }
}

/** Body of `connectTab` — call only through the wrapper above, which holds
 * the tab's reservation for the full duration of the attempt. */
async function doConnectTab(reservation: TabReservation): Promise<ConnectResult> {
  const { tabId } = reservation;
  if (tabConnections.has(tabId)) {
    return workerFailure({ code: 'tab-already-connected' });
  }

  // Whatever tab holds this Chrome id now, it is not the closed one whose
  // history was dropped — so its own flows are free to write history again.
  flowHistory.tabConnected(tabId);

  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !tab.title) {
    return workerFailure({ code: 'tab-no-url' });
  }

  const previousTabId = await tabIds.previous(tabId);

  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (err) {
    return workerFailure({
      code: 'debugger-attach-failed',
      values: { detail: err instanceof Error ? err.message : String(err) },
    });
  }

  const eventListeners = new Set<TabEventListener>();
  const driver = newPageDriver(tabId, eventListeners);
  const state = newTabConnection(
    tabId,
    new TabSession({ clock: systemClock, driver }),
    eventListeners,
  );
  const failed = commitConnection(tabConnections, reservation, state, detachDebugger);
  if (failed) return failed;
  state.debuggerListener = debuggerIntake(state, {
    clock: systemClock,
    onRecordingCapped: (id) => void recording.finish(id),
  });

  try {
    for (const domain of ['Page', 'Runtime', 'Log', 'Network', 'DOM'])
      await cdp(tabId, `${domain}.enable`);
  } catch (err) {
    await cleanup(tabId);
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

  return openBridge({
    tabs: tabConnections,
    state,
    openSocket: openWebSocket,
    url: WS_URL,
    // Captured now that they were null-checked above.
    register: {
      url: tab.url,
      title: tab.title,
      previousTabId,
      extensionVersion: chromeRuntime.manifestVersion(),
    },
    tabIds,
    scheduler: reconnect.scheduler,
    replies,
    flushPendingEvents: (id) => void flowHistory.flushPendingEvents(id),
    applySettings,
    handleTool: (msg) => handleTool(state, msg),
    cancelFlow: (flowId, reason) => flowRegistry.cancel(flowId, reason),
    cleanup,
    diagnose: () => diagnoseConnectFailure(HANDSHAKE_CHECK_URL),
  });
}

/** A `settings.update` push. The frame is only cast (`app/connection.ts`), so
 * each payload is validated at the wire boundary (same rigor the IPC
 * settings.push frame gets in the server's protocol.ts): a malformed push
 * is dropped here instead of throwing inside the apply path. */
function applySettings(pushed: unknown): void {
  const settings = parseIncomingSettings(pushed);
  if (settings) void applyIncomingSettings(settings);
  const flowRecordingSettings = parseIncomingFlowRecordingSettings(pushed);
  if (flowRecordingSettings) void applyIncomingFlowRecordingSettings(flowRecordingSettings);
}

/** The popup's messages (`app/popup-router.ts`), with the repair and the
 * version summary they answer (`app/repair.ts`). */
const popupRouter = createPopupRouter({
  tabs: tabConnections,
  scheduler: reconnect.scheduler,
  tabIds,
  clock: systemClock,
  connect: connectTab,
  cleanup,
  cdp,
  versionCheck: () => currentVersionCheck(tabConnections, chromeRuntime.manifestVersion()),
  repairConnection: () =>
    repairConnection({
      tabs: tabConnections,
      storage: chrome.storage.session,
      replies: replies.repair,
      scheduler: reconnect.scheduler,
      connect: connectTab,
      extensionVersion: () => chromeRuntime.manifestVersion(),
    }),
  openActivityWindow: () => activityWindow.open(),
  openAdminWindow: () => adminWindow.open(),
  activityAdmin,
  recording,
  flows: flowRegistry,
  history: flowHistory,
});
chromeRuntime.onMessage((message, reply) => popupRouter(message, reply));

/** A closed tab, a tab a connected tab opened, a debugger the browser
 * detached (`app/tab-events.ts`). */
const tabEvents = createTabEventHandlers({
  tabs: tabConnections,
  tabEvents: chromeTabEvents,
  clock: systemClock,
  scheduler: reconnect.scheduler,
  tabIds,
  connect: connectTab,
  cleanup,
  dropFlowHistory: (tabId) => {
    flowHistory.dropTab(tabId);
  },
});
chromeTabEvents.onRemoved((tabId) => {
  tabEvents.removed(tabId);
});
chromeTabEvents.onCreated((tab) => {
  tabEvents.created(tab);
});
chromeTabEvents.onDebuggerDetach((tabId) => {
  tabEvents.debuggerDetached(tabId);
});

/* WS-idle sweeper.
 *
 * Every WS_IDLE_SWEEP_MS, walk every connected tab. Any tab whose last
 * tool.request landed more than the user's configured `idleTtlMinutes`
 * ago gets disconnected: the WS closes, the debugger detaches, the popup
 * goes back to "Not connected". The user explicitly re-presses Connect to
 * bring it back. A tab with a flow running is never idle, and a finished
 * flow's last step counts as its last activity (owner decision D1); the
 * same holds for a single call still running (BL-EXT-098).
 *
 * When the console set "never" (idleTtlMinutesCache === 0),
 * `shouldScheduleIdleSweep` short-circuits the tick before it walks
 * `tabConnections` — the interval itself keeps ticking (cancelling/rearming a
 * service-worker timer from a storage listener is more moving parts than
 * it is worth for a once-a-minute no-op), but each tick does zero work
 * beyond that one check.
 *
 * This is the replacement for the parent_death_guard that used to kill
 * the entire MCP server on stdio close — now the server stays alive and
 * the bridge is parked tab-by-tab from the client side. */
setInterval(() => {
  if (!shouldScheduleIdleSweep(idleTtlMinutesCache)) return;
  const now = Date.now();
  // Owner decision D1: a tab with a flow running is not idle. Its steps run
  // here in the worker and never arrive as tool.request, so the registry is
  // what says the tab is busy, up to each flow's own maximum duration.
  const holds = flowRegistry.idleHolds();
  // BL-EXT-098: a call still running holds its tab too (`TabSession.idleCandidate`).
  const sessions = [...tabConnections].map(([tabId, conn]) => [tabId, conn.session] as const);
  for (const tabId of idleTabs(sessions, holds, now, idleTtlMinutesCache)) {
    void cleanup(tabId).catch(() => {
      // Best effort.
    });
  }
}, WS_IDLE_SWEEP_MS);
