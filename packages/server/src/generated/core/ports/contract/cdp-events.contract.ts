// GENERATED from packages/core/src/ports/contract/cdp-events.contract.ts. Do not edit.
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
  /** How many listeners the session under `events` holds now
   * (`countingSession`). */
  listening: () => number;
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
      name: 'waitFor resolves with the params of an event that arrives after the call',
      run: withHarness(async ({ events, method, emit }) => {
        const waiting = events.waitFor(method, LONG_MS);
        await emit();
        const params = await waiting;
        check(params !== null && typeof params === 'object', 'no event params');
      }),
    },
    {
      name: 'waitFor resolves null when no such event arrives in time',
      run: withHarness(async ({ events, elapse }) => {
        const waiting = events.waitFor('Contract.neverSent', SHORT_MS);
        await elapse(SHORT_MS * 2);
        equal(await waiting, null, 'result after the timeout');
      }),
    },
    {
      name: 'an event of another method does not settle the wait',
      run: withHarness(async ({ events, emit, elapse }) => {
        const waiting = events.waitFor('Contract.neverSent', SHORT_MS);
        await emit();
        await elapse(SHORT_MS * 2);
        equal(await waiting, null, 'result after events of another method');
      }),
    },
    {
      name: 'once settled the wait stops listening, by event or by timeout',
      run: withHarness(async ({ events, method, emit, elapse, listening }) => {
        const before = listening();
        const matched = events.waitFor(method, LONG_MS);
        await emit();
        await matched;
        equal(listening(), before, 'listeners after the wait settled on its event');
        const expired = events.waitFor('Contract.neverSent', SHORT_MS);
        await elapse(SHORT_MS * 2);
        await expired;
        equal(listening(), before, 'listeners after the wait timed out');
      }),
    },
  ];
}
