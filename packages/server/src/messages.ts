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
