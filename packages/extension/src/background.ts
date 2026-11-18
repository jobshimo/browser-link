import type {
  AdminRequestLanguage,
  ExtensionToServer,
  ToolRequestMessage,
} from '@browser-link/shared';
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
  type FlowStep,
  createFlowHistory,
  createFlowRegistry,
  type DetachedFlowRecord,
  type FlowHistoryEntry,
  type RunningFlowView,
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
  type BridgeSocket,
  type TabConnection,
  type TabEventListener,
} from './app/tab-connection.js';
import {
  anyOpenSocket,
  createReconnect,
  createTabIds,
  disconnectTab,
  openBridge,
  roundTrip,
  tabStatus,
  type ActivityReply,
  type AdminReply,
  type BridgeReplies,
  type ConnectResult,
} from './app/connection.js';
import { createExtensionFlowControl } from './app/flow-control.js';
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
import { buildRecorderJs, buildStopRecorderJs } from './inpage/recorder.js';
import {
  DISCARDED_WHILE_SAVING,
  appendRecordingStep,
  buildAmbiguousNote,
  buildNavigationWaitForStep,
  generateRecordingSession,
  isNavigationForRecording,
  isSameRecordingSession,
} from './recording.js';
import { CONNECT_IN_PROGRESS_ERROR } from './reconnect-policy.js';
import {
  REPAIR_TIMEOUT_MS,
  describeReconnectResults,
  describeRepairReply,
  planRepair,
  rememberedTabIds,
  repairOutcome,
  type RepairOutcome,
} from './repair-policy.js';
import { workerFailure } from './worker-messages.js';
import { diagnoseConnectFailure, HANDSHAKE_CHECK_PATH } from './handshake-diagnosis.js';
import { computeVersionCheck, type VersionCheck } from './version-status.js';

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
 * recorder is gated behind `flowRecordingEnabledCache`: `startRecording`
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
  // recording right now, across every connected tab. `forceStopAndDiscard
  // Recording` is defined further down (function declarations are hoisted,
  // so this forward reference is safe) alongside the rest of the recording
  // engine.
  for (const tabId of tabConnections.keys()) {
    void forceStopAndDiscardRecording(tabId).catch(() => {
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

// Runtime messages between popup.ts and this script.
type RuntimeMessage =
  | { action: 'connect'; tabId: number }
  | { action: 'disconnect'; tabId: number }
  | { action: 'status'; tabId: number }
  | { action: 'pendingDialog'; tabId: number }
  | { action: 'respondDialog'; tabId: number; accept: boolean; promptText?: string }
  | { action: 'versionCheck' }
  // Tab-independent: a repair acts on the server and on every remembered tab.
  | { action: 'repairConnection' }
  | { action: 'recordingStatus'; tabId: number }
  | { action: 'startRecording'; tabId: number }
  | { action: 'stopRecording'; tabId: number }
  | { action: 'discardRecording'; tabId: number }
  | { action: 'saveRecording'; tabId: number; name: string; description?: string }
  | { action: 'flowsStatus'; tabId: number }
  // No tabId: a flow_id already names exactly one flow on exactly one tab,
  // and the popup must be able to stop a flow running on a tab it is not
  // currently showing.
  | { action: 'cancelFlow'; flowId: string }
  // Both tabId-free for the same reason `cancelFlow` is: the Activity window
  // shows the trail across EVERY tab and every agent, so scoping it to one
  // would be scoping away the point of it.
  | { action: 'openActivityWindow' }
  // The Admin window, tab-independent like the admin actions it hosts.
  | { action: 'openAdminWindow' }
  | { action: 'activityQuery'; query?: Record<string, unknown> }
  | { action: 'activityPurge'; from?: string; to?: string; dryRun?: boolean }
  // Tab-independent: administration acts on the server, not on one tab.
  // `language`: the Admin window's interface language, forwarded so the
  // server answers in it (see AdminDescribeMessage).
  | { action: 'adminDescribe'; language?: unknown }
  | {
      action: 'adminAction';
      id: string;
      value?: string | number | boolean;
      code?: string;
      language?: unknown;
    };

function isRuntimeMessage(msg: unknown): msg is RuntimeMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.action === 'versionCheck') return true;
  if (m.action === 'repairConnection') return true;
  if (m.action === 'openActivityWindow') return true;
  if (m.action === 'openAdminWindow') return true;
  if (m.action === 'activityQuery') return true;
  if (m.action === 'activityPurge') return true;
  if (m.action === 'adminDescribe') return true;
  if (m.action === 'adminAction') {
    const v = m.value;
    return (
      typeof m.id === 'string' &&
      (v === undefined ||
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'boolean') &&
      (m.code === undefined || typeof m.code === 'string')
    );
  }
  if (m.action === 'saveRecording') {
    return typeof m.tabId === 'number' && typeof m.name === 'string';
  }
  if (m.action === 'cancelFlow') return typeof m.flowId === 'string';
  if (typeof m.tabId !== 'number') return false;
  return (
    m.action === 'connect' ||
    m.action === 'disconnect' ||
    m.action === 'status' ||
    m.action === 'pendingDialog' ||
    m.action === 'respondDialog' ||
    m.action === 'recordingStatus' ||
    m.action === 'startRecording' ||
    m.action === 'stopRecording' ||
    m.action === 'discardRecording' ||
    m.action === 'flowsStatus'
  );
}

const tabConnections = new TabRegistry<TabConnection>();

/** The in-flight Activity, Admin and Repair round trips, by request id
 * (core `PendingReplies`; `app/connection.ts` `BridgeReplies`). */
const replies: BridgeReplies = {
  activity: new PendingReplies(systemClock),
  admin: new PendingReplies(systemClock),
  repair: new PendingReplies(systemClock),
};

/** How long a trail READ waits before giving up. Short: this is a local
 * SQLite read over a loopback socket. If it has not answered in two seconds
 * the bridge is wedged, and the window should say so rather than spin. */
const ACTIVITY_QUERY_TIMEOUT_MS = 2_000;

/** A purge gets far longer. Deleting rows is quick; the VACUUM that follows
 * rewrites the whole file, and on a trail that grew to hundreds of megabytes
 * — precisely the case the user is purging to fix — that is not a two-second
 * operation. Timing out early would leave the window claiming failure over
 * work that actually succeeded. */
const ACTIVITY_PURGE_TIMEOUT_MS = 60_000;

/**
 * One correlated round trip to the server over any connected tab's socket.
 *
 * The trail is server-side and global, so which tab carries the question is
 * irrelevant — but at least one tab must be connected, because the WS is the
 * only channel the extension has. That is why the window renders an explicit
 * "connect a tab" state rather than an empty list: empty and unreachable are
 * different facts and must not look the same.
 */
async function activityRoundTrip(
  frame: (requestId: string) => ExtensionToServer,
  timeoutMs: number,
): Promise<ActivityReply> {
  const socket = anyOpenSocket(tabConnections);
  if (!socket) {
    return { kind: 'activity.result', request_id: '', ok: false, error: 'not-connected' };
  }
  return roundTrip(replies.activity, socket, frame, timeoutMs, (request_id) => ({
    kind: 'activity.result',
    request_id,
    ok: false,
    error: 'timeout',
  }));
}

function queryActivity(query: Record<string, unknown>): Promise<ActivityReply> {
  return activityRoundTrip(
    (request_id) => ({ kind: 'activity.query', request_id, query }),
    ACTIVITY_QUERY_TIMEOUT_MS,
  );
}

function purgeActivity(input: {
  from?: string;
  to?: string;
  dryRun?: boolean;
}): Promise<ActivityReply> {
  return activityRoundTrip(
    (request_id) => ({
      kind: 'activity.purge',
      request_id,
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.dryRun === true ? { dry_run: true } : {}),
    }),
    // A dry run only counts — no VACUUM, so it gets the short budget.
    input.dryRun === true ? ACTIVITY_QUERY_TIMEOUT_MS : ACTIVITY_PURGE_TIMEOUT_MS,
  );
}

