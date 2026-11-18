// An in-memory `LocalSettingsStorage` (the contract's fake, and the settings
// cache tests'): values serialised as Chrome stores them, and every `set` or
// `remove` reported to the `onChanged` listeners as a `local` change.

import type { LocalSettingsStorage, StorageChange } from '../src/app/settings-cache.js';

export interface MemorySettings extends LocalSettingsStorage {
  /** What the storage holds now. */
  readonly values: ReadonlyMap<string, unknown>;
  remove(key: string): Promise<void>;
  /** Report a change in another area, as the browser does for `session`. */
  changeIn(area: string, changes: Record<string, StorageChange>): void;
  /** Make every `get` and `set` reject until called with false. */
  fail(failing: boolean): void;
}

export function createMemorySettings(initial: Record<string, unknown> = {}): MemorySettings {
  const values = new Map<string, unknown>(Object.entries(initial));
  const listeners: ((changes: Record<string, StorageChange>, area: string) => void)[] = [];
  let failing = false;
  const report = (changes: Record<string, StorageChange>, area = 'local'): void => {
    for (const listener of listeners) listener(changes, area);
  };
  return {
    values,
    get(key) {
      if (failing) return Promise.reject(new Error('storage down'));
      return Promise.resolve(values.has(key) ? { [key]: values.get(key) } : {});
    },
    set(items) {
      if (failing) return Promise.reject(new Error('storage down'));
      const changes: Record<string, StorageChange> = {};
      for (const [key, value] of Object.entries(items)) {
        const stored: unknown = JSON.parse(JSON.stringify(value));
        values.set(key, stored);
        changes[key] = { newValue: stored };
      }
      report(changes);
      return Promise.resolve();
    },
    remove(key) {
      if (values.delete(key)) report({ [key]: {} });
      return Promise.resolve();
    },
    onChanged(listener) {
      listeners.push(listener);
    },
    changeIn(area, changes) {
      report(changes, area);
    },
    fail(value) {
      failing = value;
    },
  };
}
