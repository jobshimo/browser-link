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
 * Server-pushed settings, currently just the idle-disconnect TTL. The same
 * logical setting is also editable from the extension's own popup, so both
 * sides need a precedence rule for "who wins" when they disagree:
 *
 * `updatedAt` is the epoch-ms timestamp of when THIS value was written on
 * the server side (via `browser-link config set idle-ttl`). The extension
 * compares it against the `updatedAt` it stamped on its own last LOCAL
 * write (from the popup) and only applies the incoming value when it is
 * newer — see `idle-policy.ts`'s `shouldAcceptIncomingSettings`. Comparing
 * raw wall-clock timestamps across processes is safe here specifically
 * because the server and the browser always run on the same machine
 * (loopback-only bridge) and therefore share one clock — this would NOT
 * be a safe pattern for a distributed, multi-host system.
 */
export interface SettingsUpdatePayload {
  idleTtlMinutes: number;
  updatedAt: number;
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

export type ExtensionToServer = TabRegisterMessage | ToolResponseMessage | BridgeEventMessage;
export type ServerToExtension = TabRegisteredMessage | ToolRequestMessage | SettingsUpdateMessage;

export interface PingResult {
  title: string;
  url: string;
}