/** Describing and most actions are local config reads and writes. */
const ADMIN_TIMEOUT_MS = 5_000;
/** `doctor` probes ports and processes server-side and is slow by nature. */
const ADMIN_DOCTOR_TIMEOUT_MS = 20_000;

/**
 * One correlated admin round trip over any connected tab's socket — the same
 * shape as `activityRoundTrip`. `onFailure` builds the reply kind the caller
 * expects, so `not-connected` and `timeout` reach the popup in the same
 * envelope a real answer would.
 */
async function adminRoundTrip(
  frame: (requestId: string) => ExtensionToServer,
  timeoutMs: number,
  onFailure: (requestId: string, error: string) => AdminReply,
): Promise<AdminReply> {
  const socket = anyOpenSocket(tabConnections);
  if (!socket) return onFailure('', 'not-connected');
  return roundTrip(replies.admin, socket, frame, timeoutMs, (requestId) =>
    onFailure(requestId, 'timeout'),
  );
}

/** The window's language when it is one the server speaks; otherwise
 * nothing, and the server uses its configured language. */
function adminLanguageField(language: unknown): { language?: AdminRequestLanguage } {
  return language === 'en' || language === 'es' ? { language } : {};
}

function adminDescribe(language: unknown): Promise<AdminReply> {
  return adminRoundTrip(
    (request_id) => ({ kind: 'admin.describe', request_id, ...adminLanguageField(language) }),
    ADMIN_TIMEOUT_MS,
    (request_id, error) => ({ kind: 'admin.state', request_id, ok: false, error }),
  );
}

