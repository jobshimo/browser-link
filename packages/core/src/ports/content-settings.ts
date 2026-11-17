// Chrome content settings (the `set_permission` tool). Extension only.

export interface ContentSettings {
  set(setting: string, primaryPattern: string, value: string): Promise<void>;
}
