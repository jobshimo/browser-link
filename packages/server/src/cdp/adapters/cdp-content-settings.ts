// The cdp-direct `ContentSettings` (parity G10, owner decision 2026-11-21,
// option a): each content setting core writes is one `Browser.setPermission`
// on the tab's own page connection, for the pattern's origin, with no
// `browserContextId` (Chrome applies it to the default context). It is a
// runtime override, not a setting saved in the profile: it lasts while the
// connection that set it lives, and any DevTools client closing clears the
// overrides of that browser context (experiment X3). The connection is not
// held for it; the idle sweep may close it and the override goes with it.
// Never `Browser.grantPermissions`: it replaces the whole override set (X3).
import type { ContentSettings } from '../../generated/core/ports/content-settings.js';
import type { CdpClient } from '../client.js';

/** What `set_permission` answers with its result on a cdp: tab. */
export const CDP_TEMPORARY_PERMISSION_NOTE =
  'Temporary: on a cdp: tab this permission is a DevTools override, not a saved site setting. It lasts while browser-link stays connected to the tab (the connection is dropped after 30 minutes without a tool call on the tab, 5 when nothing was captured) and another DevTools client disconnecting from the browser can clear it earlier.';

/** The permission descriptor name Chrome takes for each content setting core
 * writes, measured on Chrome stable: `clipboard-read` is the clipboard
 * read-write permission `chrome.contentSettings.clipboard` holds, and
 * `accelerometer` the sensors permission (gyroscope follows it). A setting
 * not listed goes to Chrome unchanged, which refuses it with its own text. */
const DESCRIPTOR_BY_SETTING: ReadonlyMap<string, string> = new Map([
  ['location', 'geolocation'],
  ['notifications', 'notifications'],
  ['camera', 'camera'],
  ['microphone', 'microphone'],
  ['clipboard', 'clipboard-read'],
  ['sensors', 'accelerometer'],
]);

const PERMISSION_SETTING_BY_VALUE: ReadonlyMap<string, string> = new Map([
  ['allow', 'granted'],
  ['block', 'denied'],
  ['ask', 'prompt'],
]);

export function createCdpContentSettings(client: CdpClient): ContentSettings {
  return {
    temporaryNote: CDP_TEMPORARY_PERMISSION_NOTE,
    set: async (setting, primaryPattern, value) => {
      // Core writes the content-setting pattern `<origin>/*`; the override
      // takes the origin.
      const origin = primaryPattern.endsWith('/*') ? primaryPattern.slice(0, -2) : primaryPattern;
      await client.send('Browser.setPermission', {
        permission: { name: DESCRIPTOR_BY_SETTING.get(setting) ?? setting },
        setting: PERMISSION_SETTING_BY_VALUE.get(value) ?? value,
        origin,
      });
    },
  };
}
