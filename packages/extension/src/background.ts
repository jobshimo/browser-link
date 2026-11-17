import type {
  ActivityPurgeResultMessage,
  AdminActionResultMessage,
  AdminRequestLanguage,
  AdminStateMessage,
  ActivityResultMessage,
  BridgeRepairResultMessage,
  ExtensionToServer,
  ServerToExtension,
  ToolRequestMessage,
} from '@browser-link/shared';
import {
  buildSnapshotJs,
  withValuesHiddenNote,
  DEFAULT_IDLE_TTL_MINUTES,
  clampIdleTtlMinutes,
  idleHoldUntil,
  shouldScheduleIdleSweep,
  type IdleFlowHold,
  idleTabs,
  sessionCaptureWatch,
  sessionDialogWatch,
  TabRegistry,
  type TabReservation,
  TabSession,
  createPageDriver,
  dispatchTool,
  performClick,
  performDrag,
  performFind,
  performPress,
  performWaitFor,
  performType,
  type Requirement,
  TOOL_REGISTRY,
  type ToolDeps,
  toolResponse,
  type CdpSession,
  type ObserverMessageOutcome,
  type PageDriverHandle,
  runFlow,
  type FlowDeps,
  type FlowResult,
  type FlowStep,
} from '@browser-link/core';
import { docInfoEvent, pendingDocInfoEvent } from './doc-info-event.js';
import { systemClock } from './adapters/system-clock.js';
import { createChromeCdpSession } from './adapters/chrome-cdp-session.js';
import { createChromePageInfo } from './adapters/chrome-page-info.js';
import { createChromeContentSettings } from './adapters/chrome-content-settings.js';
import { createChromeDownloads } from './adapters/chrome-downloads.js';
import {
  closeTabConnection,
  debuggerIntake,
  deliverCdpEvent,
  newTabConnection,
  registeredSocket,
  send,
  sendBridgeEvent,
  type TabConnection,
  type TabEventListener,
} from './app/tab-connection.js';
import { createDownloadCapture } from './download-capture.js';
import {
  MAX_DETACHED_FLOW_MS,
  appendFlowHistory,
  createFlowRegistry,
  detachedFlowKey,
  detachedFlowRecordsToEvict,
  finishedDetachedFlowRecord,
  flowHistoryKey,
  flowIdFromDetachedFlowKey,
  minimalDetachedFlowRecord,
  parseDetachedFlowRecord,
  parseFlowHistory,
  startedDetachedFlowRecord,
  terminatedDetachedFlowRecord,
  terminatedFlowHistoryEntry,
  toFlowStatus,
  toHistoryEntry,
  type DetachedFlowRecord,
  type FlowHistoryEntry,
  type FlowRegistryEntry,
  type FlowStatusPayload,
  type RunningFlowView,
} from './flow-registry.js';
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
import {
  ALARM_MIN_DELAY_MS,
  CONNECT_IN_PROGRESS_ERROR,
  createReconnectScheduler,
  isInvoluntaryClose,
  planResume,
  reconnectStorageKey,
  tabIdFromReconnectKey,
} from './reconnect-policy.js';
import {
  REPAIR_TIMEOUT_MS,
  describeReconnectResults,
  describeRepairReply,
  planRepair,
  prevTabIdKey,
  rememberedTabIds,
  repairOutcome,
  type RepairOutcome,
} from './repair-policy.js';
import { workerFailure } from './worker-messages.js';
import { diagnoseConnectFailure, HANDSHAKE_CHECK_PATH } from './handshake-diagnosis.js';
import { createConnectFailureTracker } from './connect-failure-policy.js';
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
 * `handleTool`'s caller — the WS message listener in `connectTab` below).
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

interface ConnectResult {
  ok: boolean;
  error?: string;
  serverTabId?: string;
}

