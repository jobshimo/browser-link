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
export type ServerToExtension = TabRegisteredMessage | ToolRequestMessage;

export interface PingResult {
  title: string;
  url: string;
}
