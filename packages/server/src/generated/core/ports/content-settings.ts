// GENERATED from packages/core/src/ports/content-settings.ts. Do not edit.
// Chrome content settings (the `set_permission` tool). Extension only.

export interface ContentSettings {
  set(setting: string, primaryPattern: string, value: string): Promise<void>;
}
