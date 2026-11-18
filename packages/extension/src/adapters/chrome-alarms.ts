// The extension's `Alarms` (design 3.1, slice 19): `chrome.alarms`, the
// reconnect safety net that wakes a stopped worker. Stateless, so one object
// serves the worker. `onFire` is a wake listener: `background.ts` subscribes
// it at top level (R1); the in-worker contract run (`contract/`) reaches it
// and `set` for the R6 coverage check.
import type { Alarms } from '../app/connection.js';

export const chromeAlarms: Alarms = {
  set: async (name, when) => {
    await chrome.alarms.create(name, { when });
  },
  clear: async (name) => {
    await chrome.alarms.clear(name);
  },
  onFire: (listener) => {
    chrome.alarms.onAlarm.addListener((alarm) => {
      listener(alarm.name);
    });
  },
};
