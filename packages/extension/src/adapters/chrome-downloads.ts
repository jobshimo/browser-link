// The extension's `Downloads` for one tab (design 3.1): the worker-wide
// capture over `chrome.downloads` (`download-capture.ts`, which owns the
// held-download state) and the tab's `Page.downloadWillBegin` reports on
// `chrome.debugger.onEvent` (`app/download-signals.ts` holds the filter).
import type { Downloads } from '@browser-link/core';
import { tabDownloadSignals } from '../app/download-signals.js';
import { captureAround, type DownloadCapture } from '../download-capture.js';

export function createChromeDownloads(capture: DownloadCapture, tabId: number): Downloads {
  return {
    captureAround: ({ timeoutMs, holdMs }, act) =>
      captureAround(
        capture,
        {
          timeoutMs,
          holdMs,
          tab: tabDownloadSignals(tabId, {
            add: (listener) => {
              chrome.debugger.onEvent.addListener(listener);
            },
            remove: (listener) => {
              chrome.debugger.onEvent.removeListener(listener);
            },
          }),
        },
        act,
      ),
    settle: (downloadId, saved) => capture.settle(downloadId, saved),
  };
}
