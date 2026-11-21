// Chrome content settings (the `set_permission` tool, slice 16): the
// extension's `chrome.contentSettings`, and since parity G10 cdp-direct's
// `Browser.setPermission` override on the tab's page connection.

export interface ContentSettings {
  /** Set the content setting `setting` (a `chrome.contentSettings` key, such
   * as `location`) to `value` (`allow`, `block`, `ask`) for the URL pattern
   * `primaryPattern`; rejects with the browser's error text. */
  set(setting: string, primaryPattern: string, value: string): Promise<void>;
  /** Given only by a surface whose write is a temporary override rather than
   * a setting saved in the profile (cdp-direct): the note `set_permission`
   * answers with its result. Such a surface is not `chrome.contentSettings`,
   * so the unsupported-name error does not name it. */
  readonly temporaryNote?: string;
}
