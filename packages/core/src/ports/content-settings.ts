// Chrome content settings (the `set_permission` tool, slice 16). Extension
// only.

export interface ContentSettings {
  /** Set the content setting `setting` (a `chrome.contentSettings` key, such
   * as `location`) to `value` (`allow`, `block`, `ask`) for the URL pattern
   * `primaryPattern`; rejects with the browser's error text. */
  set(setting: string, primaryPattern: string, value: string): Promise<void>;
}
