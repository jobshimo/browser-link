// The extension's `Windows` (design 3.1, slice 21): `chrome.windows`, the
// Activity and Admin windows. Stateless, so one object serves the worker;
// the window each one remembers is `app/windows.ts` state. `onClosed` is a
// wake listener: `background.ts` subscribes it at top level (R1); the
// in-worker contract run (`contract/`) reaches it for the R6 coverage check.
import type { Windows } from '../app/windows.js';

export const chromeWindows: Windows = {
  open: async (url, size) => (await chrome.windows.create({ url, type: 'popup', ...size }))?.id,
  focus: async (windowId) => {
    await chrome.windows.update(windowId, { focused: true });
  },
  exists: async (windowId) => (await chrome.windows.get(windowId)).id !== undefined,
  onClosed: (listener) => {
    chrome.windows.onRemoved.addListener(listener);
  },
};
