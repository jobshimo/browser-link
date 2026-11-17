// GENERATED from packages/core/src/ports/contract/content-settings.contract.ts. Do not edit.
// What every `ContentSettings` guarantees (5.3, item 5; slice 16): a value
// is written as given, the last write winning, and a refusal rejects with
// the browser's error text unchanged. It runs against the in-memory fake and
// against the extension adapter over a stand-in `chrome.contentSettings`; in
// the real service worker the e2e reaches the adapter (R6, condition 1).

import type { ContentSettings } from '../content-settings.js';
import { type ContractCase, equal } from './assert.js';

export interface ContentSettingsHarness {
  settings: ContentSettings;
  /** The value `setting` holds for `primaryPattern`, as the subject wrote it. */
  read: (setting: string, primaryPattern: string) => Promise<string | undefined>;
  /** A setting the browser refuses, and the error message it fails with. */
  failing: { setting: string; message: string };
  dispose?: () => Promise<void> | void;
}

export function defineContentSettingsContract(
  make: () => Promise<ContentSettingsHarness> | ContentSettingsHarness,
): ContractCase[] {
  const withHarness =
    (body: (harness: ContentSettingsHarness) => Promise<void>) => async (): Promise<void> => {
      const harness = await make();
      try {
        await body(harness);
      } finally {
        await harness.dispose?.();
      }
    };

  return [
    {
      name: 'set writes the value for the pattern, the last write winning',
      run: withHarness(async ({ settings, read }) => {
        await settings.set('location', 'https://a.test/*', 'allow');
        await settings.set('location', 'https://a.test/*', 'block');
        equal(await read('location', 'https://a.test/*'), 'block', 'value');
      }),
    },
    {
      name: 'a refused setting rejects with the error message unchanged',
      run: withHarness(async ({ settings, failing }) => {
        let message: string | null = null;
        try {
          await settings.set(failing.setting, 'https://a.test/*', 'allow');
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        equal(message, failing.message, 'error message');
      }),
    },
  ];
}
