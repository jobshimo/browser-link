import type {
  ExtensionToServer,
  ServerToExtension,
  ToolRequestMessage,
} from '@browser-link/shared';
import {
  buildSnapshotJs,
  buildFindJs,
  buildClickResolveJs,
  buildTypeResolveJs,
  buildFocusJs,
  buildStateJs,
  buildDragProbeJs,
} from './inpage/builders.js';
import {
  buildKeyEventSequence,
  resolveKey,
  modifiersToBitmask,
  MODIFIER_BITS,
  type KeyDefinition,
} from './keymap.js';
import { resolveSettleParams, settleSafely } from './settle.js';
import {
  runFlow,
  type ActionOutcome,
  type ClickStepResult,
  type DragStepParams,
  type DragStepResult,
  type FindStepResult,
  type FlowStep,
  type PressStepResult,
  type TypeStepResult,
  type WaitForStepResult,
} from './flow.js';
import {
  DEFAULT_IDLE_TTL_MINUTES,
  IDLE_TTL_STORAGE_KEY,
  IDLE_TTL_UPDATED_AT_STORAGE_KEY,
  clampIdleTtlMinutes,
  parseIncomingSettings,
  shouldAcceptIncomingSettings,
  shouldDisconnectForIdle,
  shouldScheduleIdleSweep,
  type IncomingIdleSettings,
} from './idle-policy.js';
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
  DISCARDED_WHILE_SAVING_MESSAGE,
  appendRecordingStep,
  buildAmbiguousNote,
  buildNavigationWaitForStep,
  generateRecordingSession,
  isNavigationForRecording,
  isSameRecordingSession,
  parseRecordedPayload,
  toFlowStep,
} from './recording.js';
import {
  CONNECT_IN_PROGRESS_ERROR,
  createReconnectScheduler,
  isInvoluntaryClose,
  isReconnectStateFresh,
  parseStoredReconnectState,
  reconnectStorageKey,
  tabIdFromReconnectKey,
} from './reconnect-policy.js';

const WS_URL = 'ws://127.0.0.1:17529';
const CDP_VERSION = '1.3';
const CONSOLE_BUFFER_MAX = 200;
const NETWORK_BUFFER_MAX = 200;

/* Idle TTL for a tab's WebSocket bridge.
 *
 * After this many minutes without a tool.request from the server, the
 * extension closes its side of the WS and detaches the debugger. The
 * popup then shows "Not connected" again and the user explicitly
 * re-presses Connect when they want to reactivate — unless the user
 * configured "Never" in the popup, in which case the sweep never fires.
 *
 * This replaces the previous behaviour where the bridge implicitly
 * died together with the MCP server subprocess (parent_death_guard,
 * removed in v0.9.0). Lifecycle is now client-side: agent activity
 * keeps the tab warm, silence eventually parks it (or never does, if
 * the user opted out).
 *
 * The TTL itself is user-configurable (`idleTtlMinutes` in
 * `chrome.storage.local`, edited from the popup — see idle-policy.ts for
 * the decision logic and popup.ts for the control). `idleTtlMinutesCache`
 * is the in-memory mirror the sweep reads on every tick: chrome.storage is
 * async, the sweep loop below is not, so the value is loaded once at
 * startup and kept current via `chrome.storage.onChanged` instead of being
 * awaited inside the interval callback. */
const WS_IDLE_SWEEP_MS = 60 * 1000;
let idleTtlMinutesCache = DEFAULT_IDLE_TTL_MINUTES;

async function loadIdleTtlMinutes(): Promise<void> {
  try {
    const data = await chrome.storage.local.get(IDLE_TTL_STORAGE_KEY);
    idleTtlMinutesCache = clampIdleTtlMinutes(data[IDLE_TTL_STORAGE_KEY]);
  } catch {
    idleTtlMinutesCache = DEFAULT_IDLE_TTL_MINUTES;
  }
}

void loadIdleTtlMinutes();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!(IDLE_TTL_STORAGE_KEY in changes)) return;
  idleTtlMinutesCache = clampIdleTtlMinutes(changes[IDLE_TTL_STORAGE_KEY].newValue);
});

/**
 * Apply an incoming `settings.update` push from the server (see
 * `handleTool`'s caller — the WS message listener in `connectTab` below).
 * The server sends this both right after `tab.registered` (when
 * `browser-link config set idle-ttl` was run at least once) AND on demand
 * when the CLI pushes a change to an already-connected tab.
 *
 * Applies `shouldAcceptIncomingSettings` (idle-policy.ts) — newest
 * `updatedAt` wins against whatever was last written locally (typically by
 * the popup). Writing through `chrome.storage.local.set` here is enough to
 * take effect: the `onChanged` listener above keeps `idleTtlMinutesCache`
 * current, and the popup re-reads storage on its own refresh interval.
 */
