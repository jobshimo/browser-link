/**
 * Wire-protocol types between the MCP server and the Chrome extension.
 *
 * Kept in-tree (instead of the @browser-link/shared workspace package) so the
 * server publishes to npm without an unresolvable workspace dependency.
 * The extension still uses the workspace copy in packages/shared.
 */

export type TabId = string;

export interface TabRegisterPayload {
  url: string;
  title: string;
  /**
   * Optional. The browser-link tab_id this Chrome tab last had, as
   * remembered by the extension across primary swaps. The primary honours
   * it if free; otherwise it assigns a new id and emits a `tab-renamed`
   * event the agent can pick up via the `browser.events` tool.
   */
  previousTabId?: TabId;
}

export interface TabRegisteredPayload {
  tabId: TabId;
  /**
   * Version of the MCP server that just handed out this tabId. The extension
   * stores it on its `TabState` so the popup can compare it against
   * `chrome.runtime.getManifest().version` and warn the user when the two
   * sides have drifted — typically after `npm install -g @jobshimo/browser-link`
   * but before re-loading the Chrome extension. Optional only so older
   * extensions that don't know about the field can still parse the message.
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
 * opaque id `tools/browser-dispatch.ts` mints per flow call and returns in
 * the flow result).
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
 * Out-of-band notification from the extension to the server's BridgeEventLog.
 * Used for things the agent needs to learn about but that aren't tool responses:
 * native dialogs opening/closing, new tabs spawned by a connected tab, etc.
 *
 * `tabId` (when present) is the server-assigned browser-link id, NOT the
 * Chrome tab id. The extension reads it from its own TabState (set after
 * `tab.register` -> `tab.registered`).
 */
export interface BridgeEventMessage {
  kind: 'bridge.event';
  eventKind: string;
  tabId?: TabId;
  data: Record<string, unknown>;
}

/**
 * Server-pushed settings. Two independent settings share this one message
 * kind — the idle-disconnect TTL (`browser-link config get/set idle-ttl`)
 * and the opt-in flow-recording toggle (`config get/set flow-recording`) —
 * each also editable from the extension's own popup, so both need a
 * precedence rule for "who wins" when they disagree:
 *
 * `updatedAt` / `flowRecordingUpdatedAt` is the epoch-ms timestamp of when
 * THAT value was written on the server side. The extension compares it
 * against the timestamp it stamped on its own last LOCAL write (from the
 * popup) and only applies the incoming value when it is newer — see the
 * extension's `idle-policy.ts` (`shouldAcceptIncomingSettings`, reused by
 * `flow-recording-policy.ts` for the second setting) and the README's
 * "Idle disconnect" section for the full precedence writeup. Comparing raw
 * wall-clock timestamps across processes is safe here specifically because
 * the server and the browser always run on the same machine (loopback-only
 * bridge) and therefore share one clock — this would NOT be a safe pattern
 * for a distributed, multi-host system.
 *
 * Every field is optional — a single message may carry only the idle-TTL
 * pair, only the flow-recording pair, or both; the extension applies each
 * independently.
 */
export interface SettingsUpdatePayload {
  idleTtlMinutes?: number;
  updatedAt?: number;
  flowRecordingEnabled?: boolean;
  flowRecordingUpdatedAt?: number;
}

export interface SettingsUpdateMessage {
  kind: 'settings.update';
  settings: SettingsUpdatePayload;
}

/**
 * A flow recorded by demonstration in the extension (see the extension's
 * `background.ts`'s `saveRecording` and `recording.ts`), submitted for
 * validation + persistence into the map's `flows` table. `origin` is
 * untrusted free text — canonicalized here the same way every other
 * `origin` the server receives is (`map/origin.ts`), NOT trusted as
 * already-canonical just because it came from the extension rather than an
 * agent. `steps` is validated with the exact same `validateFlowSteps`
 * rules `browser.flow` and `browser.map.save`'s `flows` array enforce.
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

/** Server's reply to `flow.recorded`. No correlation id — see the
 * identical note on the extension's copy of this type in
 * `@browser-link/shared`. */
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
