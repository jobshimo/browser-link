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

export type ExtensionToServer = TabRegisterMessage | ToolResponseMessage;
export type ServerToExtension = TabRegisteredMessage | ToolRequestMessage;

export interface PingResult {
  title: string;
  url: string;
}
