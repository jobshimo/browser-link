// GENERATED from packages/core/src/ports/contract/navigator.contract.ts. Do not edit.
// What every `Navigator` guarantees (5.3, item 5): one `Page.navigate` per
// call, input only (slice 15). It runs against the page driver's navigator
// over a `CdpSession`, on the in-memory fake and on a real Chrome target.

import type { Navigator } from '../page-driver.js';
import { type ContractCase, equal } from './assert.js';

export interface NavigatorHarness {
  navigator: Navigator;
  /** A URL the page navigates to. */
  url: string;
  /** A URL the page refuses, and the CDP error message it fails with. */
  failing: { url: string; message: string };
  dispose?: () => Promise<void> | void;
}

export function defineNavigatorContract(
  make: () => Promise<NavigatorHarness> | NavigatorHarness,
): ContractCase[] {
  const withHarness =
    (body: (harness: NavigatorHarness) => Promise<void>) => async (): Promise<void> => {
      const harness = await make();
      try {
        await body(harness);
      } finally {
        await harness.dispose?.();
      }
    };

  return [
    {
      name: 'navigate resolves once the page answered it',
      run: withHarness(async ({ navigator, url }) => {
        await navigator.navigate(url);
      }),
    },
    {
      name: 'a refused navigation rejects with the CDP error message unchanged',
      run: withHarness(async ({ navigator, failing }) => {
        let message: string | null = null;
        try {
          await navigator.navigate(failing.url);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        equal(message, failing.message, 'error message');
      }),
    },
  ];
}
