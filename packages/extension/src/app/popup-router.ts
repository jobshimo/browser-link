// The popup's, Activity's and Admin's runtime messages to the worker (design
// 6.1, slice 21): which messages are accepted, and which handler answers each.
// No `chrome`: `background.ts` subscribes the `Runtime` adapter
// (`adapters/chrome-runtime.ts`) at top level and hands it the router.

import type {
  Clock,
  FlowHistory,
  FlowHistoryEntry,
  FlowRegistry,
  RunningFlowView,
  TabRegistry,
} from '@browser-link/core';
import type { ReconnectScheduler } from '../reconnect-policy.js';
import type { RepairOutcome } from '../repair-policy.js';
import type { VersionCheck } from '../version-status.js';
import type { ActivityAdmin } from './activity-admin.js';
import { disconnectTab, tabStatus, type ConnectResult, type TabIds } from './connection.js';
import type { Recording } from './recording.js';
import type { TabConnection } from './tab-connection.js';

/** Answers a runtime message; the answer reaches the page that sent it. */
export type MessageReply = (answer: unknown) => void;

/** The extension runtime (`adapters/chrome-runtime.ts`). */
export interface Runtime {
  /** The version the manifest declares. */
  manifestVersion(): string;
  /** The extension's URL of a page it ships, for example `activity.html`. */
  pageUrl(path: string): string;
  /** Called with every runtime message an extension page sends. The listener
   * returns true when it will `reply` later, false when it replied already
   * or will not. A wake listener: subscribed only at the top level of
   * `background.ts` (R1). */
  onMessage(listener: (message: unknown, reply: MessageReply) => boolean): void;
}

// Runtime messages between popup.ts (and the Activity and Admin pages) and
// the worker.
export type RuntimeMessage =
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

export function isRuntimeMessage(msg: unknown): msg is RuntimeMessage {
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

export interface PopupRouterDeps {
  tabs: TabRegistry<TabConnection>;
  scheduler: ReconnectScheduler;
  tabIds: TabIds;
  clock: Clock;
  connect(tabId: number): Promise<ConnectResult>;
  /** Tear the tab's connection down (`closeTabConnection`). */
  cleanup(tabId: number): Promise<void>;
  /** Send one CDP command on the tab's debugger session. */
  cdp(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown>;
  versionCheck(): VersionCheck;
  repairConnection(): Promise<RepairOutcome>;
  openActivityWindow(): Promise<{ ok: true; windowId: number }>;
  openAdminWindow(): Promise<{ ok: true; windowId: number }>;
  activityAdmin: ActivityAdmin;
  recording: Recording;
  flows: Pick<FlowRegistry, 'listRunning' | 'cancel'>;
  history: Pick<FlowHistory, 'entries'>;
}

/** The router `Runtime.onMessage` calls: false for a message it does not
 * know, so another listener may answer it. */
export type PopupRouter = (message: unknown, reply: MessageReply) => boolean;

/** Stateless: everything it reads lives in what it is given. */
export function createPopupRouter(deps: PopupRouterDeps): PopupRouter {
  const { recording, activityAdmin } = deps;

  /** Answer the popup's Flows panel: everything running (across ALL tabs —
   * the Stop button has to reach a flow on a tab the user is not looking at)
   * plus the completed history of the ONE tab the popup is showing. */
  async function flowsStatus(
    tabId: number,
  ): Promise<{ running: RunningFlowView[]; history: FlowHistoryEntry[] }> {
    const running = deps.flows.listRunning(deps.clock.now());
    // Session storage unavailable: the running half rather than no panel.
    return { running, history: await deps.history.entries(tabId) };
  }

  async function respondToDialog(
    tabId: number,
    accept: boolean,
    promptText: string | undefined,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const params: Record<string, unknown> = { accept };
      if (promptText !== undefined) params.promptText = promptText;
      await deps.cdp(tabId, 'Page.handleJavaScriptDialog', params);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return (msg, sendResponse) => {
    if (!isRuntimeMessage(msg)) return false;
    if (msg.action === 'connect') {
      // An explicit Connect cancels any FUTURE auto-reconnect retries for
      // this tab. If a scheduled attempt is already mid-flight (cancel
      // cannot abort it), connectTab's per-tab in-flight lock turns this
      // call into a benign "already in progress" result instead of a
      // second concurrent connect.
      deps.scheduler.cancel(msg.tabId);
      void deps.connect(msg.tabId).then(sendResponse);
      return true;
    }
    if (msg.action === 'disconnect') {
      void disconnectTab(msg.tabId, deps).then(sendResponse);
      return true;
    }
    if (msg.action === 'pendingDialog') {
      const state = deps.tabs.get(msg.tabId);
      sendResponse({ pending: state?.session.pendingDialog ?? null });
      return false;
    }
    if (msg.action === 'respondDialog') {
      void respondToDialog(msg.tabId, msg.accept, msg.promptText).then(sendResponse);
      return true;
    }
    if (msg.action === 'versionCheck') {
      sendResponse(deps.versionCheck());
      return false;
    }
    if (msg.action === 'repairConnection') {
      void deps.repairConnection().then(sendResponse, (err: unknown) => {
        sendResponse({ ok: false, message: err instanceof Error ? err.message : String(err) });
      });
      return true;
    }
    if (msg.action === 'openActivityWindow') {
      void deps.openActivityWindow().then(sendResponse);
      return true;
    }
    if (msg.action === 'openAdminWindow') {
      void deps.openAdminWindow().then(sendResponse);
      return true;
    }
    if (msg.action === 'activityQuery') {
      void activityAdmin.queryActivity(msg.query ?? {}).then(sendResponse);
      return true;
    }
    if (msg.action === 'activityPurge') {
      void activityAdmin.purgeActivity(msg).then(sendResponse);
      return true;
    }
    if (msg.action === 'adminDescribe') {
      void activityAdmin.adminDescribe(msg.language).then(sendResponse);
      return true;
    }
    if (msg.action === 'adminAction') {
      void activityAdmin.adminAction(msg).then(sendResponse);
      return true;
    }
    if (msg.action === 'recordingStatus') {
      sendResponse(recording.status(msg.tabId));
      return false;
    }
    if (msg.action === 'startRecording') {
      void recording.start(msg.tabId).then(sendResponse);
      return true;
    }
    if (msg.action === 'stopRecording') {
      void recording.stop(msg.tabId).then(sendResponse);
      return true;
    }
    if (msg.action === 'discardRecording') {
      void recording.discard(msg.tabId).then(sendResponse);
      return true;
    }
    if (msg.action === 'saveRecording') {
      void recording.save(msg.tabId, msg.name, msg.description).then(sendResponse);
      return true;
    }
    if (msg.action === 'flowsStatus') {
      void flowsStatus(msg.tabId).then(sendResponse);
      return true;
    }
    if (msg.action === 'cancelFlow') {
      // Synchronous and unconditional: one boolean flip, then the runner
      // stops at its next check. `cancelled` reports whether THIS call is
      // what stopped it, so the popup can distinguish "stopping…" from an
      // id that had already finished — never an error either way.
      sendResponse({ cancelled: deps.flows.cancel(msg.flowId) });
      return false;
    }
    // 'status'
    sendResponse(tabStatus(deps.tabs, deps.scheduler, msg.tabId));
    return false;
  };
}
