// The extension's link for one connected tab (design section 4,
// `TabConnection`): the WebSocket, the server metadata learnt at handshake,
// the debugger and recording fields, and the tab's core `TabSession`. It
// holds a `TabSession`, never the other way round. Also here: the tab's
// debugger intake (console, network and dialog events into the session,
// dialog bridge events, recorder binding calls), the fan-out of the
// permanent `chrome.debugger.onEvent` listener, and the tab's teardown.
// No `chrome`: `background.ts` passes in what talks to Chrome.

import type { ExtensionToServer } from '@browser-link/shared';
import {
  OBSERVER_BINDING,
  type Clock,
  type FlowStep,
  type PendingDialogInfo,
  type TabRegistry,
  type TabReservation,
  type TabSession,
} from '@browser-link/core';
import { normalizeConsoleLevel } from '../console-level.js';
import { appendRecordingStep, parseRecordedPayload, toFlowStep } from '../recording.js';
import { workerFailure } from '../worker-messages.js';

export type TabEventListener = (method: string, params: unknown) => void;

/** `readyState` of an open socket and of a closed one (the WebSocket API's
 * `OPEN` and `CLOSED`). */
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSED = 3;

/**
 * The tab's link to the bridge: the members of the WebSocket API the
 * extension uses (`adapters/web-socket.ts` opens a real one), so the
 * connection code runs in tests on a fake socket.
 */
export interface BridgeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { wasClean: boolean }) => void): void;
}

/**
 * State for one tab's demonstration recording, see `app/recording.ts` for the
 * full lifecycle (`start` -> navigation steps* -> `stop` -> `save` | `discard`).
 */
export interface RecordingState {
  /** 'recording': the in-page recorder is installed and capturing.
   * 'reviewing': recording stopped, steps are held here for the popup's
   * review panel, awaiting Save or Discard. */
  status: 'recording' | 'reviewing';
  steps: FlowStep[];
  /** The tab's URL the last time recording state observed it — the
   * baseline the recording's navigation step diffs `tabs.onUpdated`
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

export interface TabConnection {
  readonly tabId: number;
  /** The tab's page state: idle clock, call hold, buffers, pending dialog,
   * page driver (core `session/tab-session.ts`). */
  readonly session: TabSession;
  serverTabId?: string;
  /** Version of the MCP server that registered this tab — set from the
   * `tab.registered` payload. Compared against the extension's own
   * `chrome.runtime.getManifest().version` so the popup can warn the user
   * when one half was upgraded and the other wasn't. */
  serverVersion?: string;
  /** Package version installed on disk when this tab registered
   * (`tab.registered.installedVersion`, servers from 0.41.0). Newer than
   * `serverVersion` means the server keeps running stale code. */
  installedVersion?: string;
  /** Pid of the server that registered this tab (servers from 0.41.0). */
  serverPid?: number;
  ws?: BridgeSocket;
  debuggerAttached: boolean;
  /** The tab's debugger intake (`debuggerIntake`). */
  debuggerListener?: TabEventListener;
  /** Present from `Recording.start` through save/discard. `undefined` means
   * "not recording and nothing to review" — the common case, and what
   * every tab starts as regardless of the flow-recording setting. */
  recording?: RecordingState;
  /** Single in-flight `flow.recorded` save, resolved by the matching
   * `flow.recorded.result` WS message (see the `connectTab` message
   * switch). The popup disables Save while this is set, so at most one is
   * ever outstanding — same single-slot pattern the IPC bridge's
   * `settings.push` uses. */
  pendingFlowSave?: (result: { ok: true } | { ok: false; error: string }) => void;
  /** Listeners of this tab's CDP events other than `debuggerListener`
   * (the page driver's observer binding), fed by the permanent
   * `chrome.debugger.onEvent` listener. */
  readonly eventListeners: Set<TabEventListener>;
}

export function newTabConnection(
  tabId: number,
  session: TabSession,
  eventListeners: Set<TabEventListener>,
): TabConnection {
  return { tabId, session, debuggerAttached: true, eventListeners };
}

export function send(ws: BridgeSocket, msg: ExtensionToServer): void {
  ws.send(JSON.stringify(msg));
}

