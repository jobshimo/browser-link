export { NOTICE, type NoticeText } from './notice.js';

/** The loopback port of the server's WS bridge (127.0.0.1). The server
 * (`bridge/protocol.ts`) and the extension (`background.ts`) keep copies
 * because neither can import this package at runtime; the server's
 * `config.drift.test.ts` fails when a copy drifts. */
export const BRIDGE_PORT = 17529;

// <wire-protocol> verbatim in packages/server/src/messages.ts — guarded by
// packages/server/src/config.drift.test.ts. Edit here, then copy the section.
export type TabId = string;

export interface TabRegisterPayload {
  url: string;
  title: string;
  /**
   * Optional. The browser-link tab_id this Chrome tab had on its last
   * registration with a primary, remembered via chrome.storage.session.
   * Set on reconnect (e.g. after a primary swap) so the primary can
   * reuse the same id when free. When the id is taken the primary
   * assigns a new one and emits a `tab-renamed` event the agent can
   * pick up via the `browser.events` MCP tool.
   */
  previousTabId?: TabId;
  /**
   * Optional. The extension's own version (`chrome.runtime.getManifest().version`),
   * so the server can tell the agent when the extension is older than the
   * server (`extension_outdated` on `browser.list_tabs`). Absent from
   * extensions older than 0.39.0.
   */
  extensionVersion?: string;
}

export interface TabRegisteredPayload {
  tabId: TabId;
  /**
   * Version of the MCP server that just handed out this tabId. Compared
   * against `chrome.runtime.getManifest().version` so the popup can warn
   * the user when the two sides have drifted after an `npm install -g`
   * without re-loading the Chrome extension.
   */
  serverVersion?: string;
  /**
   * Version of the browser-link package installed on disk right now, re-read
   * by the server on every registration. Differs from `serverVersion` when
   * the package was updated while this server kept running old code. Absent
   * from servers older than 0.41.0.
   */
  installedVersion?: string;
  /** Process id of the server that registered this tab. Absent from servers
   * older than 0.41.0. */
  serverPid?: number;
}

export interface TabRegisterMessage {
  kind: 'tab.register';
  payload: TabRegisterPayload;
}

export interface TabRegisteredMessage {
  kind: 'tab.registered';
  payload: TabRegisteredPayload;
}

export interface ToolRequestMessage {
  kind: 'tool.request';
  id: string;
  tool: string;
  params: unknown;
}

/** `sensitive_field` on an error: a `type` / `press` failed after its executor
 * found the focused field sensitive, so the trail stores a marker instead of
 * the input. Absent from older extensions (the row is then stored as before). */
export type ToolResponseMessage =
  | { kind: 'tool.response'; id: string; ok: true; result: unknown }
  | { kind: 'tool.response'; id: string; ok: false; error: string; sensitive_field?: boolean };

/**
 * Ask the extension to stop a running `browser.flow` by its `flow_id` (the
 * opaque id the server mints per flow call and returns in the flow result).
 *
 * NOT correlated to a `tool.request` id on purpose: the flow being
 * cancelled is still parked in its own `tool.request`, and this frame has
 * to overtake it on the same socket. The cancelled flow answers through
 * its ORIGINAL `tool.response`, cleanly, with `stopped_by: 'cancelled'`
 * and whatever it managed to complete — so there is nothing for a second
 * correlated reply to carry.
 *
 * Cancelling an unknown or already-finished `flow_id` is a deliberate
 * no-op, not an error: the popup, an agent and the flow's own completion
 * race by nature, and "it already stopped" is the outcome the caller
 * wanted either way.
 *
 * Two live senders, and only one of them uses this frame. The extension's
 * own popup cancels in-process through `chrome.runtime.onMessage`, never
 * over this socket. `browser.flow_cancel` (v0.27.0) is the SERVER-side
 * one, and the reason this message shipped a release early: it reaches the
 * same in-flight registry with no protocol change, and the reply an agent
 * gets comes from the `flow_status` call the dispatcher makes straight
 * after — which is also how it reports the up-to-one-step gap honestly
 * (`cancelling: true`) instead of claiming a stop it cannot have observed
 * yet.
 */
export interface ToolCancelMessage {
  kind: 'tool.cancel';
  flow_id: string;
  /** `expired` when the SERVER gives up on a flow that outlived its bridge
   * timeout (a time-out, not a human stop). Absent for a plain cancel. */
  reason?: 'expired';
}

