// The clicked tab's own `Page.downloadWillBegin` reports (the `Downloads`
// adapter's filter, slice 16), read from the debugger events of the session
// already attached to it (`Page.enable` at connect). Pure: the adapter passes
// the subscription to the browser's debugger events.
import type { TabDownloadSignals } from '../download-capture.js';

/** One debugger event, as the browser hands it to a listener. */
export type DebuggerEventListener = (
  source: { tabId?: number },
  method: string,
  params?: object,
) => void;

/** Subscribe to every debugger event of the browser, and undo it. */
export interface DebuggerEvents {
  add(listener: DebuggerEventListener): void;
  remove(listener: DebuggerEventListener): void;
}

export function tabDownloadSignals(tabId: number, events: DebuggerEvents): TabDownloadSignals {
  return {
    subscribe(onDownloadWillBegin) {
      const listener: DebuggerEventListener = (source, method, params) => {
        if (source.tabId !== tabId || method !== 'Page.downloadWillBegin') return;
        const url = (params as { url?: unknown } | undefined)?.url;
        if (typeof url === 'string') onDownloadWillBegin(url);
      };
      events.add(listener);
      return () => {
        events.remove(listener);
      };
    },
  };
}
