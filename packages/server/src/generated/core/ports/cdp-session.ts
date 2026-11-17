// GENERATED from packages/core/src/ports/cdp-session.ts. Do not edit.
// One debugger session on one page. The extension adapts
// `chrome.debugger.sendCommand` and `onEvent` (filtered to its tab);
// cdp-direct adapts its `CdpClient`.

export interface CdpSession {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Every CDP event of this session. Returns the unsubscribe function. */
  onEvent(listener: (method: string, params: unknown) => void): () => void;
}