/**
 * Server-pushed settings. Two independent settings share this one message
 * kind — the idle-disconnect TTL and the opt-in flow-recording toggle —
 * each editable from the extension's own popup too, so both need a
 * precedence rule for "who wins" when they disagree:
 *
 * `updatedAt` / `flowRecordingUpdatedAt` is the epoch-ms timestamp of when
 * THAT value was written on the server side (via `browser-link config set
 * idle-ttl` / `config set flow-recording`). The extension compares it
 * against the timestamp it stamped on its own last LOCAL write (from the
 * popup) and only applies the incoming value when it is newer — see
 * `idle-policy.ts`'s `shouldAcceptIncomingSettings`, reused by
 * `flow-recording-policy.ts` for the second setting. Comparing raw
 * wall-clock timestamps across processes is safe here specifically
 * because the server and the browser always run on the same machine
 * (loopback-only bridge) and therefore share one clock — this would NOT
 * be a safe pattern for a distributed, multi-host system.
 *
 * Every field is optional because a single `settings.update` message may
 * carry only the idle-TTL pair, only the flow-recording pair, or both —
 * the extension applies each pair independently (see `background.ts`'s
 * `settings.update` case). Omitted entirely by whichever side has never
 * touched that particular setting via the CLI.
 */
export interface SettingsUpdatePayload {
  idleTtlMinutes?: number;
  updatedAt?: number;
  /** Opt-in flow-recording toggle — see `browser-link config get/set
   * flow-recording` and the popup's "Enable flow recording" control. */
  flowRecordingEnabled?: boolean;
  flowRecordingUpdatedAt?: number;
}

export interface SettingsUpdateMessage {
  kind: 'settings.update';
  settings: SettingsUpdatePayload;
}

/**
 * Out-of-band notification from the extension to the server's BridgeEventLog.
 * Used for native dialog open/close, tab-created by window.open, etc.
 * `tabId` is the server-assigned browser-link id (set after tab.registered).
 */
export interface BridgeEventMessage {
  kind: 'bridge.event';
  eventKind: string;
  tabId?: TabId;
  data: Record<string, unknown>;
}

/**
 * A flow recorded by demonstration (see `background.ts`'s `saveRecording`
 * and `inpage/recorder.ts` / `recording.ts` for how it is captured),
 * submitted to the server for validation + persistence into the map's
 * `flows` table. `tab_id` is the browser-link tab id (post-`tab.registered`).
 * `origin` is the tab's origin AT THE TIME OF SAVING — the extension, not
 * the server, is the source of truth for it here because a recording can
 * span a navigation (see `recording.ts`'s navigation-hint step), and the
 * server's own `TabSession.url` is only ever the value from `tab.register`
 * and does not track subsequent navigations. The server still
 * canonicalizes it the same way every other `origin` it receives is
 * canonicalized (see `map/origin.ts`) — it is untrusted free text, not a
 * client-asserted fact. `steps` follows the EXACT `browser.flow` step
 * grammar and is rejected with the same `validateFlowSteps` rules
 * `browser.flow` itself enforces.
 */
export interface FlowRecordedPayload {
  tab_id: TabId;
  origin: string;
  name: string;
  description?: string;
  steps: unknown[];
}

export interface FlowRecordedMessage {
  kind: 'flow.recorded';
  payload: FlowRecordedPayload;
}

/** Server's reply to `flow.recorded` — validation/persistence result. No
 * correlation id: the popup disables Save while a request is in flight, so
 * at most one is ever outstanding per tab (same single-slot pattern as the
 * IPC bridge's `settings.push`/`settings.push-ack`). */
export type FlowRecordedResultMessage =
  | { kind: 'flow.recorded.result'; ok: true; name: string }
  | { kind: 'flow.recorded.result'; ok: false; error: string };

/** Filter for one page of the activity trail. Field-for-field the server's
 * `ActivityQuery`, kept as a structural duplicate for the same reason the rest
 * of this file duplicates the server's `messages.ts`: neither package may
 * depend on the other's build. */
export interface ActivityQueryPayload {
  since_id?: number;
  before_id?: number;
  tab_id?: string;
  agent?: string;
  tool?: string;
  flow_id?: string;
  outcome?: 'ok' | 'error';
  limit?: number;
}

/**
 * The Activity window asking the server for a page of the trail.
 *
 * Carries a `request_id`, unlike `flow.recorded`. That message can get away
 * without one because the popup disables Save while a request is in flight, so
 * at most one is ever outstanding. This one cannot: the window issues an
 * initial load and then tails on a timer, and a late reply to a superseded
 * query must be discardable rather than rendered over a newer page.
 */