async function applyIncomingSettings(settings: IncomingIdleSettings): Promise<void> {
  try {
    const data = await chrome.storage.local.get(IDLE_TTL_UPDATED_AT_STORAGE_KEY);
    const rawLocalUpdatedAt = data[IDLE_TTL_UPDATED_AT_STORAGE_KEY];
    const localUpdatedAt = typeof rawLocalUpdatedAt === 'number' ? rawLocalUpdatedAt : undefined;
    if (!shouldAcceptIncomingSettings(localUpdatedAt, settings.updatedAt)) return;
    await chrome.storage.local.set({
      [IDLE_TTL_STORAGE_KEY]: clampIdleTtlMinutes(settings.idleTtlMinutes),
      [IDLE_TTL_UPDATED_AT_STORAGE_KEY]: settings.updatedAt,
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
  for (const tabId of tabStates.keys()) {
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

interface ConsoleEntry {
  timestamp: number;
  level: string;
  text: string;
  source: 'console' | 'log';
  url?: string;
  line?: number;
}

interface NetworkEntry {
  request_id: string;
  url: string;
  method: string;
  resource_type?: string;
  status?: number;
  status_text?: string;
  mime_type?: string;
  request_headers?: Record<string, string>;
  response_headers?: Record<string, string>;
  request_post_data?: string;
  encoded_data_length?: number;
  started_at: number;
  finished_at?: number;
  failed?: string;
}

interface TabState {
  tabId: number;
  serverTabId?: string;
  /** Version of the MCP server that registered this tab — set from the
   * `tab.registered` payload. Compared against the extension's own
   * `chrome.runtime.getManifest().version` so the popup can warn the user
   * when one half was upgraded and the other wasn't. */
  serverVersion?: string;
  ws?: WebSocket;
  debuggerAttached: boolean;
  consoleBuffer: ConsoleEntry[];
  networkBuffer: Map<string, NetworkEntry>;
  networkOrder: string[];
  debuggerListener?: (method: string, params: unknown) => void;
  /** Pending native dialog on this tab — set when CDP emits
   * Page.javascriptDialogOpening, cleared on Page.javascriptDialogClosed.
   * Surfaced to the popup via the `pendingDialogs` runtime message. */
  pendingDialog?: PendingDialogInfo;
  /** Last time the server talked to this tab (a tool.request landed).
   * Used by the WS-idle sweeper to disconnect tabs that have been silent
   * for longer than the user's configured `idleTtlMinutes` (see
   * idle-policy.ts). Touched on every tool.request received AND once at
   * connect time. */
  lastActivityAt: number;
  /** Present from `startRecording` through save/discard. `undefined` means
   * "not recording and nothing to review" — the common case, and what
   * every tab starts as regardless of the flow-recording setting. */
  recording?: RecordingState;
  /** Single in-flight `flow.recorded` save, resolved by the matching
   * `flow.recorded.result` WS message (see the `connectTab` message
   * switch). The popup disables Save while this is set, so at most one is
   * ever outstanding — same single-slot pattern the IPC bridge's
   * `settings.push` uses. */
  pendingFlowSave?: (result: { ok: true } | { ok: false; error: string }) => void;
}

/**
 * State for one tab's demonstration recording, see the module-level
 * "Flow recording by demonstration" section below for the full lifecycle
 * (`startRecording` -> `handleRecordingNavigation`* -> `stopRecording` ->
 * `saveRecording` | `discardRecording`).
 */
interface RecordingState {
  /** 'recording': the in-page recorder is installed and capturing.
   * 'reviewing': recording stopped, steps are held here for the popup's
   * review panel, awaiting Save or Discard. */
  status: 'recording' | 'reviewing';
  steps: FlowStep[];
  /** The tab's URL the last time recording state observed it — the
   * baseline `handleRecordingNavigation` diffs `chrome.tabs.onUpdated`
   * against to detect a REAL navigation (vs. a redundant "complete" event
   * for the same document). Doubles as the origin source at save time. */
  lastUrl: string;
  /** Set once the 20-step cap was hit — surfaced to the popup so it can
   * show "recording stopped: step limit reached" instead of a plain Stop. */
  capped: boolean;
  /** Per-session CDP binding name — randomized every recording start (an
   * independent random identifier, no shared affix with the other two
   * globals) so a page script has no stable global to probe for "is
   * recording active" (see recorder.ts's THREAT MODEL doc). */
  bindingName: string;
  /** Per-session in-page idempotency-flag global name (independent random). */
  activeFlag: string;
  /** Per-session in-page teardown-function global name (independent
   * random). Passed to `buildStopRecorderJs` on every exit path. */
  stopFn: string;
  /** Per-session shared secret carried in every recorder payload — a
   * binding call whose payload lacks the right nonce is discarded before
   * parsing (parseRecordedPayload). Rotated every recording start. */
  nonce: string;
  /** 0-based indices of steps whose recorded selector was flagged
   * `ambiguous` by genSelectorInfo (may match multiple elements,
   * first-match-wins). Surfaced per-step in the popup's review list and
   * folded into the saved recipe's description via buildAmbiguousNote —
   * never silently dropped. */
  ambiguousStepIndices: number[];
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

// === CDP types — only the fields we actually read ======================
// The real Chrome DevTools Protocol surface is huge; the chrome.debugger
// API hands us back `unknown` and leaves the typing to us. These shapes
// describe just the slices we use, so the rest of the file can drop
// `Record<string, any>` casts and `unknown` member access entirely.

interface CdpRuntimeEvaluateResponse<T = unknown> {
  result: { value: T };
  exceptionDetails?: {
    exception?: { description?: string };
    text?: string;
  };
}

interface CdpRuntimeConsoleAPICalled {
  args?: { value?: unknown; description?: string }[];
  timestamp?: number;
  type?: string;
}

interface CdpLogEntryAdded {
  entry?: {
    level?: string;
    text?: string;
    timestamp?: number;
    url?: string;
    lineNumber?: number;
  };
}

interface CdpNetworkRequestWillBeSent {
  requestId: string;
  type?: string;
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    postData?: string;
  };
}

interface CdpNetworkResponseReceived {
  requestId: string;
  response?: {
    status?: number;
    statusText?: string;
    mimeType?: string;
    headers?: Record<string, string>;
  };
}

interface CdpNetworkLoadingFinished {
  requestId: string;
  encodedDataLength?: number;
}

interface CdpNetworkLoadingFailed {
  requestId: string;
  errorText?: string;
}

interface CdpNetworkGetResponseBody {
  body: string;
  base64Encoded: boolean;
}

interface CdpInputDragIntercepted {
  data: unknown;
}

interface CdpPageJavascriptDialogOpening {
  type?: string;
  message?: string;
  defaultPrompt?: string;
  url?: string;
}

interface CdpPageJavascriptDialogClosed {
  result?: boolean;
  userInput?: string;
}

/** Information we surface in the popup about a native dialog currently
 * blocking a tab. Cleared on dialog-closed. */
interface PendingDialogInfo {
  type: string;
  message: string;
  default_prompt?: string;
  url?: string;
}

// Runtime messages between popup.ts and this script.
type RuntimeMessage =
  | { action: 'connect'; tabId: number }
  | { action: 'disconnect'; tabId: number }
  | { action: 'status'; tabId: number }
  | { action: 'pendingDialog'; tabId: number }
  | { action: 'respondDialog'; tabId: number; accept: boolean; promptText?: string }
  | { action: 'versionCheck' }
  | { action: 'recordingStatus'; tabId: number }
  | { action: 'startRecording'; tabId: number }
  | { action: 'stopRecording'; tabId: number }
  | { action: 'discardRecording'; tabId: number }
  | { action: 'saveRecording'; tabId: number; name: string; description?: string };

function isRuntimeMessage(msg: unknown): msg is RuntimeMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.action === 'versionCheck') return true;
  if (m.action === 'saveRecording') {
    return typeof m.tabId === 'number' && typeof m.name === 'string';
  }
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
    m.action === 'discardRecording'
  );
}

const tabStates = new Map<number, TabState>();

/** Per-tab `chrome.tabs.onUpdated` listener installed while that tab is
 * recording, so `handleRecordingNavigation` fires on every navigation and
 * `stopRecording`/`cleanup` can remove EXACTLY this listener rather than
 * guessing which one belongs to which tab. Kept out of `TabState` itself
 * (unlike `debuggerListener`) only because it needs to be reachable from
 * `chrome.tabs.onRemoved`/`cleanup` even in the split second before a
 * `TabState` exists — in practice that never happens today, but keeping
 * the two concerns in separate maps avoids coupling tab-removal cleanup to
 * TabState's shape. */
const recordingNavListeners = new Map<
  number,
  Parameters<typeof chrome.tabs.onUpdated.addListener>[0]
>();

function send(ws: WebSocket, msg: ExtensionToServer): void {
  ws.send(JSON.stringify(msg));
}

function safeParse(raw: string): ServerToExtension | null {
  try {
    return JSON.parse(raw) as ServerToExtension;
  } catch {
    return null;
  }
}

function cdp<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return chrome.debugger.sendCommand({ tabId }, method, params) as unknown as Promise<T>;
}

/**
 * Mapping from the CDP permission name (the contract `browser.set_permission`
 * accepts on the wire) to the `chrome.contentSettings` setting key. Only the
 * names that actually have a contentSettings surface in MV3 are listed —
 * `Browser.setPermission` covers more, but that domain is not reachable from
 * `chrome.debugger` attached to a tab.
 */
const CONTENT_SETTING_BY_PERMISSION: Record<string, string | undefined> = {
  geolocation: 'location',
  notifications: 'notifications',
  camera: 'camera',
  microphone: 'microphone',
  clipboardReadWrite: 'clipboard',
  clipboardSanitizedWrite: 'clipboard',
  sensors: 'sensors',
};

const STATE_TO_CONTENT_SETTING: Record<string, string | undefined> = {
  granted: 'allow',
  denied: 'block',
  prompt: 'ask',
};

/**
 * Apply a `chrome.contentSettings.<setting>.set({ primaryPattern, setting })`
 * call without statically referencing each key — the `contentSettings`
 * surface is dynamic at the API level. We narrow `unknown` carefully so the
 * cast is the smallest possible.
 */
async function applyContentSetting(
  settingKey: string,
  primaryPattern: string,
  setting: string,
): Promise<void> {
  const root = (
    chrome as unknown as {
      contentSettings?: Record<string, unknown>;
    }
  ).contentSettings;
  if (!root) throw new Error('chrome.contentSettings not available in this build');
  const setter = root[settingKey] as
    { set(details: { primaryPattern: string; setting: string }): Promise<void> } | undefined;
  if (!setter || typeof setter.set !== 'function') {
    throw new Error(`chrome.contentSettings.${settingKey} is not exposed in this Chrome build`);
  }
  await setter.set({ primaryPattern, setting });
}

/**
 * Defensive caps applied to every duration that ends up in a setTimeout
 * driven by tool params. The MCP request payload is technically untrusted
 * input, so CodeQL flags unbounded user-controlled timer durations as a
 * resource-exhaustion risk. We clamp at the boundary (drag handler) AND
 * inside `sleep` so the property is enforced even if a future call site
 * forgets to validate.
 */
const MAX_DRAG_DURATION_MS = 60_000;
const MAX_DRAG_HOLD_MS = 10_000;

function sleep(ms: number): Promise<void> {
  // Range-branch sanitizer for CodeQL's js/resource-exhaustion: the
  // setTimeout call is INSIDE a literal-bounded range check. Caller-side
  // clamping in the drag handler is the first line of defence; this is
  // the second.
  return new Promise((resolve) => {
    if (typeof ms === 'number' && ms > 0 && ms < 60_000) {
      setTimeout(resolve, ms);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/** Run the shared post-action settle wait for a tab. Thin closure binder
 * over `settleSafely` (see settle.ts) — which is guaranteed not to throw,
 * so an action that navigated the page (destroying the settle expression's
 * execution context) still returns ok:true with a degraded settle object
 * instead of flipping the whole response to ok:false. */
function runSettle(
  tabId: number,
  settle: ReturnType<typeof resolveSettleParams>,
): Promise<Record<string, unknown> | undefined> {
  return settleSafely((expression) => evaluateInTab(tabId, expression), settle);
}

/**
 * Dispatch the CDP `Input.dispatchKeyEvent` sequence for one resolved key.
 * The event shapes come from `buildKeyEventSequence` (keymap.ts) — pure and
 * unit-tested there; this wrapper only feeds them to chrome.debugger. This
 * is the ONLY path in this extension that produces `isTrusted: true`
 * keyboard events — see browser.press's doc block for why that matters
 * (Qt-WASM and similar runtimes discard synthetic KeyboardEvents dispatched
 * via browser.evaluate).
 */
async function dispatchKeyEvent(
  tabId: number,
  def: KeyDefinition,
  modifiers: number,
): Promise<void> {
  for (const event of buildKeyEventSequence(def, modifiers)) {
    await cdp(tabId, 'Input.dispatchKeyEvent', event);
  }
}

/**
 * Wait for ONE CDP event of a given method on a given tab. Adds a temporary
 * chrome.debugger.onEvent listener for the duration of the wait. Resolves
 * with the event params, or null on timeout. Always cleans up its listener.
 *
 * Used by the drag tool to capture Input.dragIntercepted while
 * Input.setInterceptDrags is enabled.
 */
function waitForCdpEvent<T = unknown>(
  tabId: number,
  method: string,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const handler = (source: chrome.debugger.Debuggee, m: string, params?: object): void => {
      if (settled) return;
      if (source.tabId !== tabId) return;
      if (m !== method) return;
      settled = true;
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(handler);
      resolve((params ?? null) as T | null);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.debugger.onEvent.removeListener(handler);
      resolve(null);
    }, timeoutMs);
    chrome.debugger.onEvent.addListener(handler);
  });
}

/**
 * Build the JS expression that checks a single wait_for condition for a
 * selector. Returns a boolean. Used by `case 'wait_for'` in handleTool.
 *
 *  - visible:  element exists AND non-zero box AND opacity > 0
 *  - hidden:   element doesn't exist OR zero box OR opacity 0 OR display:none
 *  - attached: element exists in DOM (any state)
 *  - detached: element does NOT exist in DOM
 */
function buildWaitSelectorExpr(selector: string, condition: string): string {
  const sel = JSON.stringify(selector);
  if (condition === 'attached') {
    return `Boolean(document.querySelector(${sel}))`;
  }
  if (condition === 'detached') {
    return `!document.querySelector(${sel})`;
  }
  // visible / hidden share the same probe — only the truthiness flips.
  const want = condition === 'hidden' ? '!' : '';
  return `(() => {
    const el = document.querySelector(${sel});
    if (!el) return ${condition === 'hidden' ? 'true' : 'false'};
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return ${condition === 'hidden' ? 'true' : 'false'};
    const r = el.getBoundingClientRect();
    return ${want}(r.width > 0 && r.height > 0);
  })()`;
}

// Convert an arbitrary console arg (`unknown`) into something printable
// without leaking `[object Object]`. Used by the console buffer when CDP
// hands us values we don't statically know.
function stringifyConsoleArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

function pushConsole(state: TabState, entry: ConsoleEntry): void {
  state.consoleBuffer.push(entry);
  if (state.consoleBuffer.length > CONSOLE_BUFFER_MAX) {
    state.consoleBuffer.shift();
  }
}

function ensureNetworkEntry(state: TabState, requestId: string): NetworkEntry {
  let entry = state.networkBuffer.get(requestId);
  if (!entry) {
    entry = { request_id: requestId, url: '', method: '', started_at: Date.now() };
    state.networkBuffer.set(requestId, entry);
    state.networkOrder.push(requestId);
    while (state.networkOrder.length > NETWORK_BUFFER_MAX) {
      const oldId = state.networkOrder.shift();
      if (oldId !== undefined) state.networkBuffer.delete(oldId);
    }
  }
  return entry;
}

function attachDebuggerListener(state: TabState): void {
  const listener = (method: string, params: unknown): void => {
    if (method === 'Runtime.consoleAPICalled') {
      const p = params as CdpRuntimeConsoleAPICalled;
      const args = p.args ?? [];
      const text = args
        .map((a) => (a.value !== undefined ? stringifyConsoleArg(a.value) : (a.description ?? '')))
        .join(' ');
      pushConsole(state, {
        timestamp: p.timestamp ?? Date.now(),
        level: p.type ?? 'log',
        text,
        source: 'console',
      });
      return;
    }
    if (method === 'Log.entryAdded') {
      const p = params as CdpLogEntryAdded;
      const e = p.entry ?? {};
      pushConsole(state, {
        timestamp: e.timestamp ?? Date.now(),
        level: e.level ?? 'log',
        text: e.text ?? '',
        source: 'log',
        url: e.url,
        line: e.lineNumber,
      });
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      const p = params as CdpNetworkRequestWillBeSent;
      const entry = ensureNetworkEntry(state, p.requestId);
      entry.url = p.request?.url ?? entry.url;
      entry.method = p.request?.method ?? entry.method;
      entry.resource_type = p.type ?? entry.resource_type;
      entry.request_headers = p.request?.headers ?? entry.request_headers;
      entry.request_post_data = p.request?.postData ?? entry.request_post_data;
      return;
    }
    if (method === 'Network.responseReceived') {
      const p = params as CdpNetworkResponseReceived;
      const entry = ensureNetworkEntry(state, p.requestId);
      entry.status = p.response?.status;
      entry.status_text = p.response?.statusText;
      entry.mime_type = p.response?.mimeType;
      entry.response_headers = p.response?.headers;
      return;
    }
    if (method === 'Network.loadingFinished') {
      const p = params as CdpNetworkLoadingFinished;
      const entry = ensureNetworkEntry(state, p.requestId);
      entry.finished_at = Date.now();
      entry.encoded_data_length = p.encodedDataLength;
      return;
    }
    if (method === 'Network.loadingFailed') {
      const p = params as CdpNetworkLoadingFailed;
      const entry = ensureNetworkEntry(state, p.requestId);
      entry.finished_at = Date.now();
      entry.failed = p.errorText ?? 'failed';
      return;
    }
    if (method === 'Page.javascriptDialogOpening') {
      // The page JS thread is now frozen until something calls
      // Page.handleJavaScriptDialog. We do NOT respond automatically —
      // the agent reads dialog-opening from browser.events and decides
      // via browser.dialog_respond. The popup also exposes accept/dismiss
      // buttons as a manual escape hatch.
      const p = params as CdpPageJavascriptDialogOpening;
      const info: PendingDialogInfo = {
        type: p.type ?? 'alert',
        message: p.message ?? '',
      };
      if (typeof p.defaultPrompt === 'string') info.default_prompt = p.defaultPrompt;
      if (typeof p.url === 'string') info.url = p.url;
      state.pendingDialog = info;
      if (state.ws && state.ws.readyState === WebSocket.OPEN && state.serverTabId) {
        const data: Record<string, unknown> = {
          type: info.type,
          message: info.message,
        };
        if (info.default_prompt !== undefined) data.default_prompt = info.default_prompt;
        if (info.url !== undefined) data.url = info.url;
        send(state.ws, {
          kind: 'bridge.event',
          eventKind: 'dialog-opening',
          tabId: state.serverTabId,
          data,
        });
      }
      return;
    }
    if (method === 'Page.javascriptDialogClosed') {
      const p = params as CdpPageJavascriptDialogClosed;
      state.pendingDialog = undefined;
      if (state.ws && state.ws.readyState === WebSocket.OPEN && state.serverTabId) {
        const data: Record<string, unknown> = { accept: p.result === true };
        if (typeof p.userInput === 'string') data.user_input = p.userInput;
        send(state.ws, {
          kind: 'bridge.event',
          eventKind: 'dialog-closed',
          tabId: state.serverTabId,
          data,
        });
      }
      return;
    }
    if (method === 'Runtime.bindingCalled') {
      // Fired for EVERY CDP binding on the tab, not just ours. Two gates
      // before a payload is even parsed: the per-session binding name must
      // match, and — inside parseRecordedPayload — the payload must carry
      // the per-session nonce only the injected recorder knows. A page
      // script calling the binding blind (it CAN reach the function — CDP
      // bindings are page-visible globals) fails the nonce check and
      // records nothing. See recorder.ts's THREAT MODEL doc.
      const p = params as { name?: string; payload?: string };
      const recording = state.recording;
      if (!recording || recording.status !== 'recording') return;
      if (p.name !== recording.bindingName) return;
      const payload = parseRecordedPayload(p.payload ?? '', recording.nonce);
      if (!payload) return;
      const result = appendRecordingStep(recording.steps, toFlowStep(payload));
      recording.steps = result.steps;
      if (!result.capped && payload.kind !== 'press' && payload.ambiguous === true) {
        recording.ambiguousStepIndices.push(result.steps.length - 1);
      }
      if (result.capped) {
        recording.capped = true;
        void finishRecording(state.tabId);
      }
      return;
    }
  };
  state.debuggerListener = listener;
}

/** Build the canvas-screenshot expression. Walks nested Shadow DOM roots
 * (Qt-WASM apps hide their canvas behind two layers of attachShadow), then
 * either dumps the whole canvas via `toDataURL` or crops to a region via a
 * temp 2D canvas. Returns the base64 body (no `data:` prefix) plus enough
 * size metadata for callers to convert CSS-pixel coordinates to canvas
 * pixels and vice versa.
 *
 * Caveat (also documented in the tool's `doc.gotchas`): pure WebGL canvases
 * created without `preserveDrawingBuffer: true` may return blank pixels —
 * the framebuffer is cleared between frames. Qt-WASM enables preservation,
 * so the headline use case (Victron VRM Remote Console, Venus OS) works.
 */
interface CanvasScreenshotOpts {
  selector?: string;
  region?: { x: number; y: number; w: number; h: number };
  format: 'png' | 'jpeg';
}

function buildCanvasScreenshotJs(opts: CanvasScreenshotOpts): string {
  const optsJson = JSON.stringify({
    selector: opts.selector ?? null,
    region: opts.region ?? null,
    format: opts.format,
  });
  return `
(() => {
  const opts = ${optsJson};

  function findCanvas(root) {
    if (!root) return null;
    // If a selector was provided, try it on this root first. The selector
    // may target the canvas directly or a host that contains it.
    if (opts.selector) {
      try {
        const direct = root.querySelector(opts.selector);
        if (direct) {
          if (direct.tagName === 'CANVAS') return direct;
          const nested = direct.querySelector ? direct.querySelector('canvas') : null;
          if (nested) return nested;
        }
      } catch (_) { /* invalid selector — fall through to heuristic */ }
    }
    // Heuristic: first visible canvas in this root.
    const c = root.querySelector && root.querySelector('canvas');
    if (c && c.offsetParent !== null) return c;
    if (root.querySelectorAll) {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const r = findCanvas(el.shadowRoot);
          if (r) return r;
        }
      }
    }
    return null;
  }

  const canvas = findCanvas(document);
  if (!canvas) {
    return { ok: false, reason: 'no-canvas', message: 'No <canvas> found in the document or any reachable Shadow DOM root.' };
  }

  const rect = canvas.getBoundingClientRect();
  const cssSize = { w: rect.width, h: rect.height };
  const pixelSize = { w: canvas.width, h: canvas.height };
  const mime = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';

  let imageUrl;
  let region = { x: 0, y: 0, w: canvas.width, h: canvas.height };

  if (opts.region) {
    // Clamp the requested region against the canvas backing store so a
    // bad x/y/w/h never produces a black band outside the real pixels.
    const x = Math.max(0, Math.min(canvas.width - 1, Math.round(opts.region.x)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.round(opts.region.y)));
    const w = Math.max(1, Math.min(canvas.width - x, Math.round(opts.region.w)));
    const h = Math.max(1, Math.min(canvas.height - y, Math.round(opts.region.h)));
    region = { x, y, w, h };
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext('2d');
    if (!ctx) {
      return { ok: false, reason: 'crop-failed', message: '2D context unavailable for crop canvas.' };
    }
    try {
      ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
      imageUrl = tmp.toDataURL(mime);
    } catch (err) {
      return { ok: false, reason: 'tainted', message: err && err.message ? err.message : String(err) };
    }
  } else {
    try {
      imageUrl = canvas.toDataURL(mime);
    } catch (err) {
      return { ok: false, reason: 'tainted', message: err && err.message ? err.message : String(err) };
    }
  }

  const commaIdx = imageUrl.indexOf(',');
  const imageB64 = commaIdx >= 0 ? imageUrl.slice(commaIdx + 1) : imageUrl;

  return {
    ok: true,
    canvas_size: cssSize,
    canvas_pixels: pixelSize,
    region,
    format: opts.format,
    image_b64: imageB64,
    taken_at_ms: Date.now(),
  };
})()
`;
}

/** Result shape returned by `buildClickResolveJs` — see `inpage/builders.ts`. */
type ClickResolveResult =
  | { ok: true; x: number; y: number; tag: string; hit_element?: string }
  | { ok: false; reason: 'invalid-selector'; error: string }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'occluded'; blocker: string };

/** Result shape returned by `buildTypeResolveJs` — see `inpage/builders.ts`. */
type TypeResolveResult =
  | { ok: true }
  | { ok: false; reason: 'invalid-selector'; error: string }
  | { ok: false; reason: 'not-found' };

async function evaluateInTab<T = unknown>(tabId: number, expression: string): Promise<T> {
  const result = await cdp<CdpRuntimeEvaluateResponse<T>>(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const ex = result.exceptionDetails;
    throw new Error(ex.exception?.description ?? ex.text ?? 'Evaluation failed');
  }
  return result.result.value;
}

async function waitForLoad(tabId: number, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handler);
      reject(new Error('navigation timed out'));
    }, timeoutMs);
    const handler: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (updatedId, info) => {
      if (updatedId === tabId && info.status === 'complete') {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(handler);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(handler);
  });
}

