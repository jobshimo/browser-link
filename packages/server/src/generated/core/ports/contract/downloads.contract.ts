// GENERATED from packages/core/src/ports/contract/downloads.contract.ts. Do not edit.
// What every `Downloads` guarantees (5.3, item 5; slice 16): a capture
// whose action fails answers the action's error and leaves nothing armed, a
// capture that sees no download answers `timeout`, and settling a download
// that is not held answers `not_held`. It runs against the in-memory fake
// and against the extension adapter over a stand-in `chrome.downloads`; in
// the real service worker the e2e reaches the adapter (R6, condition 1).

import type { Downloads } from '../downloads.js';
import { type ContractCase, equal } from './assert.js';

export interface DownloadsHarness {
  downloads: Downloads;
  /** Let `ms` pass on the subject's timers. */
  elapse: (ms: number) => Promise<void>;
  dispose?: () => Promise<void> | void;
}

export function defineDownloadsContract(
  make: () => Promise<DownloadsHarness> | DownloadsHarness,
): ContractCase[] {
  const withHarness =
    (body: (harness: DownloadsHarness) => Promise<void>) => async (): Promise<void> => {
      const harness = await make();
      try {
        await body(harness);
      } finally {
        await harness.dispose?.();
      }
    };
  const wait = { timeoutMs: 20, holdMs: 40 };

  return [
    {
      name: 'a failed action answers its error, and the next capture can arm',
      run: withHarness(async ({ downloads, elapse }) => {
        const failed = await downloads.captureAround(wait, () =>
          Promise.resolve({ ok: false, error: 'Element not found: #dl' }),
        );
        equal(failed, { ok: false, error: 'Element not found: #dl' }, 'failed capture');
        const next = downloads.captureAround(wait, () => Promise.resolve({ ok: true }));
        await elapse(wait.timeoutMs);
        equal(await next, { ok: true, outcome: { state: 'timeout' } }, 'next capture');
      }),
    },
    {
      name: 'settle of a download that is not held answers not_held',
      run: withHarness(async ({ downloads }) => {
        equal(await downloads.settle(424242, true), 'not_held', 'settle');
      }),
    },
  ];
}
