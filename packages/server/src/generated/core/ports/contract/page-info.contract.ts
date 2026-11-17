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
        const { url, title } = await page.info();
        equal({ url, title }, expected, 'page info');
      }),
    },
    {
      name: 'an armed load wait resolves when the page finishes loading',
      run: withHarness(async ({ page, completeLoad }) => {
        const loaded = observe(page.armLoadWait(TIMEOUT_MS * 50).done);
        await completeLoad();
        equal(await loaded.now(), 'resolved', 'load wait after load');
      }),
    },
    {
      name: 'an armed load wait rejects when the timeout passes first',
      run: withHarness(async ({ page, elapse }) => {
        const loaded = observe(page.armLoadWait(TIMEOUT_MS).done);
        await elapse(TIMEOUT_MS * 2);
        equal(await loaded.now(), 'rejected', 'load wait without load');
      }),
    },
    {
      name: 'a cancelled load wait never settles',
      run: withHarness(async ({ page, completeLoad, elapse }) => {
        const wait = page.armLoadWait(TIMEOUT_MS);
        const loaded = observe(wait.done);
        wait.cancel();
        await completeLoad();
        await elapse(TIMEOUT_MS * 2);
        equal(await loaded.now(), 'pending', 'load wait after cancel');
      }),
    },
  ];
}
