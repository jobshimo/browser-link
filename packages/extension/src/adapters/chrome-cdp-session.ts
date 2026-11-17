// The extension's `CdpSession` (design 3.1): `chrome.debugger.sendCommand`
// on one tab. Events come from the tab-filtered dispatch `background.ts`
// owns (its permanent `chrome.debugger.onEvent` listener hands each event to
// the listeners of the tab it came from), so this adapter holds no filter.
import type { CdpSession } from '@browser-link/core';

/** Add a listener to one tab's CDP events; returns the unsubscribe function. */
export type TabEventSubscribe = (listener: (method: string, params: unknown) => void) => () => void;

export function createChromeCdpSession(tabId: number, subscribe: TabEventSubscribe): CdpSession {
  return {
    send: <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
      chrome.debugger.sendCommand({ tabId }, method, params ?? {}) as unknown as Promise<T>,
    onEvent: (listener) => subscribe(listener),
  };
}
