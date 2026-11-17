// What every `ResponseBodies` guarantees (5.3, item 5): the page's answer to
// `Network.getResponseBody`, one command per call (slice 15). It runs
// against the page driver's response bodies over a `CdpSession`, on the
// in-memory fake and on a real Chrome target.

import type { ResponseBodies } from '../page-driver.js';
import type { ResponseBody } from '../values.js';
import { type ContractCase, equal } from './assert.js';

export interface ResponseBodiesHarness {
  responses: ResponseBodies;
  /** A request the page captured, and the body it answers for it. */
  captured: { requestId: string; body: ResponseBody };
  /** A request id the page does not know, and the CDP error message it fails with. */
  failing: { requestId: string; message: string };
  dispose?: () => Promise<void> | void;
}

export function defineResponseBodiesContract(
  make: () => Promise<ResponseBodiesHarness> | ResponseBodiesHarness,
): ContractCase[] {
  const withHarness =
    (body: (harness: ResponseBodiesHarness) => Promise<void>) => async (): Promise<void> => {
      const harness = await make();
      try {
        await body(harness);
      } finally {
        await harness.dispose?.();
      }
    };

  return [
    {
      name: 'body answers the body and its encoding, in that key order',
      run: withHarness(async ({ responses, captured }) => {
        equal(await responses.body(captured.requestId), captured.body, 'response body');
      }),
    },
    {
      name: 'an unknown request id rejects with the CDP error message unchanged',
      run: withHarness(async ({ responses, failing }) => {
        let message: string | null = null;
        try {
          await responses.body(failing.requestId);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        equal(message, failing.message, 'error message');
      }),
    },
  ];
}
