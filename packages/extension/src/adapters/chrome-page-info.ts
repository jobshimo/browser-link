// The extension's `PageInfo` (design 3.1): `chrome.tabs.get` for the url
// and title, and the load wait on `chrome.tabs.onUpdated` (core's
// `armLoadWait` and `tabLoadSignal` hold the status check and the timer).
import { armLoadWait, tabLoadSignal, type Clock, type PageInfo } from '@browser-link/core';

export function createChromePageInfo(tabId: number, clock: Clock): PageInfo {
  return {
    info: () =>
      chrome.tabs.get(tabId).then((tab) => ({ url: tab.url ?? '', title: tab.title ?? '' })),
    armLoadWait: (timeoutMs) =>
      armLoadWait(
        tabLoadSignal(tabId, {
          add: (handler) => {
            chrome.tabs.onUpdated.addListener(handler);
          },
          remove: (handler) => {
            chrome.tabs.onUpdated.removeListener(handler);
          },
        }),
        clock,
        timeoutMs,
      ),
  };
}
