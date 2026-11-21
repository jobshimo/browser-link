// What a transport's capture watch guarantees (parity P5): a console call
// the page makes reads as one console entry with the documented level, and
// a request the page made reads as a network entry, finished, whose URL
// `finishedUrls` lists. Runs on the in-memory `CdpSession` in core and on
// cdp-direct's watch over a real Chrome target
// (`cdp/adapters/contract.chrome.test.ts`). Outside `ports/contract/`: a
// `CaptureWatch` is not a port (design revision 8).

import { type ContractCase, equal } from '../ports/contract/assert.js';
import type { CaptureWatch } from './page-driver.js';

export interface CaptureWatchHarness {
  watch: CaptureWatch;
  /** Make the page call `console.warn(message)`; resolves once the page
   * reported the call (observed independently of the watch). */
  warn: (message: string) => Promise<void>;
  /** Make the page load one request; resolves with its URL once the page
   * reported it finished (observed independently of the watch). */
  request: () => Promise<string>;
  dispose?: () => Promise<void> | void;
}

export function defineCaptureWatchContract(
  make: () => Promise<CaptureWatchHarness> | CaptureWatchHarness,
): ContractCase[] {
  const withHarness =
    (body: (harness: CaptureWatchHarness) => Promise<void> | void) => async (): Promise<void> => {
      const harness = await make();
      try {
        await body(harness);
      } finally {
        await harness.dispose?.();
      }
    };

  return [
    {
      name: 'a console.warn the page makes reads as one warn entry with its text',
      run: withHarness(async ({ watch, warn }) => {
        await warn('capture contract');
        const entries = watch.consoleEntries().filter((e) => e.text === 'capture contract');
        equal(entries.length, 1, 'entries with the text');
        equal(entries[0]?.level, 'warn', 'level');
        equal(entries[0]?.source, 'console', 'source');
      }),
    },
    {
      name: 'a request the page made reads as a finished network entry listed by finishedUrls',
      run: withHarness(async ({ watch, request }) => {
        const url = await request();
        const entries = watch.networkEntries().filter((e) => e.url === url);
        equal(entries.length, 1, 'entries with the url');
        equal(typeof entries[0]?.finished_at, 'number', 'finished_at');
        equal([...watch.finishedUrls()].includes(url), true, 'finishedUrls lists the url');
      }),
    },
  ];
}
