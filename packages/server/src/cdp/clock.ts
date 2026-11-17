/**
 * Independent copy of `packages/extension/src/clock.ts`: the `Clock` this
 * package's `cdp/flow.ts` reads time through (design 5.1, slice 5b-1; core's
 * `support/expect.ts` takes core's identical `ports/clock.ts` since slice 7). Everything below this header is byte-identical, which
 * `cdp/drift.test.ts` asserts. The real clock is
 * `cdp/adapters/system-clock.ts`. Deleted in slice 8 with the `flow.ts`
 * copy.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Run `fn` once after `ms`; returns cancel. Replaces setTimeout/clearTimeout. */
  after(ms: number, fn: () => void): () => void;
  /** Run `tick` every `ms`; returns stop. Replaces setInterval. */
  every(ms: number, tick: () => void): () => void;
}