interface StatusResult {
  connected: boolean;
  serverTabId?: string;
  /** Present (true) only while the auto-reconnect scheduler has a retry
   * pending for this tab — lets the popup show "Reconnecting" instead of
   * a flat "Not connected" that would misrepresent the in-flight retry. */
  reconnecting?: boolean;
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

/**
 * In-flight `activity.query` frames, keyed by request id.
 *
 * The Activity window can have several reads outstanding — an initial page, a
 * tail poll, a filter change the user made while the tail was in the air — so
 * unlike `saveRecording`'s single slot these must be correlated. A reply whose
 * id is no longer here is a superseded or timed-out query and is dropped.
 */
type ActivityReply = ActivityResultMessage | ActivityPurgeResultMessage;

const pendingActivityQueries = new Map<string, (result: ActivityReply) => void>();

/**
 * Hand a reply to whichever caller is waiting on it, and free the slot.
 *
 * `requestId` arrives off the socket, so this validates before dispatching.
 * A `Map` lookup is already prototype-safe — unlike a plain-object lookup it
 * returns ONLY what this module stored, so an id of `__proto__` or `toString`
 * resolves to `undefined` rather than to a built-in method — but the explicit
 * `typeof` check is what makes "we never call something we did not put here"
 * a property of the code rather than a property of the reader's memory.
 *
 * An id that is no longer in the map is a superseded or timed-out request.
 * Dropping it is correct: its promise already settled with a timeout, and
 * resolving it twice would be worse than ignoring the late arrival.
 */
function settleActivityRequest(requestId: string, reply: ActivityReply): void {
  const pending = pendingActivityQueries.get(requestId);
  if (typeof pending !== 'function') return;
  pendingActivityQueries.delete(requestId);
  pending(reply);
}

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
  // Narrow to the socket itself rather than the state that holds it, so the
  // send below needs no non-null assertion to prove what the find already did.
  const socket = [...tabConnections.values()]
    .map((s) => s.ws)
    .find((ws): ws is WebSocket => ws !== undefined && ws.readyState === WebSocket.OPEN);
  if (!socket) {
    return { kind: 'activity.result', request_id: '', ok: false, error: 'not-connected' };
  }
  const requestId = crypto.randomUUID();
  return new Promise<ActivityReply>((resolve) => {
    const timer = setTimeout(() => {
      pendingActivityQueries.delete(requestId);
      resolve({ kind: 'activity.result', request_id: requestId, ok: false, error: 'timeout' });
    }, timeoutMs);
    pendingActivityQueries.set(requestId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    send(socket, frame(requestId));
  });
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

/**
 * In-flight `admin.describe` / `admin.action` frames, keyed by request id.
 * Same correlation as the activity trail: the popup re-describes after every
 * applied action, so a late reply to a superseded request must be droppable.
 */
type AdminReply = AdminStateMessage | AdminActionResultMessage;

const pendingAdminRequests = new Map<string, (reply: AdminReply) => void>();

/** Settle one admin reply; an unknown or timed-out id is dropped (see
 * `settleActivityRequest` for why). */
function settleAdminRequest(requestId: string, reply: AdminReply): void {
  const pending = pendingAdminRequests.get(requestId);
  if (typeof pending !== 'function') return;
  pendingAdminRequests.delete(requestId);
  pending(reply);
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
  const socket = [...tabConnections.values()]
    .map((s) => s.ws)
    .find((ws): ws is WebSocket => ws !== undefined && ws.readyState === WebSocket.OPEN);
  if (!socket) return onFailure('', 'not-connected');
  const requestId = crypto.randomUUID();
  return new Promise<AdminReply>((resolve) => {
    const timer = setTimeout(() => {
      pendingAdminRequests.delete(requestId);
      resolve(onFailure(requestId, 'timeout'));
    }, timeoutMs);
    pendingAdminRequests.set(requestId, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    send(socket, frame(requestId));
  });
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

/**
 * Every `browser.flow` currently running in this service worker, across
 * every connected tab. This is the whole basis of the kill switch: the
 * runner polls `cancelled` off an entry here before each step, so stopping
 * a flow means flipping one boolean and letting the loop decline to
 * dispatch step N+1 — never interrupting an in-flight CDP command.
 *
 * Lives in the service worker's memory ON PURPOSE. If Chrome terminates
 * the worker mid-flow the flow dies with it, the entry goes with it, and
 * the popup shows nothing running — which is the truth. A registry that
 * survived the worker would have to describe flows that no longer exist.
 *
 * A DETACHED flow additionally leaves a `detached-flow:<id>` record in
 * `chrome.storage.session` (see `flow-registry.ts`), which is a different
 * thing entirely: not a live registry, but the paper trail that lets
 * `recoverDetachedFlows` below notice a worker termination and report it
 * as `failed` / `worker-terminated` instead of leaving a phantom.
 */
const flowRegistry = createFlowRegistry();

/** The server's deadline of each running FOREGROUND flow, by flow id: the
 * bound of its hold on the tab's idle clock (owner decision D1, see
 * `idleHoldUntil`). A detached flow's bound is its registry `expiresAt`.
 * In memory with the registry, so it dies with the worker exactly as the
 * flows it describes do. */
const foregroundFlowDeadlines = new Map<string, number>();

/** Fallback id for a `browser.flow` that arrived without one (a server
 * older than this extension). `crypto.randomUUID` is available in the MV3
 * service worker; the `flow_` prefix keeps a locally-minted id visually
 * distinguishable from a server-minted one in the popup. */
function newFlowId(): string {
  return `flow_${crypto.randomUUID()}`;
}

/** Answer the popup's Flows panel: everything running (across ALL tabs —
 * the Stop button has to reach a flow on a tab the user is not looking at)
 * plus the completed history of the ONE tab the popup is showing. */
async function getFlowsStatus(
  tabId: number,
): Promise<{ running: RunningFlowView[]; history: FlowHistoryEntry[] }> {
  const running = flowRegistry.listRunning(Date.now());
  let history: FlowHistoryEntry[] = [];
  try {
    const key = flowHistoryKey(tabId);
    const data = await chrome.storage.session.get(key);
    history = parseFlowHistory(data[key]);
  } catch {
    // Session storage unavailable — show the running half rather than
    // failing the whole panel.
  }
  return { running, history };
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

function safeParse(raw: string): ServerToExtension | null {
  try {
    return JSON.parse(raw) as ServerToExtension;
  } catch {
    return null;
  }
}

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

/** Every requirement of the tool registry: the extension provides them all. */
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
]);

/** One worker-wide capture: `chrome.downloads` events are not tied to a tab,
 * so only one `browser.download` may wait for a download at a time. */
const downloadCapture = createDownloadCapture(chrome.downloads);

/** What the core actions and the registry handlers use on one tab. */
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

/**
 * `handleFlow` and `handleFlowStatus`: the extracted bodies of the
 * remaining standalone tool cases in `handleTool` below, which do not run
 * through core's tool registry (the actions moved to core's `actions/` in
 * slices 10, 11, 13 and 14, the page reads and captures to core's
 * `tools/page-read.ts` in slice 15, the dialog, permission and download
 * tools to `tools/dialog-permission.ts` and `tools/download.ts` in slice
 * 16). Each takes the locals its original `case` block closed over and
 * returns the same wire-level `tool.response` envelope the case built.
 */

async function handleFlow(
  tabId: number,
  state: TabSession,
  msg: ToolRequestMessage,
  p: Record<string, unknown>,
): Promise<ExtensionToServer> {
  // Wire-boundary narrowing: `p.steps` is untrusted JSON. Keep only
  // object-shaped entries here — `runFlow`'s own `stepKind()` guard
  // re-validates each one at runtime regardless, so a malformed
  // entry fails the flow cleanly instead of throwing.
  const rawSteps = Array.isArray(p.steps)
    ? p.steps.filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    : [];
  // Strict `=== true`: any other wire value (missing, "true", 1) runs
  // the flow FOR REAL. A dry run that silently became a real run would
  // be the worst possible failure of this flag, so only the exact
  // boolean opts into it.
  const dryRun = p.dry_run === true;
  // Strict `=== true` for the same reason: a flow that silently detached
  // would keep acting after the caller believed it had returned.
  const detach = p.detach === true;
  // The server mints the id (see `browser-dispatch.ts`) so the agent gets
  // it back even when the extension never answers. The local fallback
  // covers a server too old to send one: the popup's Stop button must work
  // regardless of which half was upgraded first.
  const flowId = typeof p.flow_id === 'string' && p.flow_id.length > 0 ? p.flow_id : newFlowId();
  // Strict `=== true`: the user's hide-password-values setting (owner
  // decision D12), sent by the server only when it is on.
  const hidePasswordValues = p.hide_password_values === true;

  // A dry run dispatches nothing and finishes in milliseconds, so it is
  // deliberately NOT registered: there is nothing to stop, and listing it
  // would push real runs out of a 20-entry history with entries that never
  // touched the page. It also ignores `detach` — projecting a flow is
  // fast and synchronous whichever way the real run would go.
  if (dryRun) {
    const projection = await runFlow(
      rawSteps as FlowStep[],
      buildFlowDeps(tabId, state, undefined, hidePasswordValues),
      { dryRun: true },
    );
    return {
      kind: 'tool.response',
      id: msg.id,
      ok: true,
      result: withValuesHiddenNote(projection, hidePasswordValues),
    };
  }

  if (detach) {
    // ONE detached flow per tab, enforced HERE because the registry is the
    // only place that knows. Two loops clicking through the same page have
    // no use case and every failure mode: they interleave on the same DOM,
    // race each other's `while_found` probes, and leave a human with two
    // Stop buttons and no way to tell which is which. The error names the
    // running id so the caller can inspect or stop it.
    const running = flowRegistry.detachedForTab(tabId);
    if (running) {
      return {
        kind: 'tool.response',
        id: msg.id,
        ok: false,
        error:
          `flow: a detached flow is already running on this tab (${running.flowId}). ` +
          `Wait for it, or stop it with browser.flow_cancel, before detaching another.`,
      };
    }
  }

  const entry = flowRegistry.register({
    flowId,
    tabId,
    steps: rawSteps.length,
    detached: detach,
    ...(detach ? { expiresAt: Date.now() + MAX_DETACHED_FLOW_MS } : {}),
  });
  // Best effort and deliberately not awaited: the title is only there so
  // the popup can tell two concurrent flows apart, and no flow should pay
  // a round trip to chrome.tabs before its first step.
  void chrome.tabs
    .get(tabId)
    .then((tab) => {
      if (typeof tab.title === 'string') entry.title = tab.title;
    })
    .catch(() => {
      // Tab gone or title unavailable — the panel falls back to the id.
    });

  // Also covers the detached ceiling: `shouldStop` flips the entry to
  // `expired` the first time the deadline has passed, so the outcome
  // distinguishes "ran out of time" from "someone pressed Stop".
  const shouldCancel = (): boolean => flowRegistry.shouldStop(flowId, Date.now());
  // The server's time budget for a FOREGROUND flow, as a relative
  // duration (no shared clock). A detached flow has its own ceiling, so
  // the field is ignored there.
  const deadlineAt =
    !detach && typeof p.deadline_ms === 'number' && Number.isFinite(p.deadline_ms)
      ? Date.now() + Math.max(0, p.deadline_ms)
      : undefined;
  if (deadlineAt !== undefined) foregroundFlowDeadlines.set(flowId, deadlineAt);
  // A `wait_for` poll loop only knows this one flag, so it must also
  // trip at the deadline or a 30s wait would sail past the bridge timeout.
  // The runner itself keeps the two causes apart (`shouldCancel` alone is
  // a human stop; the deadline is `deadlineAt`).
  const stopWaiting = (): boolean =>
    shouldCancel() || (deadlineAt !== undefined && Date.now() >= deadlineAt);
  const run = (): Promise<FlowResult> =>
    runFlow(rawSteps as FlowStep[], {
      ...buildFlowDeps(tabId, state, stopWaiting, hidePasswordValues),
      shouldCancel,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      onProgress: (progress) => {
        entry.progress = progress;
      },
    });

  if (detach) {
    // The record lands BEFORE the first step is dispatched: it is the only
    // evidence a worker termination leaves behind, and a flow that acted
    // before it was recorded would be exactly the invisible run this whole
    // slice exists to make impossible. A record that will not store is
    // therefore a refusal, not a warning: nothing has run yet, and that is
    // the only moment refusing is still free.
    if (!(await persistLaunchRecord(entry))) {
      flowRegistry.finish(flowId);
      return {
        kind: 'tool.response',
        id: msg.id,
        ok: false,
        error:
          'flow: could not persist the detached-flow launch record ' +
          '(chrome.storage.session write failed). NOTHING was executed: a ' +
          'detached flow with no record acts irreversibly with no evidence.',
      };
    }
    // Deliberately floating. This is the entire point of `detach`: the
    // tool.response below goes out now, the loop keeps running, and the
    // agent's turn is free. `recordFinishedFlow` in the `finally` is what
    // eventually retires it.
    void (async () => {
      let flowResult: FlowResult | null = null;
      try {
        flowResult = await run();
      } catch {
        // A throw (detached debugger, closed tab) is a `failed` outcome —
        // recorded below from a null result. Nothing to rethrow to: there
        // is no caller left.
      } finally {
        recordFinishedFlow(flowId, flowResult);
      }
    })();
    return {
      kind: 'tool.response',
      id: msg.id,
      ok: true,
      result: withValuesHiddenNote(
        {
          detached: true,
          started_at: entry.startedAt,
          steps: rawSteps.length,
          expires_at: entry.expiresAt,
        },
        hidePasswordValues,
      ),
    };
  }

  let flowResult: FlowResult | null = null;
  try {
    flowResult = await run();
    // The wire-level response is ok:true whenever the flow RAN (even a
    // failed step, and even a cancellation, is a legitimate business
    // outcome — same pattern as wait_for's matched:false) — flowResult
    // itself carries the ok:true/false and stopped_by the agent reads.
    return {
      kind: 'tool.response',
      id: msg.id,
      ok: true,
      result: withValuesHiddenNote(flowResult, hidePasswordValues),
    };
  } finally {
    // In `finally` so a throw (detached debugger, closed tab) still retires
    // the registry entry — a phantom "running" flow in the popup would be
    // worse than no panel at all, since it offers a Stop button that can
    // never do anything.
    recordFinishedFlow(flowId, flowResult);
  }
}

/** Answer the `flow_status` wire tool (behind `browser.flow_status`).
 * Reads the live registry first and falls back to the persisted detached
 * record; an id neither knows comes back as `state: 'unknown'`, never as an
 * error — see `FlowState`. */
async function handleFlowStatus(
  msg: ToolRequestMessage,
  p: Record<string, unknown>,
): Promise<ExtensionToServer> {
  const flowId = typeof p.flow_id === 'string' ? p.flow_id : '';
  if (flowId.length === 0) {
    return { kind: 'tool.response', id: msg.id, ok: false, error: 'flow_status: flow_id required' };
  }
  const entry = flowRegistry.get(flowId);
  const record = entry ? undefined : await readDetachedFlowRecord(flowId);
  const status: FlowStatusPayload = toFlowStatus(flowId, entry, record);
  return { kind: 'tool.response', id: msg.id, ok: true, result: status };
}

/** The perform* bindings `runFlow` needs, in one place so the real run and
 * the dry-run projection cannot drift apart. `shouldCancel` is threaded
 * into `performWaitFor` alone: it is the only perform* with a loop of its
 * own to break out of. */
function buildFlowDeps(
  tabId: number,
  state: TabSession,
  shouldCancel?: () => boolean,
  /** The user's hide-password-values setting (owner decision D12): find
   * steps and the recovery snapshot hide password values too. */
  hidePasswordValues = false,
): Omit<FlowDeps, 'shouldCancel' | 'onProgress'> {
  return {
    performFind: (params) =>
      performFind(actionDeps(tabId), { ...params, hide_password_values: hidePasswordValues }),
    performClick: (params) => performClick(actionDeps(tabId), params),
    performType: (params) => performType(actionDeps(tabId), params),
    performPress: (params) => performPress(actionDeps(tabId), params),
    performWaitFor: (params) => performWaitFor(actionDeps(tabId, state), params, shouldCancel),
    performDrag: (params) => performDrag({ ...pageDriver(tabId), clock: systemClock }, params),
    clock: systemClock,
    buildRecoverySnapshot: () =>
      pageDriver(tabId).evaluator.evaluate(
        buildSnapshotJs({
          only_interactive: true,
          max_interactive: 40,
          hide_password_values: hidePasswordValues,
        }),
      ),
  };
}

/** Serializes EVERY flow-related `chrome.storage.session` mutation —
 * history appends, detached-record writes, and the history drop when a tab
 * closes. Appending is a read-modify-write over an async store, so two
 * flows on the same tab finishing microseconds apart would otherwise both
 * read the same list and the second `set` would drop the first's entry;
 * and a tab-removal delete OUTSIDE the chain could be overtaken by a
 * still-running flow's late append, resurrecting the key it just dropped.
 * One global chain (rather than one per tab or one per concern) is enough:
 * these writes happen a handful of times per flow, never in a hot path. */
let flowStorageWrites: Promise<void> = Promise.resolve();

/** Append one unit of work to the serialized chain. Swallows failures so a
 * single storage error cannot poison every later write — the session store
 * dies with the browser anyway, so a lost entry is not worth surfacing. */
function queueFlowStorageWrite(work: () => Promise<void>): Promise<void> {
  flowStorageWrites = flowStorageWrites.then(work).catch(() => {
    // Best effort, and the chain must survive.
  });
  return flowStorageWrites;
}

/** Same chain, but the caller learns whether the write landed. A lost
 * detached-flow record is not a lost entry: the launch record is a flow's
 * only evidence, and a lost terminal write leaves a stale `running` record
 * the next worker start reads as an orphan. The rejection is converted to
 * `false`, never rethrown, so the chain survives as it does above. */
function queueTrackedFlowStorageWrite(work: () => Promise<void>): Promise<boolean> {
  const tracked = flowStorageWrites.then(work).then(
    () => true,
    () => false,
  );
  flowStorageWrites = tracked.then(() => undefined);
  return tracked;
}

/** Chrome tab ids whose flow history has been dropped because the tab
 * closed, and WHEN. Chrome reuses tab ids within a session, so the
 * timestamp matters: a flow that started before the removal belongs to the
 * tab that is gone and must not be written back (that is the resurrection
 * the serialized chain alone cannot prevent, since the late write is
 * queued after the delete); a flow that started after it belongs to
 * whatever tab holds the id now. Cleared when a tab connects under the id
 * again, so this never grows past live-plus-recently-closed tabs. */
const flowHistoryDroppedAt = new Map<number, number>();

/** Retire a finished flow: drop it from the in-flight registry, prepend its
 * outcome to the tab's session-scoped history, and — for a detached flow —
 * finalize its record and emit the one-per-flow audit event. Never throws:
 * a storage failure must not turn a completed flow into a failed tool call,
 * and for a detached flow there is no caller left to fail anyway. */
function recordFinishedFlow(flowId: string, result: FlowResult | null): void {
  foregroundFlowDeadlines.delete(flowId);
  const entry = flowRegistry.finish(flowId);
  if (!entry) return;
  const endedAt = Date.now();
  // Owner decision D1: the flow's steps were the tab's activity, so the
  // idle window restarts from its last step whatever the outcome.
  tabConnections.get(entry.tabId)?.session.flowEnded(endedAt);
  const droppedAt = flowHistoryDroppedAt.get(entry.tabId);
  // Skip the append entirely for a tab that has already been removed — see
  // `flowHistoryDroppedAt`. Ordering on the chain is not enough on its own,
  // because this write is queued AFTER the delete was.
  if (droppedAt === undefined || droppedAt <= entry.startedAt) {
    appendFlowHistoryEntry(entry.tabId, toHistoryEntry(entry, result, endedAt));
  }
  if (!entry.detached) return;
  const record = finishedDetachedFlowRecord(entry, result, endedAt);
  // Exactly ONE summary event per detached flow, pushed here and nowhere
  // else — never per iteration. `BridgeEventLog` holds 200 entries, so a
  // single 200-iteration run emitting per-iteration events would silently
  // evict every other event in the log, which is the opposite of an audit
  // trail. If the socket is already gone the event is deferred onto the
  // record and flushed when the tab next registers.
  if (!publishFlowFinished(entry.tabId, record)) record.eventPending = true;
  void persistTerminalRecord(record);
}

/** Prepend one entry to a tab's session-scoped flow history, on the
 * serialized chain (the append is a read-modify-write, so two flows
 * finishing microseconds apart would otherwise lose one). */
function appendFlowHistoryEntry(tabId: number, historyEntry: FlowHistoryEntry): void {
  const key = flowHistoryKey(tabId);
  void queueFlowStorageWrite(async () => {
    const data = await chrome.storage.session.get(key);
    await chrome.storage.session.set({
      [key]: appendFlowHistory(parseFlowHistory(data[key]), historyEntry),
    });
  });
}

/** Push the one-per-flow summary `bridge.event`. Returns whether it
 * actually went out — the caller defers it onto the record when it did
 * not, so an audit trail is never quietly dropped just because the tab's
 * socket happened to be closed. Counts and enums only: the manifest itself
 * is addressable by `flow_id` through `browser.flow_status` and has no
 * business in a 200-entry ring buffer. */
function publishFlowFinished(tabId: number, record: DetachedFlowRecord): boolean {
  const state = tabConnections.get(tabId);
  if (!state?.ws || state.ws.readyState !== WebSocket.OPEN) return false;
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

/** Persist one detached-flow record and enforce the record cap. Runs on the
 * serialized chain so a launch write and the matching terminal write can
 * never land out of order. Reports whether THE RECORD landed; the cap sweep
 * that follows is best effort and must not make a stored record look lost. */
function writeDetachedFlowRecord(record: DetachedFlowRecord): Promise<boolean> {
  return queueTrackedFlowStorageWrite(async () => {
    await chrome.storage.session.set({ [detachedFlowKey(record.flowId)]: record });
    try {
      const evict = detachedFlowRecordsToEvict(await readAllDetachedFlowRecords());
      if (evict.length === 0) return;
      await chrome.storage.session.remove(evict.map((r) => detachedFlowKey(r.flowId)));
    } catch {
      // Over the cap until the next write sweeps again.
    }
  });
}

/** Free session-storage quota by dropping every terminal record not still
 * owing its summary event. Only after a rejected write: at that point old
 * manifests are worth less than the launch record of a flow about to act.
 *
 * The sweep is deliberately GLOBAL, not scoped to the launching tab: it can
 * discard a finished flow's manifest that another tab's agent had not read
 * yet. That is the accepted trade. The alternative is refusing the launch,
 * which leaves a flow about to do irreversible work with no record proving
 * it started — and an unread manifest is recoverable by looking at the
 * page, while a missing launch record makes a killed worker undetectable. */
function pruneDetachedFlowRecords(): Promise<boolean> {
  return queueTrackedFlowStorageWrite(async () => {
    const stale = (await readAllDetachedFlowRecords()).filter(
      (r) => r.state !== 'running' && r.eventPending !== true,
    );
    if (stale.length === 0) return;
    await chrome.storage.session.remove(stale.map((r) => detachedFlowKey(r.flowId)));
  });
}

/** Write the launch record and prove it landed, pruning old manifests and
 * retrying ONCE when storage refuses (the plausible refusal is a quota one:
 * ten records of up to 128 KB against pre-112 Chrome's 1 MB session cap).
 * False means genuinely unstored — the caller must not start the flow. */
async function persistLaunchRecord(entry: FlowRegistryEntry): Promise<boolean> {
  const record = startedDetachedFlowRecord(entry);
  if (await writeDetachedFlowRecord(record)) return true;
  await pruneDetachedFlowRecords();
  return writeDetachedFlowRecord(record);
}

/** Write the terminal record and prove it landed. The retry STRIPS the
 * manifest instead of repeating the same write: a failed terminal write
 * does not lose an outcome, it invents a wrong one, because the stale
 * `running` record left behind is read as `worker-terminated` next start.
 * If the minimal record is refused too there is nothing left to try. */
async function persistTerminalRecord(record: DetachedFlowRecord): Promise<void> {
  if (await writeDetachedFlowRecord(record)) return;
  if (await writeDetachedFlowRecord(minimalDetachedFlowRecord(record))) return;
  console.warn('browser-link: detached-flow terminal record not persisted', record.flowId);
}

/** Read one detached-flow record. Drains the write chain first so a status
 * poll landing microseconds after a flow ended never reports the stale
 * `running` record the launch write left behind. */
async function readDetachedFlowRecord(flowId: string): Promise<DetachedFlowRecord | undefined> {
  try {
    await flowStorageWrites;
    const key = detachedFlowKey(flowId);
    const data = await chrome.storage.session.get(key);
    return parseDetachedFlowRecord(data[key]) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Every detached-flow record currently in session storage. One
 * `get(null)` rather than N keyed reads — the same sweep
 * `resumePendingReconnects` does, and the record set is capped at
 * `MAX_DETACHED_FLOW_RECORDS`. */
async function readAllDetachedFlowRecords(): Promise<DetachedFlowRecord[]> {
  let stored: Record<string, unknown>;
  try {
    stored = await chrome.storage.session.get(null);
  } catch {
    return [];
  }
  const records: DetachedFlowRecord[] = [];
  for (const [key, value] of Object.entries(stored)) {
    if (flowIdFromDetachedFlowKey(key) === null) continue;
    const record = parseDetachedFlowRecord(value);
    if (record) records.push(record);
  }
  return records;
}

/**
 * Reconcile detached-flow records left behind by a service worker Chrome
 * terminated. Runs ONCE per worker start, before anything can register a
 * flow, so every `running` record it finds is by definition orphaned: the
 * loop that owned it lived in the dead worker's memory.
 *
 * The settled rule (see `terminatedDetachedFlowRecord`, and `DECISIONS.md`
 * §13): mark it `failed` / `worker-terminated`, write the history entry,
 * and NEVER resume. A detached flow does irreversible bulk work; resuming
 * one whose real progress died with the worker would double-act on some
 * unknowable prefix of it. Failing loudly is the only honest option, and a
 * flow that looks `running` while nothing executes it is worse than either.
 */
async function recoverDetachedFlows(): Promise<void> {
  const now = Date.now();
  for (const record of await readAllDetachedFlowRecords()) {
    const terminated = terminatedDetachedFlowRecord(record, now);
    if (!terminated) continue;
    void writeDetachedFlowRecord(terminated);
    appendFlowHistoryEntry(terminated.tabId, terminatedFlowHistoryEntry(terminated));
  }
}

/** Flows whose summary event is being flushed right now. `eventPending` is
 * only cleared by a write queued AFTER the event goes out, so two fast
 * reconnects of the same tab can both read the same still-pending record
 * and publish its event twice — an audit trail that double-counts a flow is
 * as wrong as one that drops it. Membership holds from the send until the
 * clearing write settles; a write that failed leaves the flag set, and the
 * next flush legitimately retries. */
const flushingFlowEvents = new Set<string>();

/** Flush the summary events of any detached flow that ended while this
 * tab's socket was down — including every flow the worker was killed
 * under, whose event could not possibly have been sent at the time (no
 * worker, no socket). Called from the `tab.registered` handler, which is
 * the first moment there is somewhere to send them. */
async function flushPendingFlowEvents(tabId: number): Promise<void> {
  // Drain the chain first, as `readDetachedFlowRecord` does: a terminal
  // record still queued reads as stale `running`, with no event to flush.
  await flowStorageWrites;
  for (const record of await readAllDetachedFlowRecords()) {
    if (record.tabId !== tabId || record.eventPending !== true) continue;
    if (flushingFlowEvents.has(record.flowId)) continue;
    flushingFlowEvents.add(record.flowId);
    if (!publishFlowFinished(tabId, record)) {
      flushingFlowEvents.delete(record.flowId);
      return;
    }
    const { eventPending: _sent, ...flushed } = record;
    void writeDetachedFlowRecord(flushed).then((stored) => {
      // A refused clearing write must keep the flag: storage still says
      // eventPending, so releasing it here would republish a sent event.
      if (stored) flushingFlowEvents.delete(record.flowId);
    });
  }
}

async function handleTool(
  state: TabConnection,
  msg: ToolRequestMessage,
): Promise<ExtensionToServer> {
  const tabId = state.tabId;
  // A registered tool (design 3.3) runs through core and maps its outcome
  // to the wire once (3.4).
  if (TOOL_REGISTRY.has(msg.tool)) {
    const outcome = await dispatchTool(
      TOOL_REGISTRY,
      EXTENSION_PROVIDES,
      actionDeps(tabId, state.session),
      'extension',
      msg.tool,
      msg.params,
    );
    return toolResponse(msg.id, outcome);
  }
  // Params come over the wire as JSON: each field is unknown until narrowed.
  const p = (msg.params ?? {}) as Record<string, unknown>;
  try {
    switch (msg.tool) {
      case 'flow':
        return await handleFlow(tabId, state.session, msg, p);

      case 'flow_status':
        // Deliberately NOT scoped to `tabId`: the registry and the
        // detached records are worker-global, keyed by flow_id. The tab
        // this request arrived on is a transport route, not a filter — so
        // an agent can still read a finished flow's manifest through any
        // connected tab after the flow's own tab has closed.
        return await handleFlowStatus(msg, p);

      default:
        return { kind: 'tool.response', id: msg.id, ok: false, error: `Unknown tool: ${msg.tool}` };
    }
  } catch (err) {
    return {
      kind: 'tool.response',
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Tear the tab's connection down (`app/tab-connection.ts` `closeTabConnection`). */
function cleanup(tabId: number): Promise<void> {
  return closeTabConnection(tabConnections, tabId, {
    cancelFlows: (id) => flowRegistry.cancelForTab(id),
    removeRecordingNavListener,
    teardownRecorder: teardownRecorderInPage,
    detachDebugger: (id) => chrome.debugger.detach({ tabId: id }),
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return;
  deliverCdpEvent(tabConnections.get(source.tabId), method, params);
});

/**
 * Look up the previous browser-link tab_id this Chrome tab had, if any.
 * Stored in chrome.storage.session (cleared when the browser restarts).
 * Used to ask the primary to keep the same tab_id across primary swaps
 * — a key piece of the v0.4 multi-agent UX so the agent does not see
 * stale tab_ids after a re-election.
 */
async function readPreviousTabId(chromeTabId: number): Promise<string | undefined> {
  const key = prevTabIdKey(chromeTabId);
  try {
    const data = await chrome.storage.session.get(key);
    const v = data[key];
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

async function storeTabId(chromeTabId: number, serverTabId: string): Promise<void> {
  const key = prevTabIdKey(chromeTabId);
  try {
    await chrome.storage.session.set({ [key]: serverTabId });
  } catch {
    /* storage failure is non-fatal — worst case the next reconnect gets a fresh id */
  }
}

async function forgetTabId(chromeTabId: number): Promise<void> {
  const key = prevTabIdKey(chromeTabId);
  try {
    await chrome.storage.session.remove(key);
  } catch {
    /* ignore */
  }
}

/* Auto-reconnect after an involuntary WS close (retried for up to 10 minutes).
 *
 * When a REGISTERED tab's WebSocket dies under us (unclean close — the
 * primary MCP server crashed or restarted), the scheduler below retries
 * `connectTab` with per-tab backoff (see RECONNECT_DELAYS_MS in
 * reconnect-policy.ts), reusing the preserved `prevTabId:*` id so the new
 * primary can keep the same tab_id (or emit `tab-renamed` if it can't —
 * existing contract, nothing new on the wire). Every EXTENSION-initiated
 * teardown (explicit disconnect, tab removal, idle park, debugger detach)
 * runs `cleanup` BEFORE the close event dispatches, so the close handler
 * sees an untracked socket and never schedules; a CLEAN close from the
 * server (browser.reset) is a deliberate goodbye and never schedules
 * either — the popup Connect button stays the fallback for both, as today.
 *
 * MV3 durability: each scheduled attempt is mirrored into
 * `chrome.storage.session` (`pendingReconnect:*`, right next to the
 * `prevTabId:*` keys). Plain timers cover the common case — the backoff
 * span sits inside the service worker's idle grace, and every attempt
 * touches chrome.* APIs which resets the idle clock — but if the worker is
 * killed anyway, `resumePendingReconnects` below picks the budget back up
 * on the next wake, and entries older than RECONNECT_STATE_TTL_MS are
 * discarded rather than surprising the user long after they moved on. A
 * `chrome.alarms` safety net (same key) wakes the worker for the long 30s
 * steps, and a resumed attempt waits only the time that was left. */
async function storeReconnectState(tabId: number, attempt: number, delayMs: number): Promise<void> {
  const now = Date.now();
  const dueAt = now + delayMs;
  try {
    await chrome.storage.session.set({
      [reconnectStorageKey(tabId)]: { attempt, updatedAt: now, dueAt },
    });
  } catch {
    /* non-fatal — worst case a killed service worker cannot resume this retry */
  }
  // Safety net for the 30s plateau: Chrome may tear the worker down between
  // attempts, and a plain timer dies with it. The alarm (keyed like the
  // storage entry) wakes the worker, which resumes from storage. Re-creating
  // an alarm with the same name replaces it, so each arm moves it forward.
  try {
    await chrome.alarms.create(reconnectStorageKey(tabId), {
      when: Math.max(dueAt, now + ALARM_MIN_DELAY_MS),
    });
  } catch {
    /* non-fatal — the in-worker timer still runs while the worker lives */
  }
}

async function clearReconnectState(tabId: number): Promise<void> {
  try {
    await chrome.storage.session.remove(reconnectStorageKey(tabId));
  } catch {
    /* ignore */
  }
  try {
    await chrome.alarms.clear(reconnectStorageKey(tabId));
  } catch {
    /* ignore */
  }
}

const reconnectScheduler = createReconnectScheduler({
  attempt: async (tabId) => {
    try {
      await chrome.tabs.get(tabId);
    } catch {
      // The Chrome tab itself is gone — nothing left to reconnect.
      return 'stop';
    }
    const existing = tabConnections.get(tabId);
    if (existing) {
      // A live bridge already exists (e.g. the user pressed Connect while
      // a retry was pending) — done. A state whose socket is not OPEN yet
      // belongs to a connect attempt still mid-flight (cleanup deletes
      // state synchronously, so it never lingers here); keep the backoff
      // going instead of declaring victory early.
      return existing.ws?.readyState === WebSocket.OPEN ? 'connected' : 'retry';
    }
    try {
      const result = await connectTab(tabId);
      return result.ok ? 'connected' : 'retry';
    } catch {
      return 'retry';
    }
  },
  onStateChange: (tabId, state) => {
    if (state) void storeReconnectState(tabId, state.attempt, state.delayMs);
    else void clearReconnectState(tabId);
  },
});

/** Resume reconnect cycles a killed service worker left behind. Runs once
 * per worker start (top-level call below) — `chrome.storage.session`
 * survives worker restarts but not browser restarts, which is exactly the
 * lifetime the retry budget should have. */
async function resumePendingReconnects(): Promise<void> {
  // Take the cancellation epoch BEFORE the async read: a disconnect / manual
  // Connect / tab removal landing while the get is in flight leaves the
  // snapshot holding a stale entry, and planResume skips any tab cancelled
  // since (see ReconnectScheduler.cancel, which also always clears storage).
  const epoch = reconnectScheduler.epoch();
  let stored: Record<string, unknown>;
  try {
    stored = await chrome.storage.session.get(null);
  } catch {
    return;
  }
  const plan = planResume(stored, Date.now(), {
    isLive: (tabId) => tabConnections.has(tabId),
    cancelledSince: (tabId) => reconnectScheduler.wasCancelledSince(tabId, epoch),
  });
  // Wait only what was left of the pending step (0 = due already).
  for (const r of plan.resume) reconnectScheduler.schedule(r.tabId, r.attempt, r.delayMs);
  for (const tabId of plan.discard) void clearReconnectState(tabId);
}

void resumePendingReconnects();
// The alarm that wakes a sleeping worker mid-window. Registered at top level
// (MV3 requires listeners to be added synchronously on worker start). Tabs
// whose cycle is already live in this worker are skipped by `schedule`.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (tabIdFromReconnectKey(alarm.name) !== null) void resumePendingReconnects();
});
// Same worker-start slot, same rationale: `chrome.storage.session` outlives
// the service worker but not the browser, which is exactly the lifetime a
// detached flow's record should have. See `recoverDetachedFlows`.
void recoverDetachedFlows();

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
  // history was dropped — so its own flows are free to write history
  // again. Also what keeps `flowHistoryDroppedAt` from growing past
  // live-plus-recently-closed tabs.
  flowHistoryDroppedAt.delete(tabId);

  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !tab.title) {
    return workerFailure({ code: 'tab-no-url' });
  }

  const previousTabId = await readPreviousTabId(tabId);

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
  tabConnections.commit(reservation, state);
  state.debuggerListener = debuggerIntake(state, {
    clock: systemClock,
    onRecordingCapped: (id) => void finishRecording(id),
  });

  try {
    await cdp(tabId, 'Page.enable');
    await cdp(tabId, 'Runtime.enable');
    await cdp(tabId, 'Log.enable');
    await cdp(tabId, 'Network.enable');
    await cdp(tabId, 'DOM.enable');
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

  const ws = new WebSocket(WS_URL);
  state.ws = ws;

  // Capture the fields we'll send over the wire NOW that we've already
  // null-checked them above. This avoids `!` non-null assertions in the
  // event handler closure where TS can't re-prove the narrowing.
  const registerUrl = tab.url;
  const registerTitle = tab.title;

  return new Promise<ConnectResult>((resolve) => {
    let settled = false;
    const settle = (result: ConnectResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    ws.addEventListener('open', () => {
      send(ws, {
        kind: 'tab.register',
        payload: {
          url: registerUrl,
          title: registerTitle,
          previousTabId,
          extensionVersion: chrome.runtime.getManifest().version,
        },
      });
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      void (async () => {
        const msg = safeParse(typeof ev.data === 'string' ? ev.data : '');
        if (!msg) return;
        // Exhaustive routing over ServerToExtension. The `default` branch
        // pins `msg` to `never`, so adding a fourth message kind to the
        // union fails to COMPILE here instead of silently misrouting the
        // new kind into the tool.request handler.
        switch (msg.kind) {
          case 'tab.registered': {
            // A successful registration ends any reconnect cycle for this
            // tab. Covers the resume path re-arming a tab the user just
            // connected manually (resumePendingReconnects's tabConnections
            // check races connectTab); when the SCHEDULER drove this very
            // connect, its in-flight guard makes this cancel a clean,
            // notify-once end of the cycle.
            reconnectScheduler.cancel(tabId);
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
            void storeTabId(tabId, msg.payload.tabId);
            // First moment there is a socket to send them on: deliver the
            // summary events of any detached flow that ended while this
            // tab was disconnected, including everything the worker was
            // killed under.
            void flushPendingFlowEvents(tabId);
            // A fingerprint the observer pushed before this registration.
            const docInfo = pendingDocInfoEvent(state.session.driver.observer, msg.payload.tabId);
            if (docInfo) send(ws, docInfo);
            settle({ ok: true, serverTabId: msg.payload.tabId });
            return;
          }
          case 'settings.update': {
            // Housekeeping, not agent activity — deliberately does NOT touch
            // the session's activity. Counting a server-pushed settings sync as
            // "activity" would let it silently keep an otherwise-idle tab
            // connected forever, defeating the idle TTL it is updating.
            //
            // `safeParse` is only a cast — validate the payload shape at the
            // wire boundary (same rigor the IPC settings.push frame gets in
            // the server's protocol.ts) so a malformed push is dropped here
            // instead of throwing inside the apply path.
            const settings = parseIncomingSettings(msg.settings);
            if (settings) void applyIncomingSettings(settings);
            const flowRecordingSettings = parseIncomingFlowRecordingSettings(msg.settings);
            if (flowRecordingSettings)
              void applyIncomingFlowRecordingSettings(flowRecordingSettings);
            return;
          }
          case 'flow.recorded.result': {
            // Not agent/tool activity either — same rationale as
            // settings.update just above.
            const pending = state.pendingFlowSave;
            if (!pending) return;
            if (msg.ok) pending({ ok: true });
            else pending({ ok: false, error: msg.error });
            return;
          }
          case 'tool.request': {
            // The request is activity, the call holds the idle clock while it
            // runs, and its reply is activity too (BL-EXT-098).
            const response = await state.session.runCall(() => handleTool(state, msg));
            if (ws.readyState === WebSocket.OPEN) send(ws, response);
            return;
          }
          case 'tool.cancel': {
            // Deliberately answered with SILENCE: the cancelled flow is
            // still parked in its own tool.request and replies there,
            // cleanly, with stopped_by:'cancelled' and its partial
            // results. An unknown or already-finished flow_id is a no-op —
            // the caller wanted the flow not running, and it is not.
            //
            // Counts as activity: an agent reaching for the kill switch is
            // very much using this tab, and letting the idle sweeper close
            // the bridge underneath it would be perverse.
            state.session.touch();
            flowRegistry.cancel(msg.flow_id, msg.reason === 'expired' ? 'expired' : undefined);
            return;
          }
          // Both activity replies settle the same way — a purge is just a
          // request that happens to change something. Deliberately NOT counted
          // as tab activity: the human reading the trail is not using the tab,
          // and refreshing a panel must never be what keeps an idle bridge
          // alive.
          case 'activity.purge.result':
          case 'activity.result': {
            settleActivityRequest(msg.request_id, msg);
            return;
          }
          // Not tab activity either: only the popup's Admin section waits on it.
          case 'admin.state':
          case 'admin.action.result': {
            settleAdminRequest(msg.request_id, msg);
            return;
          }
          case 'bridge.repair.result': {
            // Not tab activity: the popup's Repair button is waiting on it.
            settleRepairRequest(msg);
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
      diagnose: () => diagnoseConnectFailure(HANDSHAKE_CHECK_URL),
    });
    ws.addEventListener('error', () => {
      connectFailure.onError();
    });

    ws.addEventListener('close', (ev: CloseEvent) => {
      const current = tabConnections.get(tabId);
      if (current !== undefined && current.ws !== ws) {
        // A newer connection already owns this tab — this close belongs to
        // a superseded socket, and tearing state down here would kill the
        // NEW bridge rather than the one that just died.
        settle(workerFailure({ code: 'ws-closed-before-registration' }));
        return;
      }
      // Decide BEFORE cleanup wipes the evidence: an unclean close of a
      // still-tracked, registered connection means the server died under
      // us — the one case the auto-reconnect scheduler exists for. See
      // the reconnect section doc above storeReconnectState for why every
      // other close (explicit disconnect, tab removal, idle park,
      // browser.reset's clean goodbye) falls out of this predicate.
      const involuntary = isInvoluntaryClose({
        tracked: current?.ws === ws,
        registered: current?.serverTabId !== undefined,
        wasClean: ev.wasClean,
      });
      void cleanup(tabId).catch(() => {
        // Best effort — already-detached state is fine.
      });
      connectFailure.onClose();
      if (involuntary) reconnectScheduler.schedule(tabId);
    });
  });
}

async function disconnectTab(tabId: number): Promise<{ ok: boolean }> {
  // Explicit user intent beats any pending auto-reconnect — cancel it
  // first so a scheduled retry cannot resurrect the bridge right after
  // the user asked for it to go away.
  reconnectScheduler.cancel(tabId);
  await cleanup(tabId);
  // Explicit user-driven disconnect → forget the previous tab id so the
  // next "Connect" starts from a clean slate (vs. an involuntary
  // reconnect where we WANT to keep the id for continuity).
  await forgetTabId(tabId);
  return { ok: true };
}

function getTabStatus(tabId: number): StatusResult {
  const state = tabConnections.get(tabId);
  if (!state) {
    // Keep the popup truthful while auto-reconnect is working: "not
    // connected, but actively retrying" rather than a flat idle state.
    // The registry's reservation covers the short gap inside a live attempt
    // before its connection lands — without it the popup's poll could
    // misread that gap as idle and freeze the card there.
    if (reconnectScheduler.isPending(tabId) || tabConnections.isReservedOrLive(tabId)) {
      return { connected: false, reconnecting: true };
    }
    return { connected: false };
  }
  return { connected: true, serverTabId: state.serverTabId };
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

/** The one in-flight `bridge.repair`, keyed by request id. A late or unknown
 * reply is dropped, same rule as `settleActivityRequest`. */
const pendingRepairs = new Map<string, (reply: BridgeRepairResultMessage) => void>();

function settleRepairRequest(reply: BridgeRepairResultMessage): void {
  const pending = pendingRepairs.get(reply.request_id);
  if (typeof pending !== 'function') return;
  pendingRepairs.delete(reply.request_id);
  pending(reply);
}

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
function askServerRestart(socket: WebSocket): Promise<RepairOutcome> {
  const requestId = crypto.randomUUID();
  return new Promise<RepairOutcome>((resolve) => {
    const timer = setTimeout(() => {
      pendingRepairs.delete(requestId);
      resolve(describeRepairReply('timeout'));
    }, REPAIR_TIMEOUT_MS);
    pendingRepairs.set(requestId, (reply) => {
      clearTimeout(timer);
      resolve(describeRepairReply(reply));
    });
    send(socket, { kind: 'bridge.repair', request_id: requestId });
  });
}

async function repairConnection(): Promise<RepairOutcome> {
  const socket = [...tabConnections.values()]
    .map((s) => s.ws)
    .find((ws): ws is WebSocket => ws !== undefined && ws.readyState === WebSocket.OPEN);
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
          reconnectScheduler.cancel(tabId);
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
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.serverTabId) {
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
    reconnectScheduler.cancel(msg.tabId);
    void connectTab(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.action === 'disconnect') {
    void disconnectTab(msg.tabId).then(sendResponse);
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
  sendResponse(getTabStatus(msg.tabId));
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // No tab, no reconnect — abort any pending retry cycle for it.
  reconnectScheduler.cancel(tabId);
  void cleanup(tabId).catch(() => {
    // Best effort.
  });
  // The Chrome tab is gone — drop any cached browser-link id for it.
  void forgetTabId(tabId);
  // …and its flow history. Chrome reuses tab ids within a session, so a
  // stale key would eventually show one tab's flows under another's.
  //
  // Two guards, because the delete alone is not enough. Routing it through
  // the SAME serialized chain as the appends keeps it ordered against
  // every write already queued; the `flowHistoryDroppedAt` stamp handles
  // the other half — `cleanup` above only ASKS the tab's flows to stop, so
  // one of them can still finish (and try to append) after this delete has
  // run, resurrecting the key for a tab that no longer exists.
  flowHistoryDroppedAt.set(tabId, Date.now());
  void queueFlowStorageWrite(() => chrome.storage.session.remove(flowHistoryKey(tabId)));
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
      if (!newState?.ws || newState.ws.readyState !== WebSocket.OPEN) return;
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
  const holds: IdleFlowHold[] = [];
  for (const view of flowRegistry.listRunning(now)) {
    const entry = flowRegistry.get(view.flowId);
    if (!entry) continue;
    holds.push({
      tabId: entry.tabId,
      holdUntil: idleHoldUntil(entry, foregroundFlowDeadlines.get(entry.flowId)),
    });
  }
  // BL-EXT-098: a call still running holds its tab too (`TabSession.idleCandidate`).
  const sessions = [...tabConnections].map(([tabId, conn]) => [tabId, conn.session] as const);
  for (const tabId of idleTabs(sessions, holds, now, idleTtlMinutesCache)) {
    void cleanup(tabId).catch(() => {
      // Best effort.
    });
  }
}, WS_IDLE_SWEEP_MS);
