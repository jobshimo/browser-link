// What every `LocalSettingsStorage` guarantees (design 3.1; slice 21b): a
// value set reads back through `get`, and the change reaches `onChanged` as a
// `local` change carrying the new value. It runs against the in-memory fake
// under vitest (`src/app/extension-contracts.test.ts`) and against the real
// `chrome.storage.local` adapter inside the service worker (`entry.ts`, run
// by the e2e; R6). The key starts with `CONTRACT_SETTINGS_PREFIX`, which no
// settings cache reads, and is removed in a `finally`, on failure too.

import { type ContractCase, equal } from '@browser-link/core';
import type { LocalSettingsStorage, StorageChange } from '../src/app/settings-cache.js';

export const CONTRACT_SETTINGS_PREFIX = 'browser-link-contract:';

export interface SettingsHarness {
  storage: LocalSettingsStorage;
  /** A name unique to this run. */
  runId(): string;
  /** Remove the key from the storage, whatever the subject did. */
  remove(key: string): Promise<void>;
  /** Let time pass until `done` resolves; reject when it has not after `timeoutMs`. */
  until(done: Promise<void>, timeoutMs: number): Promise<void>;
}

/** How long the contract waits for the change report. */
export const CONTRACT_SETTINGS_TIMEOUT_MS = 10_000;

export function defineSettingsContract(make: () => SettingsHarness): ContractCase[] {
  return [
    {
      name: 'a value set reads back through get, and its change reaches onChanged as local',
      run: async () => {
        const { storage, runId, remove, until } = make();
        const key = `${CONTRACT_SETTINGS_PREFIX}${runId()}`;
        const seen: { change: StorageChange; area: string }[] = [];
        let changed = (): void => undefined;
        const done = new Promise<void>((resolve) => {
          changed = resolve;
        });
        storage.onChanged((changes, area) => {
          const change = changes[key];
          if (!change) return;
          seen.push({ change, area });
          changed();
        });
        try {
          await storage.set({ [key]: 7 });
          await until(done, CONTRACT_SETTINGS_TIMEOUT_MS);
          equal(await storage.get(key), { [key]: 7 }, 'get after set');
          equal(
            seen.map((s) => [s.area, s.change.newValue]),
            [['local', 7]],
            'change reports',
          );
        } finally {
          await remove(key);
        }
      },
    },
  ];
}
