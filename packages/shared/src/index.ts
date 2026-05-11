export type TabId = string;

export interface TabRegisterPayload {
  url: string;
  title: string;
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