export interface ActivityQueryMessage {
  kind: 'activity.query';
  request_id: string;
  /** Optional on the type because this arrives off a socket as JSON: a frame
   * missing it is malformed input to defend against, not a compile error to
   * assume away. */
  query?: ActivityQueryPayload;
}

/** Server's reply. `records` stays `unknown[]` on the wire for the same reason
 * `flow.recorded`'s `steps` does — the shape is owned by the server and
 * validated there, not re-declared in two packages that could drift. */
export type ActivityResultMessage =
  | {
      kind: 'activity.result';
      request_id: string;
      ok: true;
      records: unknown[];
      latest_id: number;
      total: number;
      agents: { agent: string; count: number }[];
      stats: ActivityStatsPayload;
    }
  | { kind: 'activity.result'; request_id: string; ok: false; error: string };

/** What the trail costs right now. Rides on EVERY activity reply rather than
 * living behind its own request: the panel must always show the size, and a
 * number you have to ask for is a number that goes stale. */
export interface ActivityStatsPayload {
  rows: number;
  bytes: number;
  oldest_at: string | null;
  newest_at: string | null;
  max_rows: number;
}

/** Permanently delete every row in an inclusive date window. Both ends
 * optional; omitting both purges the whole trail. There is no undo, which is
 * why the UI resolves a count first and says so. */
export interface ActivityPurgeMessage {
  kind: 'activity.purge';
  request_id: string;
  from?: string;
  to?: string;
  /** When true the server only COUNTS what the range would remove and deletes
   * nothing — what the confirmation dialog is built on. */
  dry_run?: boolean;
}

export type ActivityPurgeResultMessage =
  | {
      kind: 'activity.purge.result';
      request_id: string;
      ok: true;
      /** Rows removed, or rows that WOULD be removed when dry_run was set. */
      removed: number;
      dry_run: boolean;
      stats: ActivityStatsPayload;
    }
  | { kind: 'activity.purge.result'; request_id: string; ok: false; error: string };

/**
 * The popup's "Repair connection" button asking the primary to restart itself
 * on the installed code. Understood by servers from 0.41.0; the extension
 * checks `serverVersion` before sending it.
 */
export interface BridgeRepairMessage {
  kind: 'bridge.repair';
  request_id: string;
}

/** Server's reply to `bridge.repair`. On `ok: true` the server spawns the
 * installed CLI, drops every extension socket uncleanly and exits, so the
 * extension's auto-reconnect takes over. */
export type BridgeRepairResultMessage =
  | { kind: 'bridge.repair.result'; request_id: string; ok: true; action: 'restarting' }
  | { kind: 'bridge.repair.result'; request_id: string; ok: false; error: string };

/**
 * Administration over the existing socket: the server describes its state and
 * actions as data (already localised), the popup renders it generically.
 * Identical text lives in `packages/server/src/messages.ts`.
 */
export type AdminItemKind = 'readout' | 'toggle' | 'select' | 'button' | 'link';
export interface AdminOption {
  value: string;
  label: string;
}
export interface AdminItem {
  id: string;
  kind: AdminItemKind;
  label: string;
  description?: string;
  value?: string | number | boolean | null;
  options?: AdminOption[];
  writesDisk: boolean;
  requiresRestart?: boolean;
  hint?: string;
}
export interface AdminSection {
  id: 'status' | 'setup' | 'diagnose' | 'reference';
  title: string;
  items: AdminItem[];
}
export interface AdminUiStrings {
  language: 'en' | 'es';
  confirm: string;
  cancel: string;
  apply: string;
  notConnected: string;
  restartRequired: string;
  changed: string;
}
export interface AdminState {
  version: 1;
  generatedAt: string;
  sections: AdminSection[];
  ui: AdminUiStrings;
}
export type AdminActionResult =
  | { ok: true; applied: true; requiresRestart?: boolean; state?: AdminState; output?: string[] }
  | { ok: true; applied: false; needsConfirm: true; preview: string }
  | { ok: false; error: string };
/** `language` (extensions from 0.51.0): render this answer's labels, previews,
 * errors and `ui` block in the extension's interface language. Absent or
 * invalid: the server's configured language. Never written to disk. */