function adminAction(input: {
  id: string;
  value?: string | number | boolean;
  code?: string;
  language?: unknown;
}): Promise<AdminReply> {
  return adminRoundTrip(
    (request_id) => ({
      kind: 'admin.action',
      request_id,
      id: input.id,
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...adminLanguageField(input.language),
    }),
    input.id === 'doctor' ? ADMIN_DOCTOR_TIMEOUT_MS : ADMIN_TIMEOUT_MS,
    (request_id, error) => ({
      kind: 'admin.action.result',
      request_id,
      result: { ok: false, error },
    }),
  );
}

/** Chrome window geometry for the Activity panel. Wide enough for the full
 * row — time, agent, tool, target and outcome — without wrapping, which is
 * the entire reason this is not the 320px popup. */
const ACTIVITY_WINDOW = { width: 1100, height: 760 } as const;

/**
 * Open the Activity window, or focus it if it is already open.
 *
 * Focus-if-open rather than always-create: the button is in a popup the user
 * will press again out of habit, and stacking five identical windows is the
 * kind of small rudeness that makes a tool feel unfinished.
 */
let activityWindowId: number | null = null;

async function openActivityWindow(): Promise<{ ok: true; windowId: number }> {
  if (activityWindowId !== null) {
    try {
      const existing = await chrome.windows.get(activityWindowId);
      if (existing.id !== undefined) {
        await chrome.windows.update(existing.id, { focused: true });
        return { ok: true, windowId: existing.id };
      }
    } catch {
      // Closed since we last saw it — fall through and open a fresh one.
      activityWindowId = null;
    }
  }
  // `chrome.windows.create` resolves to `undefined` when the window could not
  // be created (the API types it optional for exactly that case). Treat it as
  // "no window to remember" rather than assuming success.
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL('activity.html'),
    type: 'popup',
    ...ACTIVITY_WINDOW,
  });
  activityWindowId = created?.id ?? null;
  return { ok: true, windowId: created?.id ?? -1 };
}

chrome.windows.onRemoved.addListener((closedId) => {
  if (closedId === activityWindowId) activityWindowId = null;
});

/** Chrome window geometry for the Admin panel: a form of labelled rows, so
 * narrower than the Activity table but tall enough for every section. */
const ADMIN_WINDOW = { width: 560, height: 720 } as const;

/**
 * Open the Admin window, or focus it if it is already open. Same contract as
 * `openActivityWindow`: a dedicated window rather than a section of the popup,
 * which closes the moment it loses focus and is too narrow for the form.
 */
let adminWindowId: number | null = null;

async function openAdminWindow(): Promise<{ ok: true; windowId: number }> {
  if (adminWindowId !== null) {
    try {
      const existing = await chrome.windows.get(adminWindowId);
      if (existing.id !== undefined) {
        await chrome.windows.update(existing.id, { focused: true });
        return { ok: true, windowId: existing.id };
      }
    } catch {
      // Closed since we last saw it — fall through and open a fresh one.
      adminWindowId = null;
    }
  }
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL('admin.html'),
    type: 'popup',
    ...ADMIN_WINDOW,
  });
  adminWindowId = created?.id ?? null;
  return { ok: true, windowId: created?.id ?? -1 };
}

