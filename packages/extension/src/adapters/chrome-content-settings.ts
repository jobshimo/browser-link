// The extension's `ContentSettings` (design 3.1): `chrome.contentSettings`;
// the lookup of the setting by key is `app/content-settings.ts`.
import type { ContentSettings } from '@browser-link/core';
import { applyContentSetting } from '../app/content-settings.js';

export function createChromeContentSettings(): ContentSettings {
  return {
    set: (setting, primaryPattern, value) =>
      applyContentSetting(chrome.contentSettings, setting, primaryPattern, value),
  };
}
