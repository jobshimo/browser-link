// The extension's `TabEvents` (design 3.1, slices 20 and 21): `chrome.tabs`
// and `chrome.debugger.onDetach`. Stateless, so one object serves the worker.
// `onUpdated` is a transient subscription paired with its own unsubscribe
// (not a wake listener, R1); the recording filters the updates it gets
// (`app/recording.ts`). `onRemoved`, `onCreated` and `onDebuggerDetach` are
// wake listeners: `background.ts` subscribes them at top level (R1); the
// in-worker contract run (`contract/`) reaches them for the R6 coverage check.
import type { TabEvents } from '../app/tab-events.js';

export const chromeTabEvents: TabEvents = {
  get: (tabId) => chrome.tabs.get(tabId),
  onUpdated: (listener) => {
    const onUpdated = (tabId: number, info: { status?: string }, tab: { url?: string }) => {
      listener({ tabId, status: info.status, url: tab.url });
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  },
  onRemoved: (listener) => {
    chrome.tabs.onRemoved.addListener((tabId) => {
      listener(tabId);
    });
  },
  onCreated: (listener) => {
    chrome.tabs.onCreated.addListener((tab) => {
      listener({ tabId: tab.id, openerTabId: tab.openerTabId });
    });
  },
  onDebuggerDetach: (listener) => {
    chrome.debugger.onDetach.addListener((source) => {
      listener(source.tabId);
    });
  },
};