chrome.windows.onRemoved.addListener((closedId) => {
  if (closedId === adminWindowId) adminWindowId = null;
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

/** Answer the popup's Flows panel: everything running (across ALL tabs —
 * the Stop button has to reach a flow on a tab the user is not looking at)
 * plus the completed history of the ONE tab the popup is showing. */
async function getFlowsStatus(
  tabId: number,
): Promise<{ running: RunningFlowView[]; history: FlowHistoryEntry[] }> {
  const running = flowRegistry.listRunning(Date.now());
  // Session storage unavailable: the running half rather than no panel.
  return { running, history: await flowHistory.entries(tabId) };
}

/** Per-tab `chrome.tabs.onUpdated` listener installed while that tab is
 * recording, so `handleRecordingNavigation` fires on every navigation and
 * `stopRecording`/`cleanup` can remove EXACTLY this listener rather than
 * guessing which one belongs to which tab. Kept out of `TabConnection`
 * (unlike `debuggerListener`) only because it needs to be reachable from
 * `chrome.tabs.onRemoved`/`cleanup` even in the split second before a
 * connection exists — in practice that never happens today, but keeping
 * the two concerns in separate maps avoids coupling tab-removal cleanup to
 * the connection's shape. */
const recordingNavListeners = new Map<
  number,
  Parameters<typeof chrome.tabs.onUpdated.addListener>[0]
>();

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

/** Wait `ms` on a timer. The literal range check is CodeQL's range-branch
 * sanitizer for js/resource-exhaustion: out of range it waits 0 ms. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof ms === 'number' && ms > 0 && ms < 60_000) {
      setTimeout(resolve, ms);
    } else {
      setTimeout(resolve, 0);
    }
  });
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
    removeRecordingNavListener,
    teardownRecorder: teardownRecorderInPage,
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
    onRecordingCapped: (id) => void finishRecording(id),
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
      extensionVersion: chrome.runtime.getManifest().version,
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

/**
 * Compute the version-mismatch summary for the popup. Picks the
 * `serverVersion` reported by ANY currently-connected tab — they all come
 * from the same primary, so the first one is enough. When no tab has
 * registered yet (e.g. user just installed and hasn't pressed Connect),
 * `server` stays null and the popup hides the banner.
 */
function getVersionCheck(): VersionCheck {
  const extension = chrome.runtime.getManifest().version;
  let server: string | null = null;
  let installed: string | null = null;
  for (const s of tabConnections.values()) {
    if (typeof s.serverVersion === 'string' && s.serverVersion.length > 0) {
      server = s.serverVersion;
      installed =
        typeof s.installedVersion === 'string' && s.installedVersion.length > 0
          ? s.installedVersion
          : null;
      break;
    }
  }
  return computeVersionCheck({ extension, server, installed });
}

/* "Repair connection" (popup button). The decision lives in repair-policy.ts;
 * this is the thin wiring that gathers its inputs and carries out the step. */

async function readRememberedTabIds(): Promise<number[]> {
  try {
    return rememberedTabIds(await chrome.storage.session.get(null));
  } catch {
    return [];
  }
}

/** Send `bridge.repair` on one open socket and wait for the answer. On
 * success the server drops every socket uncleanly and the existing
 * auto-reconnect scheduler brings the tabs back; nothing else to do here. */
function askServerRestart(socket: BridgeSocket): Promise<RepairOutcome> {
  return roundTrip(
    replies.repair,
    socket,
    (request_id) => ({ kind: 'bridge.repair', request_id }),
    REPAIR_TIMEOUT_MS,
    () => 'timeout' as const,
  ).then(describeRepairReply);
}

async function repairConnection(): Promise<RepairOutcome> {
  const socket = anyOpenSocket(tabConnections);
  const plan = planRepair({
    connected: socket !== undefined,
    serverVersion: getVersionCheck().server,
    rememberedTabIds: await readRememberedTabIds(),
  });
  switch (plan.step) {
    case 'ask-server-restart':
      // `planRepair` only picks this step when a socket is open.
      return socket
        ? askServerRestart(socket)
        : repairOutcome(false, { code: 'server-not-connected' });
    case 'reconnect-only': {
      // Same path as the popup's Connect: an explicit attempt replaces any
      // pending auto-reconnect for the tab, and connectTab's per-tab lock
      // turns a race with an in-flight retry into a benign result.
      const results = await Promise.all(
        plan.tabIds.map(async (tabId) => {
          reconnect.scheduler.cancel(tabId);
          try {
            return await connectTab(tabId);
          } catch {
            return { ok: false };
          }
        }),
      );
      return describeReconnectResults(results);
    }
    case 'manual': {
      const { step: _step, reason: _reason, ...outcome } = plan;
      return { ok: false, ...outcome };
    }
  }
}

// === Flow recording by demonstration ===================================
//
// STRICTLY OPT-IN (see flowRecordingEnabledCache above) and per-tab/per-
// session — nothing here runs unless the user both enabled the setting AND
// pressed Record on this specific connected tab. Lifecycle:
//
//   startRecording -> [handleRecordingNavigation]* -> stopRecording
//     -> saveRecording | discardRecording
//
// `Runtime.addBinding` (CDP) is added ONCE at start and left in place for
// the whole session — per the CDP spec it is re-installed automatically on
// every new execution context, INCLUDING ones created by a navigation, so
// it survives document swaps on its own. The in-page LISTENERS
// (`inpage/recorder.ts`, injected via `Runtime.evaluate`) do NOT survive a
// navigation — a document swap tears down every JS global the previous
// document set up — so `handleRecordingNavigation` re-injects the recorder
// script (not the binding) after every navigation observed while
// recording, using the same `chrome.tabs.onUpdated` "complete" signal
// `armLoadWait` already uses elsewhere in this file for the standalone
// `navigate` tool.

function originOfUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function removeRecordingNavListener(tabId: number): void {
  const listener = recordingNavListeners.get(tabId);
  if (listener) {
    chrome.tabs.onUpdated.removeListener(listener);
    recordingNavListeners.delete(tabId);
  }
}

async function injectRecorder(
  tabId: number,
  session: { bindingName: string; activeFlag: string; stopFn: string; nonce: string },
): Promise<void> {
  await pageDriver(tabId).evaluator.evaluate(
    buildRecorderJs({
      bindingName: session.bindingName,
      activeFlag: session.activeFlag,
      stopFn: session.stopFn,
      nonce: session.nonce,
    }),
  );
}

/** Best-effort in-page teardown: calls the installed recorder's own stop
 * function (named by the session's random `stopFn` global) so its listeners
 * are removed even before the CDP binding subscription is dropped. A no-op
 * when the tab already navigated away (nothing installed on the new
 * document) — which is itself the correct end state, not a failure. Runs on
 * EVERY exit path — Stop, Discard, setting-off force-stop, and `cleanup`
 * (disconnect / tab removal / idle sweep) — because
 * `chrome.debugger.detach` alone only drops the CDP binding subscription,
 * NOT the plain `window.addEventListener` listeners the recorder installed;
 * those must be removed in-page. */
async function teardownRecorderInPage(tabId: number, stopFn: string): Promise<void> {
  try {
    await pageDriver(tabId).evaluator.evaluate(buildStopRecorderJs(stopFn));
  } catch {
    // Tab closed/navigated/detached mid-teardown — nothing left to tear down.
  }
}

async function handleRecordingNavigation(tabId: number, newUrl: string): Promise<void> {
  const state = tabConnections.get(tabId);
  const recording = state?.recording;
  if (!recording || recording.status !== 'recording') return;
  if (!isNavigationForRecording(recording.lastUrl, newUrl)) return;

  recording.lastUrl = newUrl;
  const result = appendRecordingStep(recording.steps, buildNavigationWaitForStep());
  recording.steps = result.steps;
  if (result.capped) {
    recording.capped = true;
    await finishRecording(tabId);
    return;
  }
  // Re-inject only — the CDP binding itself persists across navigations
  // automatically (see the section doc above). Same session identity: the
  // nonce/binding name rotate per recording START, not per document.
  await injectRecorder(tabId, recording);
}

/** Start recording user interactions on an already-connected tab. Refuses
 * when the opt-in setting is off, the tab is not connected, or a recording
 * (recording OR under-review) is already in progress for this tab. */
async function startRecording(tabId: number): Promise<{ ok: boolean; error?: string }> {
  if (!flowRecordingEnabledCache) {
    return workerFailure({ code: 'recording-disabled' });
  }
  const state = tabConnections.get(tabId);
  if (!state) return workerFailure({ code: 'tab-not-connected' });
  if (state.recording) {
    return workerFailure({ code: 'recording-in-progress' });
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return workerFailure({ code: 'tab-gone' });
  }

  // Fresh per-session identity: randomized binding name (no stable global
  // for a page to probe) + nonce (the shared secret authenticating every
  // payload). Rotated on EVERY recording start — see recorder.ts's THREAT
  // MODEL doc.
  const session = generateRecordingSession();
  try {
    await cdp(tabId, 'Runtime.addBinding', { name: session.bindingName });
  } catch (err) {
    return workerFailure({
      code: 'recording-start-failed',
      values: { detail: err instanceof Error ? err.message : String(err) },
    });
  }
  try {
    await injectRecorder(tabId, session);
  } catch (err) {
    // The binding registered above is now orphaned — nothing else will ever
    // call Runtime.removeBinding for a session that never reached
    // `state.recording` (finishRecording, the normal binding-removal path,
    // only runs for a recording that actually started). Without this
    // rollback, every retried Record click after a failed injection (e.g. a
    // page CSP blocking the injected script) leaks another binding on the
    // same debugger session. Best-effort: a rollback failure must not mask
    // the original injection error the caller needs to see.
    try {
      await cdp(tabId, 'Runtime.removeBinding', { name: session.bindingName });
    } catch {
      // Tab likely already detached — nothing left to roll back.
    }
    return workerFailure({
      code: 'recording-start-failed',
      values: { detail: err instanceof Error ? err.message : String(err) },
    });
  }

  state.recording = {
    status: 'recording',
    steps: [],
    lastUrl: tab.url ?? '',
    capped: false,
    bindingName: session.bindingName,
    activeFlag: session.activeFlag,
    stopFn: session.stopFn,
    nonce: session.nonce,
    ambiguousStepIndices: [],
  };

  const navListener: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (
    updatedId,
    info,
    updatedTab,
  ) => {
    if (updatedId !== tabId) return;
    if (info.status !== 'complete') return;
    void handleRecordingNavigation(tabId, updatedTab.url ?? '');
  };
  chrome.tabs.onUpdated.addListener(navListener);
  recordingNavListeners.set(tabId, navListener);

  return { ok: true };
}

/** Shared tail of "stop recording": un-injects the in-page recorder,
 * unsubscribes the CDP binding, removes the navigation listener, and moves
 * `status` to 'reviewing' — steps stay on `state.recording` for the
 * popup's review panel. Called both from the explicit Stop action and from
 * the step-cap auto-stop path (`Runtime.bindingCalled` handler /
 * `handleRecordingNavigation` above). */
async function finishRecording(tabId: number): Promise<void> {
  const state = tabConnections.get(tabId);
  if (!state?.recording || state.recording.status !== 'recording') return;
  removeRecordingNavListener(tabId);
  state.recording.status = 'reviewing';
  try {
    await cdp(tabId, 'Runtime.removeBinding', { name: state.recording.bindingName });
  } catch {
    // Best effort — tab may already be detached.
  }
  await teardownRecorderInPage(tabId, state.recording.stopFn);
}

async function stopRecording(
  tabId: number,
): Promise<{ ok: boolean; steps?: FlowStep[]; capped?: boolean; error?: string }> {
  const state = tabConnections.get(tabId);
  if (!state?.recording || state.recording.status !== 'recording') {
    return workerFailure({ code: 'not-recording' });
  }
  await finishRecording(tabId);
  return { ok: true, steps: state.recording.steps, capped: state.recording.capped };
}

/** Full teardown, dropping any captured-but-unsaved steps. Used by
 * Discard, by the "setting turned off mid-recording" force-stop, and by
 * `cleanup`/disconnect.
 *
 * Also settles a `saveRecording` call still in flight for this tab, as a
 * failure — without this, `state.pendingFlowSave` would keep waiting for
 * the real `flow.recorded.result` (or the 10s timeout) after the recording
 * it belongs to is already gone, and its success continuation would run
 * LATER, re-clearing whatever recording state exists by then (see
 * `isSameRecordingSession` in recording.ts for the other half of this
 * fix — belt-and-braces against that same class of stale-continuation
 * bug). This is what makes Discard-while-saving actually inert on the
 * extension side instead of merely racing the real response.
 *
 * See `DISCARDED_WHILE_SAVING`'s doc for the honest limitation:
 * this cannot retract a `flow.recorded` request the server already
 * received and persisted before this ran. */
function clearRecording(tabId: number): void {
  removeRecordingNavListener(tabId);
  const state = tabConnections.get(tabId);
  if (!state) return;
  state.recording = undefined;
  const pending = state.pendingFlowSave;
  if (pending) {
    state.pendingFlowSave = undefined;
    pending(workerFailure(DISCARDED_WHILE_SAVING));
  }
}

/** Discard a recording without saving. The popup only exposes Discard from
 * the review panel (recorder already torn down by `finishRecording`), but
 * routing through `forceStopAndDiscardRecording` makes it correct even if
 * called while a recording is still ACTIVE — it tears the recorder down
 * in-page first rather than orphaning its page listeners. */
async function discardRecording(tabId: number): Promise<{ ok: boolean }> {
  await forceStopAndDiscardRecording(tabId);
  return { ok: true };
}

/** Stop (if still actively recording) AND discard in one call — the
 * privacy-critical path used when the flow-recording setting flips off
 * while a recording is in progress. Never leaves captured-but-unreviewed
 * steps sitting in memory once the user has turned the feature off. */
async function forceStopAndDiscardRecording(tabId: number): Promise<void> {
  const state = tabConnections.get(tabId);
  if (!state?.recording) return;
  if (state.recording.status === 'recording') {
    await finishRecording(tabId);
  }
  clearRecording(tabId);
}

function getRecordingStatus(tabId: number): {
  active: boolean;
  reviewing: boolean;
  stepCount: number;
  capped: boolean;
  steps?: FlowStep[];
  ambiguousStepIndices?: number[];
} {
  const recording = tabConnections.get(tabId)?.recording;
  if (!recording) return { active: false, reviewing: false, stepCount: 0, capped: false };
  return {
    active: recording.status === 'recording',
    reviewing: recording.status === 'reviewing',
    stepCount: recording.steps.length,
    capped: recording.capped,
    steps: recording.status === 'reviewing' ? recording.steps : undefined,
    ambiguousStepIndices:
      recording.status === 'reviewing' ? recording.ambiguousStepIndices : undefined,
  };
}

/** Send the reviewed recording to the server for validation + persistence
 * (`flow.recorded` -> `flow.recorded.result`, see messages.ts). Clears the
 * recording state on success only — a validation failure (e.g. an
 * over-budget wait_for) leaves the steps in place so the user can edit the
 * name/description and retry rather than losing the capture. */
async function saveRecording(
  tabId: number,
  name: string,
  description: string | undefined,
): Promise<{ ok: boolean; error?: string }> {
  const state = tabConnections.get(tabId);
  const recording = state?.recording;
  if (!state || !recording || recording.status !== 'reviewing') {
    return workerFailure({ code: 'no-reviewed-recording' });
  }
  if (!state.ws || state.ws.readyState !== SOCKET_OPEN || !state.serverTabId) {
    return workerFailure({ code: 'server-not-connected' });
  }
  const trimmedName = name.trim();
  if (trimmedName.length === 0) return workerFailure({ code: 'name-required' });
  if (recording.steps.length === 0) return workerFailure({ code: 'no-steps' });

  // Fold the ambiguous-selector warning into the saved recipe's
  // description so the computed safety signal travels WITH the recipe, not
  // just in the transient popup review — an agent (or a human) that later
  // recalls this flow sees the caution too.
  const ambiguousNote = buildAmbiguousNote(recording.ambiguousStepIndices);
  const userDescription = description?.trim() ? description.trim() : undefined;
  const finalDescription =
    ambiguousNote && userDescription
      ? `${userDescription}\n\n${ambiguousNote}`
      : (ambiguousNote ?? userDescription);

  const ws = state.ws;
  const serverTabId = state.serverTabId;
  // Captured before the await below so the continuation can tell THIS
  // session apart from whatever `state.recording` holds once the server
  // round trip resolves — see `isSameRecordingSession`'s doc in
  // recording.ts.
  const sessionNonce = recording.nonce;
  const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    let settled = false;
    const settle = (r: { ok: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      state.pendingFlowSave = undefined;
      resolve(r);
    };
    state.pendingFlowSave = settle;
    send(ws, {
      kind: 'flow.recorded',
      payload: {
        tab_id: serverTabId,
        origin: originOfUrl(recording.lastUrl),
        name: trimmedName,
        description: finalDescription,
        steps: recording.steps,
      },
    });
    // Best-effort timeout so the popup never hangs forever if the WS drops
    // mid-request without a clean close event.
    setTimeout(() => {
      settle(workerFailure({ code: 'server-timeout' }));
    }, 10_000);
  });

  // The identity check guards against a Discard-then-Record race: Discard
  // already settles `pendingFlowSave` synchronously (see `clearRecording`),
  // so `result.ok` alone would normally be enough — this check is
  // belt-and-braces for the same class of bug in case a NEW recording
  // session is now live on this tab by the time the real response lands.
  if (result.ok && isSameRecordingSession(state.recording?.nonce, sessionNonce)) {
    clearRecording(tabId);
  }
  return result;
}

async function respondToDialogFromPopup(
  tabId: number,
  accept: boolean,
  promptText: string | undefined,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const params: Record<string, unknown> = { accept };
    if (promptText !== undefined) params.promptText = promptText;
    await cdp(tabId, 'Page.handleJavaScriptDialog', params);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!isRuntimeMessage(msg)) return false;
  if (msg.action === 'connect') {
    // An explicit Connect cancels any FUTURE auto-reconnect retries for
    // this tab. If a scheduled attempt is already mid-flight (cancel
    // cannot abort it), connectTab's per-tab in-flight lock turns this
    // call into a benign "already in progress" result instead of a
    // second concurrent connect.
    reconnect.scheduler.cancel(msg.tabId);
    void connectTab(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.action === 'disconnect') {
    void disconnectTab(msg.tabId, { scheduler: reconnect.scheduler, cleanup, tabIds }).then(
      sendResponse,
    );
    return true;
  }
  if (msg.action === 'pendingDialog') {
    const state = tabConnections.get(msg.tabId);
    sendResponse({ pending: state?.session.pendingDialog ?? null });
    return false;
  }
  if (msg.action === 'respondDialog') {
    void respondToDialogFromPopup(msg.tabId, msg.accept, msg.promptText).then(sendResponse);
    return true;
  }
  if (msg.action === 'versionCheck') {
    sendResponse(getVersionCheck());
    return false;
  }
  if (msg.action === 'repairConnection') {
    void repairConnection().then(sendResponse, (err: unknown) => {
      sendResponse({ ok: false, message: err instanceof Error ? err.message : String(err) });
    });
    return true;
  }
  if (msg.action === 'openActivityWindow') {
    void openActivityWindow().then(sendResponse);
    return true;
  }
  if (msg.action === 'openAdminWindow') {
    void openAdminWindow().then(sendResponse);
    return true;
  }
  if (msg.action === 'activityQuery') {
    void queryActivity(msg.query ?? {}).then(sendResponse);
    return true;
  }
  if (msg.action === 'activityPurge') {
    void purgeActivity(msg).then(sendResponse);
    return true;
  }
  if (msg.action === 'adminDescribe') {
    void adminDescribe(msg.language).then(sendResponse);
    return true;
  }
  if (msg.action === 'adminAction') {
    void adminAction(msg).then(sendResponse);
    return true;
  }
  if (msg.action === 'recordingStatus') {
    sendResponse(getRecordingStatus(msg.tabId));
    return false;
  }
  if (msg.action === 'startRecording') {
    void startRecording(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.action === 'stopRecording') {
    void stopRecording(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.action === 'discardRecording') {
    void discardRecording(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.action === 'saveRecording') {
    void saveRecording(msg.tabId, msg.name, msg.description).then(sendResponse);
    return true;
  }
  if (msg.action === 'flowsStatus') {
    void getFlowsStatus(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.action === 'cancelFlow') {
    // Synchronous and unconditional: one boolean flip, then the runner
    // stops at its next check. `cancelled` reports whether THIS call is
    // what stopped it, so the popup can distinguish "stopping…" from an
    // id that had already finished — never an error either way.
    sendResponse({ cancelled: flowRegistry.cancel(msg.flowId) });
    return false;
  }
  // 'status'
  sendResponse(tabStatus(tabConnections, reconnect.scheduler, msg.tabId));
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // No tab, no reconnect — abort any pending retry cycle for it.
  reconnect.scheduler.cancel(tabId);
  void cleanup(tabId).catch(() => {
    // Best effort.
  });
  // The Chrome tab is gone — drop any cached browser-link id for it.
  void tabIds.forget(tabId);
  // …and its flow history. Chrome reuses tab ids within a session, so a
  // stale key would eventually show one tab's flows under another's;
  // `cleanup` above only ASKS the tab's flows to stop, so the drop also
  // keeps them from writing it back (`FlowHistory.dropTab`).
  flowHistory.dropTab(tabId);
});

/* Auto-connect tabs spawned by a connected tab.
 *
 * When a tab the user has connected via the popup opens a new tab
 * (window.open, target="_blank", a click handler doing window.open, etc.),
 * Chrome reports it via tabs.onCreated with `openerTabId` pointing at the
 * source. We use that link to:
 *   1. Wait for the new tab to settle on a real URL (the first onCreated
 *      callback often reports `about:blank` even when a destination is set).
 *   2. Auto-connect the new tab through the same flow as the popup
 *      "Connect" button — attach debugger, register with the server.
 *   3. Emit a `tab-created` bridge.event tagged with `opened_from = the
 *      opener's server tab id`. The MCP `browser.wait_for_tab` tool reads
 *      that event and auto-claims the new tab for the waiting agent.
 *
 * If the opener is not connected (regular browsing), we do nothing —
 * background tabs the user opens for themselves stay out of the bridge.
 */
chrome.tabs.onCreated.addListener((tab) => {
  const newTabId = tab.id;
  const openerTabId = tab.openerTabId;
  if (typeof newTabId !== 'number') return;
  if (typeof openerTabId !== 'number') return;
  const openerState = tabConnections.get(openerTabId);
  if (!openerState) return;
  const openedFrom = openerState.serverTabId;
  if (!openedFrom) return;

  void (async () => {
    // Wait until chrome.tabs.get returns a real `url`. `pendingUrl` alone
    // is NOT enough — connectTab's guard short-circuits on `!tab.url`.
    // Bound at 5 s so a never-navigating tab doesn't park us forever.
    const deadline = Date.now() + 5_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const t = await chrome.tabs.get(newTabId);
        if (t.url && t.url.length > 0) {
          ready = true;
          break;
        }
      } catch {
        return;
      }
      await sleep(50);
    }
    if (!ready) return;

    try {
      const result = await connectTab(newTabId);
      if (!result.ok || !result.serverTabId) return;
      const newState = tabConnections.get(newTabId);
      if (!newState?.ws || newState.ws.readyState !== SOCKET_OPEN) return;
      let resolvedUrl = '';
      try {
        const settled = await chrome.tabs.get(newTabId);
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
  })();
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === undefined) return;
  const state = tabConnections.get(source.tabId);
  if (!state) return;
  state.debuggerAttached = false;
  void cleanup(source.tabId).catch(() => {
    // Best effort.
  });
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
