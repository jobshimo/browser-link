// Set one `chrome.contentSettings.<setting>` value (the `ContentSettings`
// adapter's logic, slice 16). The content-settings surface is dynamic at the
// API level, so the setting is looked up by key and a missing one fails with
// a text that names it. Pure: the adapter passes the API object.

/** The `chrome.contentSettings` object, as far as this module reads it. */
export type ContentSettingsRoot = Record<string, unknown> | undefined;

interface ContentSetting {
  set(details: { primaryPattern: string; setting: string }): Promise<void>;
}

export async function applyContentSetting(
  root: ContentSettingsRoot,
  settingKey: string,
  primaryPattern: string,
  setting: string,
): Promise<void> {
  if (!root) throw new Error('chrome.contentSettings not available in this build');
  const setter = root[settingKey] as ContentSetting | undefined;
  if (!setter || typeof setter.set !== 'function') {
    throw new Error(`chrome.contentSettings.${settingKey} is not exposed in this Chrome build`);
  }
  await setter.set({ primaryPattern, setting });
}