/** The tab's socket when it is open and the tab is registered. */
export function registeredSocket(
  conn: TabConnection,
): { ws: BridgeSocket; serverTabId: string } | undefined {
  if (conn.ws && conn.ws.readyState === SOCKET_OPEN && conn.serverTabId)
    return { ws: conn.ws, serverTabId: conn.serverTabId };
  return undefined;
}

/** Send a `bridge.event` for the tab when it is registered and its socket is open. */
export function sendBridgeEvent(
  conn: TabConnection,
  eventKind: string,
  data: Record<string, unknown>,
): void {
  const open = registeredSocket(conn);
  if (open) send(open.ws, { kind: 'bridge.event', eventKind, tabId: open.serverTabId, data });
}

/** Feed one CDP event of the tab to its intake and its other listeners. */
export function deliverCdpEvent(
  conn: TabConnection | undefined,
  method: string,
  params: unknown,
): void {
  if (!conn) return;
  conn.debuggerListener?.(method, params);
  for (const listener of conn.eventListeners) listener(method, params);
}

// === CDP types — only the fields the intake reads ======================

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

// Convert an arbitrary console arg (`unknown`) into something printable
// without leaking `[object Object]`. Used by the console buffer when CDP
// hands us values we don't statically know.
export function stringifyConsoleArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}

export interface DebuggerIntakeDeps {
  clock: Clock;
  /** The recording reached its step cap: stop it (`Recording.finish`). */
  onRecordingCapped(tabId: number): void;
}

/** The tab's debugger intake: console, network and dialog events into its
 * `TabSession`, dialog bridge events, and the recorder's binding calls. */
export function debuggerIntake(conn: TabConnection, deps: DebuggerIntakeDeps): TabEventListener {
  const { session } = conn;
  return (method, params) => {
    if (method === 'Runtime.consoleAPICalled') {
      const p = params as CdpRuntimeConsoleAPICalled;
      const args = p.args ?? [];
      const text = args
        .map((a) => (a.value !== undefined ? stringifyConsoleArg(a.value) : (a.description ?? '')))
        .join(' ');
      session.pushConsole({
        timestamp: p.timestamp ?? deps.clock.now(),
        level: normalizeConsoleLevel(p.type),
        text,
        source: 'console',
      });
      return;
    }
    if (method === 'Log.entryAdded') {
      const p = params as CdpLogEntryAdded;
      const e = p.entry ?? {};
      session.pushConsole({
        timestamp: e.timestamp ?? deps.clock.now(),
        level: normalizeConsoleLevel(e.level),
        text: e.text ?? '',
        source: 'log',
        url: e.url,
        line: e.lineNumber,
      });
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      const p = params as CdpNetworkRequestWillBeSent;
      const entry = session.networkEntry(p.requestId);
      entry.url = p.request?.url ?? entry.url;
      entry.method = p.request?.method ?? entry.method;
      entry.resource_type = p.type ?? entry.resource_type;
      entry.request_headers = p.request?.headers ?? entry.request_headers;
      entry.request_post_data = p.request?.postData ?? entry.request_post_data;
      return;
    }
    if (method === 'Network.responseReceived') {
      const p = params as CdpNetworkResponseReceived;
      const entry = session.networkEntry(p.requestId);
      entry.status = p.response?.status;
      entry.status_text = p.response?.statusText;
      entry.mime_type = p.response?.mimeType;
      entry.response_headers = p.response?.headers;
      return;
    }
    if (method === 'Network.loadingFinished') {
      const p = params as CdpNetworkLoadingFinished;
      const entry = session.networkEntry(p.requestId);
      entry.finished_at = deps.clock.now();
      entry.encoded_data_length = p.encodedDataLength;
      return;
    }
    if (method === 'Network.loadingFailed') {
      const p = params as CdpNetworkLoadingFailed;
      const entry = session.networkEntry(p.requestId);
      entry.finished_at = deps.clock.now();
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
      session.dialogOpened(info);
      const data: Record<string, unknown> = {
        type: info.type,
        message: info.message,
      };
      if (info.default_prompt !== undefined) data.default_prompt = info.default_prompt;
      if (info.url !== undefined) data.url = info.url;
      sendBridgeEvent(conn, 'dialog-opening', data);
      return;
    }
    if (method === 'Page.javascriptDialogClosed') {
      const p = params as CdpPageJavascriptDialogClosed;
      session.dialogClosed();
      const data: Record<string, unknown> = { accept: p.result === true };
      if (typeof p.userInput === 'string') data.user_input = p.userInput;
      sendBridgeEvent(conn, 'dialog-closed', data);
      return;
    }
    if (
      method === 'Runtime.bindingCalled' &&
      (params as { name?: string }).name === OBSERVER_BINDING
    ) {
      // The page driver's own subscription handles it (core's session/page-driver.ts).
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
      const recording = conn.recording;
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
        deps.onRecordingCapped(conn.tabId);
      }
      return;
    }
  };
}

