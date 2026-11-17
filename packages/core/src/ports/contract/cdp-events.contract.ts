// What every `CdpEvents` guarantees (5.3, item 5): a wait for one event of
// the session that the core asks for (slice 14). It runs against the page
// driver's event wait over a `CdpSession`, on the in-memory fake and on a
// real Chrome target.

import type { CdpEvents } from '../page-driver.js';
import { type ContractCase, check, equal } from './assert.js';

export interface CdpEventsHarness {
  events: CdpEvents;
  /** The method of the events `emit` makes the page send. */
  method: string;
  /** Make the page send at least one event named `method`, with params. */
  emit: () => Promise<void>;
  /** Let `ms` of the harness's time pass. */
  elapse: (ms: number) => Promise<void>;
  dispose?: () => Promise<void> | void;
}

/** A timeout the harness's `elapse` passes quickly on a real page too. */
const SHORT_MS = 100;
/** A timeout no case waits out. */
const LONG_MS = 10_000;

export function defineCdpEventsContract(
  make: () => Promise<CdpEventsHarness> | CdpEventsHarness,
): ContractCase[] {
  const withHarness =
    (body: (harness: CdpEventsHarness) => Promise<void>) => async (): Promise<void> => {
      const harness = await make();
      try {
        await body(harness);
      } finally {
        await harness.dispose?.();
      }
    };

  return [
    {
      name: 'waitFor resolves with the params the predicate saw, for an event after the call',
      run: withHarness(async ({ events, method, emit }) => {
        const seen: unknown[] = [];
        const waiting = events.waitFor(
          method,
          (params) => {
            seen.push(params);
            return true;
          },
          LONG_MS,
        );
        await emit();
        const params = await waiting;
        check(params !== null && typeof params === 'object', 'no event params');
        check(seen[0] === params, 'the result is not the params the predicate saw');
      }),
    },
    {
      name: 'waitFor resolves null when no such event arrives in time',
      run: withHarness(async ({ events, elapse }) => {
        const waiting = events.waitFor('Contract.neverSent', () => true, SHORT_MS);
        await elapse(SHORT_MS * 2);
        equal(await waiting, null, 'result after the timeout');
      }),
    },
    {
      name: 'an event the predicate refuses does not settle the wait',
      run: withHarness(async ({ events, method, emit, elapse }) => {
        const waiting = events.waitFor(method, () => false, SHORT_MS);
        await emit();
        await elapse(SHORT_MS * 2);
        equal(await waiting, null, 'result after refused events');
      }),
    },
    {
      name: 'once settled the wait stops listening',
      run: withHarness(async ({ events, method, emit }) => {
        let calls = 0;
        const waiting = events.waitFor(
          method,
          () => {
            calls += 1;
            return true;
          },
          LONG_MS,
        );
        await emit();
        await waiting;
        const settledAfter = calls;
        await emit();
        equal(calls, settledAfter, 'predicate calls after the wait settled');
      }),
    },
  ];
}
