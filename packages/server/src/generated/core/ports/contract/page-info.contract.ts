// GENERATED from packages/core/src/ports/contract/page-info.contract.ts. Do not edit.
// What every `PageInfo` adapter guarantees (5.3, item 5).

import type { PageInfo } from '../page-info.js';
import { type ContractCase, equal, observe } from './assert.js';

export interface PageInfoHarness {
  page: PageInfo;
  /** What `info()` reports for the harness page. */
  expected: { url: string; title: string };
  /** Make the page report load complete. */
  completeLoad: () => Promise<void> | void;
  /** Let `ms` milliseconds pass on the clock the subject uses. */
  elapse: (ms: number) => Promise<void>;
  dispose?: () => Promise<void> | void;
}

/** Load timeout the contract passes; short, so a real page can run it. */
const TIMEOUT_MS = 100;

export function definePageInfoContract(
  make: () => Promise<PageInfoHarness> | PageInfoHarness,
): ContractCase[] {
  const withHarness =
    (body: (harness: PageInfoHarness) => Promise<void>) => async (): Promise<void> => {
      const harness = await make();
      try {
        await body(harness);
      } finally {
        await harness.dispose?.();
      }
    };

  return [
    {
      name: 'info reports the url and title',
      run: withHarness(async ({ page, expected }) => {
        equal(await page.info(), expected, 'page info');
      }),
    },
    {
      name: 'waitForLoad resolves when the page finishes loading',
      run: withHarness(async ({ page, completeLoad }) => {
        const loaded = observe(page.waitForLoad(TIMEOUT_MS * 10));
        await completeLoad();
        equal(await loaded.now(), 'resolved', 'waitForLoad after load');
      }),
    },
    {
      name: 'waitForLoad rejects when the timeout passes first',
      run: withHarness(async ({ page, elapse }) => {
        const loaded = observe(page.waitForLoad(TIMEOUT_MS));
        await elapse(TIMEOUT_MS * 2);
        equal(await loaded.now(), 'rejected', 'waitForLoad without load');
      }),
    },
  ];
}