export type AdminRequestLanguage = 'en' | 'es';
export interface AdminDescribeMessage {
  kind: 'admin.describe';
  request_id: string;
  language?: AdminRequestLanguage;
}
export interface AdminActionMessage {
  kind: 'admin.action';
  request_id: string;
  id: string;
  value?: string | number | boolean;
  confirm?: boolean;
  language?: AdminRequestLanguage;
}
export type AdminStateMessage =
  | { kind: 'admin.state'; request_id: string; ok: true; state: AdminState }
  | { kind: 'admin.state'; request_id: string; ok: false; error: string };
export interface AdminActionResultMessage {
  kind: 'admin.action.result';
  request_id: string;
  result: AdminActionResult;
}

export type ExtensionToServer =
  | TabRegisterMessage
  | ToolResponseMessage
  | BridgeEventMessage
  | FlowRecordedMessage
  | ActivityQueryMessage
  | ActivityPurgeMessage
  | BridgeRepairMessage
  | AdminDescribeMessage
  | AdminActionMessage;
export type ServerToExtension =
  | TabRegisteredMessage
  | ToolRequestMessage
  | ToolCancelMessage
  | SettingsUpdateMessage
  | FlowRecordedResultMessage
  | ActivityResultMessage
  | ActivityPurgeResultMessage
  | BridgeRepairResultMessage
  | AdminStateMessage
  | AdminActionResultMessage;
// </wire-protocol>

export interface PingResult {
  title: string;
  url: string;
}

/** Per-kind MutationRecord counts reported by the page observer. */
export interface PageObserverKinds {
  childList: number;
  attributes: number;
  characterData: number;
}

/** Which kinds of root the counted records came from. `frame` is true when
 * the observer runs in a child frame (`window !== window.top`). */
export interface PageObserverRoots {
  document: boolean;
  shadow: boolean;
  frame: boolean;
}

/** One mutated target, as described by the page observer. `path` is a short
 * structural path such as `body>div#app>ul` (at most six element segments,
 * no indexes), with a `#shadow` segment at each shadow-root boundary. A
 * shadow root that was itself the mutation target is reported with tag
 * `#shadow-root`. */
export interface PageObserverDescriptor {
  tag: string;
  id?: string;
  role?: string;
  path: string;
}

/** One coalesced flush of the page observer: every MutationRecord seen
 * since the previous flush, folded per target element. */
export interface PageObserverSummary {
  type: 'summary';
  doc_id: string;
  /** Monotonic per document, starting at 1. */
  seq: number;
  /** `performance.now()` at the first record and at the flush. */
  t0: number;
  t1: number;
  records: number;
  /** Distinct target elements in this flush. */
  targets: number;
  kinds: PageObserverKinds;
  roots: PageObserverRoots;
  /** Up to the descriptor cap, ordered by record count (highest first). */
  descriptors: PageObserverDescriptor[];
  /** Targets beyond the descriptor cap. */
  overflow: number;
}

/** Pushed once when the page observer installs in a document. */
export interface PageObserverDocStart {
  type: 'doc_start';
  doc_id: string;
  url: string;
  version: number;
  /** `partial` when `attachShadow` could not be patched and the observer
   * falls back to a periodic rescan for open shadow roots. */
  coverage: 'full' | 'partial';
}

/** Pushed on `pushState`, `replaceState`, `popstate` and `hashchange`. */
export interface PageObserverNav {
  type: 'nav';
  doc_id: string;
  url: string;
}

/** Pushed by the top document once it is loaded and again 300 ms after the
 * last SPA navigation (knowledge-loop S1). `build` is a hash of the sorted
 * script and stylesheet URLs with query strings removed; `view_sig` a hash
 * of the first h1-h3 texts and the landmark roles present. */
export interface PageObserverDocInfo {
  type: 'doc_info';
  doc_id: string;
  url: string;
  build: string;
  view_sig: string;
  title: string;
}

/** The messages about the document itself, as opposed to mutation summaries. */
export type PageObserverDocMessage = PageObserverDocStart | PageObserverNav | PageObserverDocInfo;

/** Every message the page observer pushes through its binding (JSON). */
export type PageObserverMessage = PageObserverSummary | PageObserverDocMessage;

/** What an action caused, aggregated from the page observer's summaries
 * since the action mark; attached to settle results. `targets` sums the
 * distinct targets of each flush, so an element touched in two flushes counts
 * twice. `truncated` is set when the observer's ring no longer held every
 * summary since the mark. */
export interface SettleChanges {
  records: number;
  targets: number;
  kinds: PageObserverKinds;
  roots: PageObserverRoots;
  descriptors: PageObserverDescriptor[];
  overflow: number;
  truncated?: true;
}