export interface TeardownDeps {
  /** Cancel every flow running on the tab. */
  cancelFlows(tabId: number): void;
  /** Remove the tab's recording navigation listener. */
  removeRecordingNavListener(tabId: number): void;
  /** Remove the recorder's in-page listeners (best effort, never throws). */
  teardownRecorder(tabId: number, stopFn: string): Promise<void>;
  /** Detach the debugger from the tab. */
  detachDebugger(tabId: number): Promise<void>;
}

/** Tear down the tab's connection: no-op without one. */
export async function closeTabConnection(
  tabs: TabRegistry<TabConnection>,
  tabId: number,
  deps: TeardownDeps,
): Promise<void> {
  const conn = tabs.get(tabId);
  if (!conn) return;
  // Remove the tracking entry SYNCHRONOUSLY, before any await below: the
  // reconnect policy's CloseContext.tracked contract promises that every
  // extension-initiated teardown deletes state BEFORE the WS close event
  // dispatches. ws.close() further down fires that event on a later turn,
  // so deleting here keeps the promise — the close handler then sees an
  // untracked socket and never auto-reconnects a teardown the extension
  // itself initiated. The awaited steps below only need the captured
  // connection and raw CDP calls, never the registry entry — and removing
  // first also makes a re-entrant teardown a no-op instead of a double detach.
  tabs.remove(tabId);
  // A flow cannot outlive its bridge: the debugger is about to detach, so
  // every remaining step would fail one by one anyway. Cancelling instead
  // makes the flow stop AT ONCE and report what it completed — and, just
  // as importantly, keeps the popup from offering a Stop button for a flow
  // whose tab is already being torn down.
  deps.cancelFlows(tabId);
  // Recording never survives a disconnect — there is no server connection
  // left to save to, and leaving captured-but-unsaved steps around after
  // the tab drops its bridge would be a surprising place for them to
  // linger.
  deps.removeRecordingNavListener(tabId);
  // Detaching the debugger drops the CDP binding SUBSCRIPTION but does NOT
  // remove the plain `window.addEventListener` listeners the recorder
  // installed in the page — those would leak, staying attached to a page
  // the user is still browsing. Tear them down in-page FIRST, while the
  // debugger is still attached and the page driver can reach the page.
  // Best-effort: the tab may already be gone (tab-removal path), in which
  // case there is nothing left to tear down anyway.
  if (conn.recording) {
    await deps.teardownRecorder(tabId, conn.recording.stopFn);
  }
  if (conn.ws && conn.ws.readyState !== SOCKET_CLOSED) {
    try {
      conn.ws.close();
    } catch {
      // Best effort — the resource may already be detached/closed.
    }
  }
  if (conn.debuggerAttached) {
    await conn.session.driver.uninstall(() => true);
    try {
      await deps.detachDebugger(tabId);
    } catch {
      // Best effort — the resource may already be detached/closed.
    }
  }
}

/**
 * Make `conn` the tab's live connection right after the debugger attached.
 * Returns `null` when it is live (synchronously: nothing may run between the
 * commit and the intake being wired). `commit` cannot throw today (the
 * reservation and the `has` check exclude it), but when it does no registry
 * entry exists for `closeTabConnection` to tear down, so the attached
 * debugger is released here and the failure answered like an attach failure.
 */
export function commitConnection(
  tabs: TabRegistry<TabConnection>,
  reservation: TabReservation,
  conn: TabConnection,
  detachDebugger: (tabId: number) => Promise<void>,
): Promise<ReturnType<typeof workerFailure>> | null {
  try {
    tabs.commit(reservation, conn);
    return null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return Promise.resolve()
      .then(() => detachDebugger(reservation.tabId))
      .catch(() => undefined)
      .then(() => workerFailure({ code: 'debugger-attach-failed', values: { detail } }));
  }
}
