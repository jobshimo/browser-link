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

export type ExtensionToServer = TabRegisterMessage | ToolResponseMessage | BridgeEventMessage;
export type ServerToExtension = TabRegisteredMessage | ToolRequestMessage;
