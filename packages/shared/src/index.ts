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

export type ToolResponseMessage =
  | { kind: 'tool.response'; id: string; ok: true; result: unknown }
  | { kind: 'tool.response'; id: string; ok: false; error: string };

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
 * Today the live sender is the extension's own popup (which cancels
 * in-process through `chrome.runtime.onMessage`, never over this socket);
 * this frame is what lets a SERVER-side caller — `browser.flow_cancel`,
 * the next slice of `docs/specs/flow-supervised-execution.md` — reach the
 * same registry without another protocol change.
 */
export interface ToolCancelMessage {
  kind: 'tool.cancel';
  flow_id: string;
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

export type ExtensionToServer =
  TabRegisterMessage | ToolResponseMessage | BridgeEventMessage | FlowRecordedMessage;
export type ServerToExtension =
  | TabRegisteredMessage
  | ToolRequestMessage
  | ToolCancelMessage
  | SettingsUpdateMessage
  | FlowRecordedResultMessage;

export interface PingResult {
  title: string;
  url: string;
}