/**
 * `performFind` / `performClick` / `performType` / `performPress` /
 * `performWaitFor` / `performDrag` — the extracted bodies of the
 * standalone `find` / `click` / `type` / `press` / `wait_for` / `drag`
 * cases in `handleTool` below.
 *
 * Both the standalone `case` handlers AND `browser.flow`'s step executor
 * (`runFlow` in `./flow.js`) call these exact functions — there is one
 * implementation of each action, never a copy that can drift. Each
 * returns an `ActionOutcome<T>` (`{ok:true,result} | {ok:false,error}`)
 * instead of a wire-level `tool.response`, so the two call sites can
 * unwrap it however they need to (the standalone case wraps it straight
 * into a `tool.response`; `runFlow` inspects `result` for its own
 * fail-fast rules — e.g. `wait_for`'s `matched:false` is `ok:true` here,
 * matching the standalone tool's contract, and it is `runFlow`, not this
 * function, that decides a non-match should stop the flow).
 *
 * `performType`'s `selector` is optional here (the standalone tool's JSON
 * schema still requires it, so that path never changes): when omitted,
 * this skips element resolution entirely and types into whatever
 * currently has focus, mirroring how `performPress` already behaves with
 * no `selector`. That is what lets a `browser.flow` step continue typing
 * into a freshly-appeared, auto-focused input (e.g. a search box that
 * opened after a preceding click) without a selector for it.
 */

