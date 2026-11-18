// The extension's `Runtime` (design 3.1, slice 21): `chrome.runtime`, the
// manifest's version, the extension's page URLs and the messages its pages
// send. Stateless, so one object serves the worker. `onMessage` is a wake
// listener: `background.ts` subscribes it at top level (R1); the in-worker
// contract run (`contract/`) reaches it for the R6 coverage check.
import type { Runtime } from '../app/popup-router.js';

export const chromeRuntime: Runtime = {
  manifestVersion: () => chrome.runtime.getManifest().version,
  pageUrl: (path) => chrome.runtime.getURL(path),
  onMessage: (listener) => {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) =>
      listener(message, sendResponse),
    );
  },
};
