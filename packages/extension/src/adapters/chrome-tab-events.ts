// The extension's `TabEvents` (design 3.1, slice 20): `chrome.tabs.get` and
// `chrome.tabs.onUpdated`, what flow recording uses. Stateless, so one object
// serves the worker. `onUpdated` is a transient subscription paired with its
// own unsubscribe (not a wake listener, R1); the recording filters the
// updates it gets (`app/recording.ts`).
import type { TabEvents } from '../app/recording.js';

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
};
