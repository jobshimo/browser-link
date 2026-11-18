// The extension's `LocalSettingsStorage` (design 3.1, slice 21b):
// `chrome.storage.local` and `chrome.storage.onChanged`, under the settings
// caches of `app/settings-cache.ts`. Stateless, so one object serves the
// worker; the caches are the app module's state. `onChanged` is a wake
// listener: `background.ts` subscribes it at top level (R1); the in-worker
// contract run (`contract/`) reaches it for the R6 coverage check.
import type { LocalSettingsStorage } from '../app/settings-cache.js';

export const chromeSettings: LocalSettingsStorage = {
  get: (key) => chrome.storage.local.get(key),
  set: (items) => chrome.storage.local.set(items),
  onChanged: (listener) => {
    chrome.storage.onChanged.addListener(listener);
  },
};
