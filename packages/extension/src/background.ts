import {
  shouldScheduleIdleSweep,
  idleTabs,
  PendingReplies,
  TabRegistry,
  createFlowHistory,
  createFlowRegistry,
} from '@browser-link/core';
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
import { chromeSettings } from './adapters/chrome-settings.js';
import { openWebSocket } from './adapters/web-socket.js';
import { createWsEventsOut } from './adapters/ws-events-out.js';
import { closeTabConnection, deliverCdpEvent, type TabConnection } from './app/tab-connection.js';
import {
  createReconnect,
  createTabIds,
  type BridgeReplies,
  type ConnectResult,
} from './app/connection.js';
import { createActivityAdmin } from './app/activity-admin.js';
import { CDP_VERSION, createConnect, createTabDrivers } from './app/connect.js';
import { createPopupRouter } from './app/popup-router.js';
import { currentVersionCheck, repairConnection } from './app/repair.js';
import { createTabEventHandlers } from './app/tab-events.js';
import { createAppWindow } from './app/windows.js';
import { createRecording } from './app/recording.js';
import { createSettingsCache } from './app/settings-cache.js';
import { createDownloadCapture } from './download-capture.js';
import { diagnoseConnectFailure, HANDSHAKE_CHECK_PATH } from './handshake-diagnosis.js';

/** Copy of `@browser-link/shared`'s BRIDGE_PORT: the extension is compiled
 * by plain tsc, so a runtime import of the workspace package would not
 * resolve in Chrome. The server's `config.drift.test.ts` keeps it equal. */
const BRIDGE_PORT = 17529;
const WS_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;
const HANDSHAKE_CHECK_URL = `http://127.0.0.1:${BRIDGE_PORT}${HANDSHAKE_CHECK_PATH}`;

/** How often the idle sweep below walks the connected tabs. */
const WS_IDLE_SWEEP_MS = 60 * 1000;

const tabConnections = new TabRegistry<TabConnection>();

/** One worker-wide capture: `chrome.downloads` events are not tied to a tab,
 * so only one `browser.download` may wait for a download at a time. */
const downloadCapture = createDownloadCapture(chrome.downloads);

/** Each tab's page driver and what the tools use on it (`app/connect.ts`);
 * the adapters it builds per tool call hold no state (design revision 10). */
const drivers = createTabDrivers({
  tabs: tabConnections,
  clock: systemClock,
  cdpSession: createChromeCdpSession,
  pageInfo: createChromePageInfo,
  downloads: (tabId) => createChromeDownloads(downloadCapture, tabId),
  contentSettings: createChromeContentSettings,
});

/** The idle TTL and the flow-recording toggle, mirrored from local storage
 * (`app/settings-cache.ts`); stateful, so built once. The toggle going off
 * discards every recording in progress at once. */
const settings = createSettingsCache({
  storage: chromeSettings,
  tabIds: () => tabConnections.keys(),
  discardRecording: (tabId) => recording.forceStopAndDiscard(tabId),
});
void settings.load();
chromeSettings.onChanged((changes, area) => {
  settings.idleTtlChanged(changes, area);
});
chromeSettings.onChanged((changes, area) => {
  settings.flowRecordingChanged(changes, area);
});

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
  events: createWsEventsOut(tabConnections),
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
  enabled: () => settings.flowRecordingEnabled(),
  cdp: drivers.cdp,
  evaluate: (tabId, expression) => drivers.pageDriver(tabId).evaluator.evaluate(expression),
});

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
  tabExists: (tabId) => chromeTabEvents.get(tabId),
  connect: (tabId) => connect.connectTab(tabId),
});

/** Connecting a tab and running its wire tools (`app/connect.ts`). */
const connect = createConnect({
  tabs: tabConnections,
  clock: systemClock,
  drivers,
  tabEvents: chromeTabEvents,
  attachDebugger: (tabId) => chrome.debugger.attach({ tabId }, CDP_VERSION),
  detachDebugger,
  tabIds,
  flows: flowRegistry,
  history: flowHistory,
  tabTitle: chromeTabTitle,
  recordingCapped: (id) => void recording.finish(id),
  cleanup,
  bridge: {
    openSocket: openWebSocket,
    url: WS_URL,
    replies,
    applySettings: (pushed) => {
      settings.applyPushed(pushed);
    },
    scheduler: reconnect.scheduler,
    extensionVersion: () => chromeRuntime.manifestVersion(),
    diagnose: () => diagnoseConnectFailure(HANDSHAKE_CHECK_URL),
  },
});
const connectTab = (tabId: number): Promise<ConnectResult> => connect.connectTab(tabId);

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

/** The popup's messages (`app/popup-router.ts`), with the repair and the
 * version summary they answer (`app/repair.ts`). */
const popupRouter = createPopupRouter({
  tabs: tabConnections,
  scheduler: reconnect.scheduler,
  tabIds,
  clock: systemClock,
  connect: connectTab,
  cleanup,
  cdp: drivers.cdp,
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
 * When the console set "never" (`settings.idleTtlMinutes()` is 0),
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
  const idleTtlMinutes = settings.idleTtlMinutes();
  if (!shouldScheduleIdleSweep(idleTtlMinutes)) return;
  const now = Date.now();
  // Owner decision D1: a tab with a flow running is not idle. Its steps run
  // here in the worker and never arrive as tool.request, so the registry is
  // what says the tab is busy, up to each flow's own maximum duration.
  const holds = flowRegistry.idleHolds();
  // BL-EXT-098: a call still running holds its tab too (`TabSession.idleCandidate`).
  const sessions = [...tabConnections].map(([tabId, conn]) => [tabId, conn.session] as const);
  for (const tabId of idleTabs(sessions, holds, now, idleTtlMinutes)) {
    void cleanup(tabId).catch(() => {
      // Best effort.
    });
  }
}, WS_IDLE_SWEEP_MS);