async function performFind(
  tabId: number,
  params: { text: string; role?: string; exact?: boolean },
): Promise<ActionOutcome<FindStepResult>> {
  try {
    const { text } = params;
    if (!text) return { ok: false, error: 'find: text required' };
    const value = await evaluateInTab<FindStepResult>(
      tabId,
      buildFindJs({ text, role: params.role, exact: params.exact === true }),
    );
    return { ok: true, result: value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function performClick(
  tabId: number,
  params: { selector: string; force?: boolean; settle_ms?: number; settle_timeout_ms?: number },
): Promise<ActionOutcome<ClickStepResult>> {
  try {
    const { selector, force = false } = params;
    const settle = resolveSettleParams({
      settle_ms: params.settle_ms,
      settle_timeout_ms: params.settle_timeout_ms,
    });
    const resolved = await evaluateInTab<ClickResolveResult>(
      tabId,
      buildClickResolveJs({ selector, force }),
    );
    if (!resolved.ok) {
      if (resolved.reason === 'occluded') {
        return {
          ok: false,
          error: `Element covered by ${resolved.blocker} — click the covering element or dismiss it first`,
        };
      }
      if (resolved.reason === 'invalid-selector') {
        return { ok: false, error: `Invalid selector "${selector}": ${resolved.error}` };
      }
      return { ok: false, error: `Element not found: ${selector}` };
    }
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: resolved.x,
      y: resolved.y,
    });
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: resolved.x,
      y: resolved.y,
      button: 'left',
      clickCount: 1,
    });
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: resolved.x,
      y: resolved.y,
      button: 'left',
      clickCount: 1,
    });
    const settleResult = await runSettle(tabId, settle);
    const result: ClickStepResult = { clicked: selector, tag: resolved.tag };
    if (resolved.hit_element) result.hit_element = resolved.hit_element;
    if (settleResult) result.settle = settleResult;
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function performType(
  tabId: number,
  params: {
    selector?: string;
    text: string;
    clear?: boolean;
    settle_ms?: number;
    settle_timeout_ms?: number;
  },
): Promise<ActionOutcome<TypeStepResult>> {
  try {
    const { selector, text, clear = false } = params;
    const settle = resolveSettleParams({
      settle_ms: params.settle_ms,
      settle_timeout_ms: params.settle_timeout_ms,
    });
    if (selector !== undefined) {
      const resolved = await evaluateInTab<TypeResolveResult>(
        tabId,
        buildTypeResolveJs({ selector, clear }),
      );
      if (!resolved.ok) {
        if (resolved.reason === 'invalid-selector') {
          return { ok: false, error: `Invalid selector "${selector}": ${resolved.error}` };
        }
        return { ok: false, error: `Element not found: ${selector}` };
      }
    }
    await cdp(tabId, 'Input.insertText', { text });
    const settleResult = await runSettle(tabId, settle);
    const result: TypeStepResult = { typed: text.length };
    if (selector !== undefined) result.selector = selector;
    if (settleResult) result.settle = settleResult;
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function performPress(
  tabId: number,
  params: {
    key?: string;
    modifiers?: string[];
    selector?: string;
    settle_ms?: number;
    settle_timeout_ms?: number;
  },
): Promise<ActionOutcome<PressStepResult>> {
  try {
    const key = params.key;
    if (!key) return { ok: false, error: 'press: key required' };
    const def = resolveKey(key);
    if (!def) return { ok: false, error: `press: unrecognized key "${key}"` };
    const modifierNames = params.modifiers ?? [];
    const modifiers =
      modifiersToBitmask(modifierNames) | (def.needsShift ? MODIFIER_BITS.Shift : 0);
    const settle = resolveSettleParams({
      settle_ms: params.settle_ms,
      settle_timeout_ms: params.settle_timeout_ms,
    });
    if (params.selector) {
      const focused = await evaluateInTab<boolean>(
        tabId,
        buildFocusJs({ selector: params.selector }),
      );
      if (!focused) {
        return { ok: false, error: `Element not found: ${params.selector}` };
      }
    }
    await dispatchKeyEvent(tabId, def, modifiers);
    const settleResult = await runSettle(tabId, settle);
    const result: PressStepResult = { key, modifiers: modifierNames };
    if (settleResult) result.settle = settleResult;
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function performWaitFor(
  tabId: number,
  state: TabState,
  params: {
    selector?: string;
    expression?: string;
    network_url?: string;
    condition?: string;
    timeout_ms?: number;
    poll_interval_ms?: number;
  },
): Promise<ActionOutcome<WaitForStepResult>> {
  try {
    const waitSelector = params.selector;
    const waitExpression = params.expression;
    const waitNetworkUrl = params.network_url;
    const waitCondition = params.condition ?? 'visible';
    // Defensive caps mirror the dispatcher's contract and keep CodeQL
    // happy about setTimeout durations driven by request params.
    const MAX_WAIT_TIMEOUT_MS = 30_000;
    const MIN_POLL_MS = 50;
    const MAX_POLL_MS = 1_000;
    const requestedTimeout = params.timeout_ms ?? 5_000;
    const timeoutMs =
      requestedTimeout < MAX_WAIT_TIMEOUT_MS ? requestedTimeout : MAX_WAIT_TIMEOUT_MS;
    const requestedPoll = params.poll_interval_ms ?? 100;
    const pollIntervalMs =
      requestedPoll < MIN_POLL_MS
        ? MIN_POLL_MS
        : requestedPoll > MAX_POLL_MS
          ? MAX_POLL_MS
          : requestedPoll;

    // Build the check function based on which mode the caller picked. The
    // dispatcher already enforced "exactly one of selector / expression /
    // network_url" so we just pick the first defined one. If none are
    // defined (shouldn't happen from a well-formed call), the check stays
    // null and we return matched=false immediately.
    let check: (() => Promise<boolean>) | null = null;
    if (waitSelector !== undefined) {
      const expr = buildWaitSelectorExpr(waitSelector, waitCondition);
      check = async (): Promise<boolean> => {
        try {
          const result = await evaluateInTab(tabId, expr);
          return Boolean(result);
        } catch {
          // If the page is unreachable mid-poll, count as "not yet matched".
          return false;
        }
      };
    } else if (waitExpression !== undefined) {
      const wrapped = `Boolean(${waitExpression})`;
      check = async (): Promise<boolean> => {
        try {
          const result = await evaluateInTab(tabId, wrapped);
          return Boolean(result);
        } catch {
          return false;
        }
      };
    } else if (waitNetworkUrl !== undefined) {
      const needle = waitNetworkUrl.toLowerCase();
      check = (): Promise<boolean> => {
        for (const id of state.networkOrder) {
          const r = state.networkBuffer.get(id);
          if (!r) continue;
          if (r.finished_at === undefined) continue;
          if (r.url.toLowerCase().includes(needle)) return Promise.resolve(true);
        }
        return Promise.resolve(false);
      };
    }

    const startedAt = Date.now();
    let checks = 0;
    let matched = false;
    while (check) {
      checks++;
      if (await check()) {
        matched = true;
        break;
      }
      if (Date.now() - startedAt >= timeoutMs) break;
      await sleep(pollIntervalMs);
    }
    const elapsedMs = Date.now() - startedAt;

    const result: WaitForStepResult = matched
      ? { matched: true, elapsed_ms: elapsedMs, checks }
      : { matched: false, elapsed_ms: elapsedMs, checks, reason: 'timeout' };
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function performDrag(
  tabId: number,
  params: DragStepParams,
): Promise<ActionOutcome<DragStepResult>> {
  try {
    // Same numeric guard the wire boundary used before this body was
    // extracted out of `handleDrag`: anything non-finite or negative is
    // treated as absent, so flow drag steps get identical protection.
    const num = (v: number | undefined): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
    const clamp = (v: number, max: number): number => Math.min(v, max);
    const fromSelector = params.from_selector;
    const toSelector = params.to_selector;
    const fromXRaw = num(params.from_x);
    const fromYRaw = num(params.from_y);
    const toXRaw = num(params.to_x);
    const toYRaw = num(params.to_y);
    // Cap every duration that ends up in a setTimeout to keep CodeQL's
    // "user-controlled timer duration" check happy and to prevent a
    // misbehaving agent from parking the bridge for hours on a typo.
    const durationMs = clamp(num(params.duration_ms) ?? 1500, MAX_DRAG_DURATION_MS);
    const holdBeforeMoveMs = clamp(num(params.hold_before_move_ms) ?? 0, MAX_DRAG_HOLD_MS);
    const holdBeforeReleaseMs = clamp(num(params.hold_before_release_ms) ?? 0, MAX_DRAG_HOLD_MS);

    const hasFromCoords = fromXRaw !== undefined && fromYRaw !== undefined;
    const hasToCoords = toXRaw !== undefined && toYRaw !== undefined;
    if (!fromSelector && !hasFromCoords) {
      return { ok: false, error: 'drag: provide from_selector or both from_x and from_y' };
    }
    if (!toSelector && !hasToCoords) {
      return { ok: false, error: 'drag: provide to_selector or both to_x and to_y' };
    }

    const probeExpr = buildDragProbeJs({
      from_selector: fromSelector,
      to_selector: toSelector,
      from_x: fromXRaw,
      from_y: fromYRaw,
      to_x: toXRaw,
      to_y: toYRaw,
    });
    const probe = await evaluateInTab<{
      err?: string;
      from?: { x: number; y: number; in_viewport: boolean };
      to?: { x: number; y: number; in_viewport: boolean };
      draggable?: boolean;
    }>(tabId, probeExpr);
    if (probe.err) {
      return { ok: false, error: `drag: ${probe.err}` };
    }
    if (!probe.from || !probe.to) {
      return { ok: false, error: 'drag: could not resolve coordinates' };
    }
    if (!probe.from.in_viewport) {
      return {
        ok: false,
        error: 'drag: source point is offscreen — scroll first or pass viewport coords',
      };
    }
    if (!probe.to.in_viewport) {
      return {
        ok: false,
        error: 'drag: destination point is offscreen — scroll first or pass viewport coords',
      };
    }

    const fromX = probe.from.x;
    const fromY = probe.from.y;
    const toX = probe.to.x;
    const toY = probe.to.y;
    const isDraggable = !!probe.draggable;

    // ~30fps interpolation; minimum 2 steps so the path actually has a midpoint.
    const steps = durationMs > 0 ? Math.max(2, Math.round(durationMs / 33)) : 1;
    const stepDelayMs = steps > 0 ? durationMs / steps : 0;
    const eventsFired: string[] = [];
    // Every branch below reassigns `dragMode` before the final `return`
    // reads it. (The old `case`-block extraction needed a
    // no-useless-assignment disable here; inside this try/catch scope the
    // linter no longer flags the initializer, so the directive is gone.)
    let dragMode: 'html5' | 'pointer' = 'pointer';
    let interceptReceived = false;
    const dragStart = Date.now();
    let interceptionEnabled = false;

    const interpolate = (t: number): { x: number; y: number } => ({
      x: fromX + (toX - fromX) * t,
      y: fromY + (toY - fromY) * t,
    });

    // Mouse move WITH the left button held down. Chrome's HTML5 drag
    // system only treats movement as a drag when the button state is
    // signalled on every move after mousePressed; omitting it makes
    // Blink ignore the move for drag-detection purposes.
    const moveHeld = (x: number, y: number): Promise<unknown> =>
      cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'left',
        buttons: 1,
      });

    // Wiggle distance has to comfortably clear `kDragThreshold` (~5px on
    // Mac, 4px on Linux/Windows). 5px landed *right* at the boundary and
    // Chrome did not start the drag — 20px crosses it on every platform.
    const WIGGLE_PX = 20;
    // Time to wait for Input.dragIntercepted after the wiggle. 120ms was
    // enough on local-only synthetic tests but flaky in real Chrome —
    // 250ms is comfortable without dragging out the overall latency.
    const INTERCEPT_TIMEOUT_MS = 250;

    try {
      if (isDraggable) {
        try {
          await cdp(tabId, 'Input.setInterceptDrags', { enabled: true });
          interceptionEnabled = true;
        } catch {
          // setInterceptDrags is experimental — fall back to pointer mode silently.
        }
      }

      if (interceptionEnabled) {
        // Arm the listener BEFORE the press+wiggle that may trigger it.
        const interceptPromise = waitForCdpEvent<CdpInputDragIntercepted>(
          tabId,
          'Input.dragIntercepted',
          INTERCEPT_TIMEOUT_MS,
        );
        await cdp(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: fromX,
          y: fromY,
        });
        await cdp(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: fromX,
          y: fromY,
          button: 'left',
          clickCount: 1,
        });
        if (holdBeforeMoveMs > 0) await sleep(holdBeforeMoveMs);
        // Wiggle toward the destination so Chrome's native drag system
        // crosses its activation threshold. Direction matters for libs
        // that have direction-sensitive activation constraints.
        const dx = toX - fromX;
        const dy = toY - fromY;
        const len = Math.hypot(dx, dy) || 1;
        const wx = fromX + (dx / len) * WIGGLE_PX;
        const wy = fromY + (dy / len) * WIGGLE_PX;
        await moveHeld(wx, wy);

        const intercepted = await interceptPromise;
        if (intercepted) {
          dragMode = 'html5';
          interceptReceived = true;
          eventsFired.push('Input.dragIntercepted');
          const dragData = intercepted.data as Record<string, unknown>;
          for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const { x, y } = interpolate(t);
            await moveHeld(x, y);
            await cdp(tabId, 'Input.dispatchDragEvent', {
              type: 'dragOver',
              x,
              y,
              data: dragData,
            });
            if (i === 1) eventsFired.push('dragOver');
            if (stepDelayMs > 0) await sleep(stepDelayMs);
          }
          await cdp(tabId, 'Input.dispatchDragEvent', {
            type: 'dragEnter',
            x: toX,
            y: toY,
            data: dragData,
          });
          eventsFired.push('dragEnter');
          await cdp(tabId, 'Input.dispatchDragEvent', {
            type: 'dragOver',
            x: toX,
            y: toY,
            data: dragData,
          });
          if (holdBeforeReleaseMs > 0) await sleep(holdBeforeReleaseMs);
          await cdp(tabId, 'Input.dispatchDragEvent', {
            type: 'drop',
            x: toX,
            y: toY,
            data: dragData,
          });
          eventsFired.push('drop');
          await cdp(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: toX,
            y: toY,
            button: 'left',
            clickCount: 1,
          });
        } else {
          // Element was tagged draggable but no native drag fired — the page
          // either preventDefault'd dragstart or wires its own pointer logic.
          // Continue with pointer-only events from where we already pressed.
          dragMode = 'pointer';
          for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const { x, y } = interpolate(t);
            await moveHeld(x, y);
            if (stepDelayMs > 0) await sleep(stepDelayMs);
          }
          if (holdBeforeReleaseMs > 0) await sleep(holdBeforeReleaseMs);
          await cdp(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: toX,
            y: toY,
            button: 'left',
            clickCount: 1,
          });
        }
      } else {
        // Pointer-only branch: no native drag involvement at all.
        dragMode = 'pointer';
        await cdp(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: fromX,
          y: fromY,
        });
        await cdp(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: fromX,
          y: fromY,
          button: 'left',
          clickCount: 1,
        });
        if (holdBeforeMoveMs > 0) await sleep(holdBeforeMoveMs);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const { x, y } = interpolate(t);
          await moveHeld(x, y);
          if (stepDelayMs > 0) await sleep(stepDelayMs);
        }
        if (holdBeforeReleaseMs > 0) await sleep(holdBeforeReleaseMs);
        await cdp(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: toX,
          y: toY,
          button: 'left',
          clickCount: 1,
        });
      }
    } finally {
      // Critical: leaving interception on would block the human user from
      // dragging anything in this tab. Best-effort cleanup, swallow errors.
      if (interceptionEnabled) {
        try {
          await cdp(tabId, 'Input.setInterceptDrags', { enabled: false });
        } catch {
          // ignore
        }
      }
    }

    return {
      ok: true,
      result: {
        from: { x: fromX, y: fromY, selector: fromSelector ?? null },
        to: { x: toX, y: toY, selector: toSelector ?? null },
        duration_ms_actual: Date.now() - dragStart,
        drag_mode: dragMode,
        interception_attempted: interceptionEnabled,
        intercept_received: interceptReceived,
        events_fired: eventsFired,
      },
    };
  } catch (err) {
    // The pre-extraction `case 'drag'` let thrown errors bubble to
    // `handleTool`'s outer catch, which produced this exact same
    // `err.message` string — converting here instead keeps the standalone
    // wire behavior identical while giving `runFlow` the `ActionOutcome`
    // shape it expects from every other perform* function.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `handlePing` through `handleSetPermission` — the extracted bodies of the
 * remaining standalone tool cases in `handleTool` below that never got the
 * `perform*` treatment above. Each takes exactly the locals its original
 * `case` block closed over (`tabId`, `state`, `msg`, the raw params `p`,
 * and/or the `str`/`optStr` readers) and returns the same wire-level
 * `tool.response` envelope the case used to build inline — pure code
 * motion, not a rewrite of tool behavior.
 */

async function handlePing(tabId: number, msg: ToolRequestMessage): Promise<ExtensionToServer> {
  const tab = await chrome.tabs.get(tabId);
  return {
    kind: 'tool.response',
    id: msg.id,
    ok: true,
    result: { title: tab.title ?? '', url: tab.url ?? '' },
  };
}

async function handleNavigate(
  tabId: number,
  msg: ToolRequestMessage,
  p: Record<string, unknown>,
  str: (key: string) => string,
): Promise<ExtensionToServer> {
  const url = str('url');
  const waitForLoadFlag = p.wait_for_load !== false;
  await cdp(tabId, 'Page.navigate', { url });
  if (waitForLoadFlag) await waitForLoad(tabId);
  const tab = await chrome.tabs.get(tabId);
  return {
    kind: 'tool.response',
    id: msg.id,
    ok: true,
    result: { url: tab.url ?? '', title: tab.title ?? '' },
  };
}

async function handleSnapshot(
  tabId: number,
  msg: ToolRequestMessage,
  p: Record<string, unknown>,
  optStr: (key: string) => string | undefined,
): Promise<ExtensionToServer> {
  const value = await evaluateInTab(
    tabId,
    buildSnapshotJs({
      within_selector: optStr('within_selector'),
      only_interactive: p.only_interactive === true,
      exclude: Array.isArray(p.exclude)
        ? p.exclude.filter((x): x is string => typeof x === 'string')
        : undefined,
      max_interactive: typeof p.max_interactive === 'number' ? p.max_interactive : undefined,
    }),
  );
  return { kind: 'tool.response', id: msg.id, ok: true, result: value };
}

async function handleCanvasScreenshot(
  tabId: number,
  msg: ToolRequestMessage,
  p: Record<string, unknown>,
  optStr: (key: string) => string | undefined,
): Promise<ExtensionToServer> {
  const selector = optStr('selector');
  const format = optStr('format') === 'jpeg' ? 'jpeg' : 'png';
  const regionRaw = p.region;
  let region: { x: number; y: number; w: number; h: number } | undefined;
  if (regionRaw && typeof regionRaw === 'object') {
    const r = regionRaw as Record<string, unknown>;
    if (
      typeof r.x === 'number' &&
      typeof r.y === 'number' &&
      typeof r.w === 'number' &&
      typeof r.h === 'number'
    ) {
      region = { x: r.x, y: r.y, w: r.w, h: r.h };
    }
  }
  const value = await evaluateInTab(tabId, buildCanvasScreenshotJs({ selector, region, format }));
  return { kind: 'tool.response', id: msg.id, ok: true, result: value };
}

function handleConsole(
  state: TabState,
  msg: ToolRequestMessage,
  optStr: (key: string) => string | undefined,
): ExtensionToServer {
  const level = optStr('level');
  const entries = level
    ? state.consoleBuffer.filter((e) => e.level === level)
    : state.consoleBuffer;
  return { kind: 'tool.response', id: msg.id, ok: true, result: entries };
}

function handleNetwork(
  state: TabState,
  msg: ToolRequestMessage,
  optStr: (key: string) => string | undefined,
): ExtensionToServer {
  const filter = optStr('url_filter')?.toLowerCase();
  const list = state.networkOrder
    .map((id) => state.networkBuffer.get(id))
    .filter((e): e is NetworkEntry => e !== undefined)
    .filter((e) => (filter ? e.url.toLowerCase().includes(filter) : true));
  return { kind: 'tool.response', id: msg.id, ok: true, result: list };
}

async function handleNetworkBody(
  tabId: number,
  msg: ToolRequestMessage,
  str: (key: string) => string,
): Promise<ExtensionToServer> {
  const requestId = str('request_id');
  const body = await cdp<CdpNetworkGetResponseBody>(tabId, 'Network.getResponseBody', {
    requestId,
  });
  return { kind: 'tool.response', id: msg.id, ok: true, result: body };
}

async function handleFlow(
  tabId: number,
  state: TabState,
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
  const flowResult = await runFlow(
    rawSteps as FlowStep[],
    {
      performFind: (params) => performFind(tabId, params),
      performClick: (params) => performClick(tabId, params),
      performType: (params) => performType(tabId, params),
      performPress: (params) => performPress(tabId, params),
      performWaitFor: (params) => performWaitFor(tabId, state, params),
      performDrag: (params) => performDrag(tabId, params),
      buildRecoverySnapshot: () =>
        evaluateInTab(tabId, buildSnapshotJs({ only_interactive: true, max_interactive: 40 })),
    },
    // Strict `=== true`: any other wire value (missing, "true", 1) runs
    // the flow FOR REAL. A dry run that silently became a real run would
    // be the worst possible failure of this flag, so only the exact
    // boolean opts into it.
    { dryRun: p.dry_run === true },
  );
  // The wire-level response is ok:true whenever the flow RAN (even a
  // failed step is a legitimate business outcome, same pattern as
  // wait_for's matched:false) — flowResult itself carries the
  // ok:true/false the agent reads.
  return { kind: 'tool.response', id: msg.id, ok: true, result: flowResult };
}

async function handleDrag(
  tabId: number,
  msg: ToolRequestMessage,
  p: Record<string, unknown>,
  optStr: (key: string) => string | undefined,
): Promise<ExtensionToServer> {
  // Thin wire wrapper over performDrag — the same pattern the standalone
  // click/type/press/wait_for cases use over their perform* functions.
  // Numbers pass through with a plain typeof check; performDrag applies
  // the full finite/non-negative guard and the duration/hold clamps.
  const optNum = (key: string): number | undefined => {
    const v = p[key];
    return typeof v === 'number' ? v : undefined;
  };
  const outcome = await performDrag(tabId, {
    from_selector: optStr('from_selector'),
    from_x: optNum('from_x'),
    from_y: optNum('from_y'),
    to_selector: optStr('to_selector'),
    to_x: optNum('to_x'),
    to_y: optNum('to_y'),
    duration_ms: optNum('duration_ms'),
    hold_before_move_ms: optNum('hold_before_move_ms'),
    hold_before_release_ms: optNum('hold_before_release_ms'),
  });
  if (!outcome.ok) {
    return { kind: 'tool.response', id: msg.id, ok: false, error: outcome.error };
  }
  return { kind: 'tool.response', id: msg.id, ok: true, result: outcome.result };
}

async function handleDialogRespond(
  tabId: number,
  msg: ToolRequestMessage,
  p: Record<string, unknown>,
  optStr: (key: string) => string | undefined,
): Promise<ExtensionToServer> {
  const accept = p.accept === true;
  const promptText = optStr('prompt_text');
  // No probing — if there is no dialog open, CDP returns an error.
  // We propagate it; the caller decides if "no dialog to respond to"
  // is a problem or a race they can ignore.
  const params: Record<string, unknown> = { accept };
  if (promptText !== undefined) params.promptText = promptText;
  await cdp(tabId, 'Page.handleJavaScriptDialog', params);
  return {
    kind: 'tool.response',
    id: msg.id,
    ok: true,
    result: { accepted: accept },
  };
}

async function handleSetPermission(
  msg: ToolRequestMessage,
  str: (key: string) => string,
): Promise<ExtensionToServer> {
  const origin = str('origin');
  const name = str('name');
  const state_ = str('state');
  // CDP `Browser.setPermission` requires a browser-level target,
  // which `chrome.debugger.attach({ tabId })` does NOT give us in
  // MV3. We use `chrome.contentSettings` instead — that surface IS
  // available to extensions and covers the realistic permissions
  // an agent needs to pre-set (geolocation, notifications, camera,
  // microphone, clipboard, sensors).
  const settingKey = CONTENT_SETTING_BY_PERMISSION[name];
  if (!settingKey) {
    return {
      kind: 'tool.response',
      id: msg.id,
      ok: false,
      error: `set_permission: '${name}' is not supported by chrome.contentSettings in MV3. Supported names: ${Object.keys(CONTENT_SETTING_BY_PERMISSION).join(', ')}.`,
    };
  }
  const setting = STATE_TO_CONTENT_SETTING[state_];
  if (!setting) {
    return {
      kind: 'tool.response',
      id: msg.id,
      ok: false,
      error: `set_permission: unknown state '${state_}' (expected granted | denied | prompt).`,
    };
  }
  // `chrome.contentSettings.<name>.set({ primaryPattern, setting })`
  // requires a URL pattern, not a bare origin. Append `/*` so the
  // pattern covers every path on the origin.
  const primaryPattern = origin.endsWith('/*') ? origin : `${origin}/*`;
  try {
    await applyContentSetting(settingKey, primaryPattern, setting);
  } catch (err) {
    return {
      kind: 'tool.response',
      id: msg.id,
      ok: false,
      error: `set_permission: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    kind: 'tool.response',
    id: msg.id,
    ok: true,
    result: { origin, name, state: state_, applied_as: settingKey },
  };
}

async function handleTool(state: TabState, msg: ToolRequestMessage): Promise<ExtensionToServer> {
  const tabId = state.tabId;
  // Params come over the wire as JSON: each field is unknown until we
  // narrow it. The local helpers below give one-line, type-safe reads
  // for the shapes we accept.
  const p = (msg.params ?? {}) as Record<string, unknown>;
  const str = (key: string): string => (typeof p[key] === 'string' ? p[key] : String(p[key]));
  const optStr = (key: string): string | undefined =>
    typeof p[key] === 'string' ? p[key] : undefined;
  try {
    switch (msg.tool) {
      case 'ping':
        return await handlePing(tabId, msg);

      case 'navigate':
        return await handleNavigate(tabId, msg, p, str);

      case 'snapshot':
        return await handleSnapshot(tabId, msg, p, optStr);

      case 'state': {
        const value = await evaluateInTab(tabId, buildStateJs());
        return { kind: 'tool.response', id: msg.id, ok: true, result: value };
      }

      case 'find': {
        const outcome = await performFind(tabId, {
          text: str('text'),
          role: optStr('role'),
          exact: p.exact === true,
        });
        if (!outcome.ok) {
          return { kind: 'tool.response', id: msg.id, ok: false, error: outcome.error };
        }
        return { kind: 'tool.response', id: msg.id, ok: true, result: outcome.result };
      }

      case 'canvas_screenshot':
        return await handleCanvasScreenshot(tabId, msg, p, optStr);

      case 'console':
        return handleConsole(state, msg, optStr);

      case 'network':
        return handleNetwork(state, msg, optStr);

      case 'network_body':
        return await handleNetworkBody(tabId, msg, str);

      case 'click': {
        const outcome = await performClick(tabId, {
          selector: str('selector'),
          force: p.force === true,
          settle_ms: typeof p.settle_ms === 'number' ? p.settle_ms : undefined,
          settle_timeout_ms:
            typeof p.settle_timeout_ms === 'number' ? p.settle_timeout_ms : undefined,
        });
        if (!outcome.ok) {
          return { kind: 'tool.response', id: msg.id, ok: false, error: outcome.error };
        }
        return { kind: 'tool.response', id: msg.id, ok: true, result: outcome.result };
      }

      case 'type': {
        const outcome = await performType(tabId, {
          selector: str('selector'),
          text: str('text'),
          clear: p.clear === true,
          settle_ms: typeof p.settle_ms === 'number' ? p.settle_ms : undefined,
          settle_timeout_ms:
            typeof p.settle_timeout_ms === 'number' ? p.settle_timeout_ms : undefined,
        });
        if (!outcome.ok) {
          return { kind: 'tool.response', id: msg.id, ok: false, error: outcome.error };
        }
        return { kind: 'tool.response', id: msg.id, ok: true, result: outcome.result };
      }

      case 'press': {
        const modifierNames = Array.isArray(p.modifiers)
          ? p.modifiers.filter((m): m is string => typeof m === 'string')
          : [];
        const outcome = await performPress(tabId, {
          key: optStr('key'),
          modifiers: modifierNames,
          selector: optStr('selector'),
          settle_ms: typeof p.settle_ms === 'number' ? p.settle_ms : undefined,
          settle_timeout_ms:
            typeof p.settle_timeout_ms === 'number' ? p.settle_timeout_ms : undefined,
        });
        if (!outcome.ok) {
          return { kind: 'tool.response', id: msg.id, ok: false, error: outcome.error };
        }
        return { kind: 'tool.response', id: msg.id, ok: true, result: outcome.result };
      }

      case 'flow':
        return await handleFlow(tabId, state, msg, p);

      case 'drag':
        return await handleDrag(tabId, msg, p, optStr);

      case 'evaluate': {
        const expression = str('expression');
        const value = await evaluateInTab(tabId, expression);
        return { kind: 'tool.response', id: msg.id, ok: true, result: value };
      }

      case 'wait_for': {
        const outcome = await performWaitFor(tabId, state, {
          selector: optStr('selector'),
          expression: optStr('expression'),
          network_url: optStr('network_url'),
          condition: optStr('condition'),
          timeout_ms: typeof p.timeout_ms === 'number' ? p.timeout_ms : undefined,
          poll_interval_ms: typeof p.poll_interval_ms === 'number' ? p.poll_interval_ms : undefined,
        });
        if (!outcome.ok) {
          return { kind: 'tool.response', id: msg.id, ok: false, error: outcome.error };
        }
        return { kind: 'tool.response', id: msg.id, ok: true, result: outcome.result };
      }

      case 'dialog_respond':
        return await handleDialogRespond(tabId, msg, p, optStr);

      case 'set_permission':
        return await handleSetPermission(msg, str);

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

async function cleanup(tabId: number): Promise<void> {
  const state = tabStates.get(tabId);
  if (!state) return;
  // Delete the tracking entry SYNCHRONOUSLY, before any await below: the
  // reconnect policy's CloseContext.tracked contract promises that every
  // extension-initiated teardown deletes state BEFORE the WS close event
  // dispatches. ws.close() further down fires that event on a later turn,
  // so deleting here keeps the promise — the close handler then sees an
  // untracked socket and never auto-reconnects a teardown the extension
  // itself initiated. The awaited steps below only need the captured
  // `state` and raw CDP calls, never the map entry — and deleting first
  // also makes a re-entrant cleanup a no-op instead of a double detach.
  tabStates.delete(tabId);
  // Recording never survives a disconnect — there is no server connection
  // left to save to, and leaving captured-but-unsaved steps around after
  // the tab drops its bridge would be a surprising place for them to
  // linger.
  removeRecordingNavListener(tabId);
  // `chrome.debugger.detach` below drops the CDP binding SUBSCRIPTION but
  // does NOT remove the plain `window.addEventListener` listeners the
  // recorder installed in the page — those would leak, staying attached to
  // a page the user is still browsing. Tear them down in-page FIRST, while
  // the debugger is still attached and `evaluateInTab` can reach the page.
  // Best-effort: the tab may already be gone (tab-removal path), in which
  // case there is nothing left to tear down anyway.
  if (state.recording) {
    await teardownRecorderInPage(tabId, state.recording.stopFn);
  }
  if (state.ws && state.ws.readyState !== WebSocket.CLOSED) {
    try {
      state.ws.close();
    } catch {
      // Best effort — the resource may already be detached/closed.
    }
  }
  if (state.debuggerAttached) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Best effort — the resource may already be detached/closed.
    }
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return;
  const state = tabStates.get(source.tabId);
  if (!state?.debuggerListener) return;
  state.debuggerListener(method, params);
});

/**
 * Look up the previous browser-link tab_id this Chrome tab had, if any.
 * Stored in chrome.storage.session (cleared when the browser restarts).
 * Used to ask the primary to keep the same tab_id across primary swaps
 * — a key piece of the v0.4 multi-agent UX so the agent does not see
 * stale tab_ids after a re-election.
 */
async function readPreviousTabId(chromeTabId: number): Promise<string | undefined> {
  const key = `prevTabId:${chromeTabId}`;
  try {
    const data = await chrome.storage.session.get(key);
    const v = data[key];
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

async function storeTabId(chromeTabId: number, serverTabId: string): Promise<void> {
  const key = `prevTabId:${chromeTabId}`;
  try {
    await chrome.storage.session.set({ [key]: serverTabId });
  } catch {
    /* storage failure is non-fatal — worst case the next reconnect gets a fresh id */
  }
}

async function forgetTabId(chromeTabId: number): Promise<void> {
  const key = `prevTabId:${chromeTabId}`;
  try {
    await chrome.storage.session.remove(key);
  } catch {
    /* ignore */
  }
}

/* Auto-reconnect after an involuntary WS close.
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
 * discarded rather than surprising the user minutes later. */
async function storeReconnectState(tabId: number, attempt: number): Promise<void> {
  try {
    await chrome.storage.session.set({
      [reconnectStorageKey(tabId)]: { attempt, updatedAt: Date.now() },
    });
  } catch {
    /* non-fatal — worst case a killed service worker cannot resume this retry */
  }
}

async function clearReconnectState(tabId: number): Promise<void> {
  try {
    await chrome.storage.session.remove(reconnectStorageKey(tabId));
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
    const existing = tabStates.get(tabId);
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
    if (state) void storeReconnectState(tabId, state.attempt);
    else void clearReconnectState(tabId);
  },
});

/** Resume reconnect cycles a killed service worker left behind. Runs once
 * per worker start (top-level call below) — `chrome.storage.session`
 * survives worker restarts but not browser restarts, which is exactly the
 * lifetime the retry budget should have. */
async function resumePendingReconnects(): Promise<void> {
  let stored: Record<string, unknown>;
  try {
    stored = await chrome.storage.session.get(null);
  } catch {
    return;
  }
  const now = Date.now();
  for (const [key, value] of Object.entries(stored)) {
    const tabId = tabIdFromReconnectKey(key);
    if (tabId === null) continue;
    const state = parseStoredReconnectState(value);
    if (state && isReconnectStateFresh(state.updatedAt, now) && !tabStates.has(tabId)) {
      reconnectScheduler.schedule(tabId, state.attempt);
    } else {
      void clearReconnectState(tabId);
    }
  }
}

void resumePendingReconnects();

/** Tabs with a `connectTab` currently in flight. The `tabStates.has` check
 * inside `doConnectTab` alone cannot prevent two concurrent connects — the
 * state lands only after three awaited chrome.* calls — so this SYNCHRONOUS
 * check-and-set is the real per-tab reentrancy guard. */
const connectsInFlight = new Set<number>();

async function connectTab(tabId: number): Promise<ConnectResult> {
  if (connectsInFlight.has(tabId)) {
    // A concurrent connect (popup Connect racing a scheduled reconnect
    // attempt, or vice versa) — the in-flight attempt owns the tab.
    // Answer benignly instead of letting a second attempt fail its
    // debugger attach with a confusing error; the popup renders this
    // exact message as the "Reconnecting" card, not an error.
    return { ok: false, error: CONNECT_IN_PROGRESS_ERROR };
  }
  connectsInFlight.add(tabId);
  try {
    return await doConnectTab(tabId);
  } finally {
    connectsInFlight.delete(tabId);
  }
}

/** Body of `connectTab` — call only through the wrapper above, which holds
 * the per-tab in-flight lock for the full duration of the attempt. */
async function doConnectTab(tabId: number): Promise<ConnectResult> {
  if (tabStates.has(tabId)) {
    return { ok: false, error: 'This tab is already connected' };
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !tab.title) {
    return { ok: false, error: 'Tab has no URL or title' };
  }

  const previousTabId = await readPreviousTabId(tabId);

  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (err) {
    return {
      ok: false,
      error: `Could not attach debugger: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const state: TabState = {
    tabId,
    debuggerAttached: true,
    consoleBuffer: [],
    networkBuffer: new Map(),
    networkOrder: [],
    lastActivityAt: Date.now(),
  };
  tabStates.set(tabId, state);
  attachDebuggerListener(state);

  try {
    await cdp(tabId, 'Page.enable');
    await cdp(tabId, 'Runtime.enable');
    await cdp(tabId, 'Log.enable');
    await cdp(tabId, 'Network.enable');
    await cdp(tabId, 'DOM.enable');
  } catch (err) {
    await cleanup(tabId);
    return {
      ok: false,
      error: `Could not enable CDP: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

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
        payload: { url: registerUrl, title: registerTitle, previousTabId },
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
            // connected manually (resumePendingReconnects's tabStates
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
            // Remember this id so the next reconnect (after a primary swap)
            // asks the new primary to honour it. The primary emits
            // `tab-renamed` in the bridge event log if it can't.
            void storeTabId(tabId, msg.payload.tabId);
            settle({ ok: true, serverTabId: msg.payload.tabId });
            return;
          }
          case 'settings.update': {
            // Housekeeping, not agent activity — deliberately does NOT touch
            // state.lastActivityAt. Counting a server-pushed settings sync as
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
            // Touch the activity timestamp so the WS-idle sweeper keeps
            // this tab warm.
            state.lastActivityAt = Date.now();
            const response = await handleTool(state, msg);
            if (ws.readyState === WebSocket.OPEN) send(ws, response);
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
    // lives in the close handler alone — this one only settles a
    // pre-registration connect failure with the friendlier diagnosis (for
    // a post-registration drop `settle` is already spent and this no-ops).
    ws.addEventListener('error', () => {
      settle({ ok: false, error: 'WebSocket connection failed. Is the MCP server running?' });
    });

    ws.addEventListener('close', (ev: CloseEvent) => {
      const current = tabStates.get(tabId);
      if (current !== undefined && current.ws !== ws) {
        // A newer connection already owns this tab — this close belongs to
        // a superseded socket, and tearing state down here would kill the
        // NEW bridge rather than the one that just died.
        settle({ ok: false, error: 'WebSocket closed before registration' });
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
      settle({ ok: false, error: 'WebSocket closed before registration' });
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
  const state = tabStates.get(tabId);
  if (!state) {
    // Keep the popup truthful while auto-reconnect is working: "not
    // connected, but actively retrying" rather than a flat idle state.
    // `connectsInFlight` covers the short gap inside a live attempt
    // before its TabState lands — without it the popup's poll could
    // misread that gap as idle and freeze the card there.
    if (reconnectScheduler.isPending(tabId) || connectsInFlight.has(tabId)) {
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
function getVersionCheck(): {
  extension: string;
  server: string | null;
  aligned: boolean | null;
} {
  const extension = chrome.runtime.getManifest().version;
  let server: string | null = null;
  for (const s of tabStates.values()) {
    if (typeof s.serverVersion === 'string' && s.serverVersion.length > 0) {
      server = s.serverVersion;
      break;
    }
  }
  return {
    extension,
    server,
    aligned: server === null ? null : server === extension,
  };
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
// `waitForLoad` already uses elsewhere in this file for the standalone
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
  await evaluateInTab(
    tabId,
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
    await evaluateInTab(tabId, buildStopRecorderJs(stopFn));
  } catch {
    // Tab closed/navigated/detached mid-teardown — nothing left to tear down.
  }
}

async function handleRecordingNavigation(tabId: number, newUrl: string): Promise<void> {
  const state = tabStates.get(tabId);
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
    return { ok: false, error: 'Flow recording is disabled. Enable it in settings first.' };
  }
  const state = tabStates.get(tabId);
  if (!state) return { ok: false, error: 'This tab is not connected.' };
  if (state.recording) {
    return { ok: false, error: 'A recording is already in progress (or awaiting review).' };
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: 'Tab no longer exists.' };
  }

  // Fresh per-session identity: randomized binding name (no stable global
  // for a page to probe) + nonce (the shared secret authenticating every
  // payload). Rotated on EVERY recording start — see recorder.ts's THREAT
  // MODEL doc.
  const session = generateRecordingSession();
  try {
    await cdp(tabId, 'Runtime.addBinding', { name: session.bindingName });
  } catch (err) {
    return {
      ok: false,
      error: `Could not start recording: ${err instanceof Error ? err.message : String(err)}`,
    };
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
    return {
      ok: false,
      error: `Could not start recording: ${err instanceof Error ? err.message : String(err)}`,
    };
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
  const state = tabStates.get(tabId);
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
  const state = tabStates.get(tabId);
  if (!state?.recording || state.recording.status !== 'recording') {
    return { ok: false, error: 'Not currently recording this tab.' };
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
 * See `DISCARDED_WHILE_SAVING_MESSAGE`'s doc for the honest limitation:
 * this cannot retract a `flow.recorded` request the server already
 * received and persisted before this ran. */
function clearRecording(tabId: number): void {
  removeRecordingNavListener(tabId);
  const state = tabStates.get(tabId);
  if (!state) return;
  state.recording = undefined;
  const pending = state.pendingFlowSave;
  if (pending) {
    state.pendingFlowSave = undefined;
    pending({ ok: false, error: DISCARDED_WHILE_SAVING_MESSAGE });
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
  const state = tabStates.get(tabId);
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
  const recording = tabStates.get(tabId)?.recording;
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
  const state = tabStates.get(tabId);
  const recording = state?.recording;
  if (!state || !recording || recording.status !== 'reviewing') {
    return { ok: false, error: 'No reviewed recording to save for this tab.' };
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.serverTabId) {
    return { ok: false, error: 'Not connected to the server.' };
  }
  const trimmedName = name.trim();
  if (trimmedName.length === 0) return { ok: false, error: 'Name is required.' };
  if (recording.steps.length === 0) return { ok: false, error: 'No steps were captured.' };

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
      settle({ ok: false, error: 'Timed out waiting for the server.' });
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
    const state = tabStates.get(msg.tabId);
    sendResponse({ pending: state?.pendingDialog ?? null });
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
  const openerState = tabStates.get(openerTabId);
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
      const newState = tabStates.get(newTabId);
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
  const state = tabStates.get(source.tabId);
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
 * bring it back.
 *
 * When the user picked "Never" (idleTtlMinutesCache === 0),
 * `shouldScheduleIdleSweep` short-circuits the tick before it walks
 * `tabStates` — the interval itself keeps ticking (cancelling/rearming a
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
  for (const [tabId, state] of tabStates) {
    if (!shouldDisconnectForIdle(state.lastActivityAt, now, idleTtlMinutesCache)) continue;
    void cleanup(tabId).catch(() => {
      // Best effort.
    });
  }
}, WS_IDLE_SWEEP_MS);
