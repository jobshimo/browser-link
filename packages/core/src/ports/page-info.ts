// What the transport knows about the page outside CDP.

export interface PageInfo {
  info(): Promise<{ url: string; title: string }>;
  /** Resolves when the page reports load complete, rejects on timeout. */
  waitForLoad(timeoutMs: number): Promise<void>;
}
