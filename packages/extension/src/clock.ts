/**
 * The `Clock` the flow runner (`flow.ts`) and `expect.ts` read time
 * through, so neither calls `Date.now` or `setTimeout` itself (design 5.1,
 * slice 5b-1). The server keeps a byte-identical sibling at
 * `packages/server/src/cdp/clock.ts`, which `cdp/drift.test.ts` asserts;
 * both declare the same shape as `@browser-link/core`'s `ports/clock.ts`
 * (`clock.test.ts` checks they are mutually assignable). The real clock is
 * `adapters/system-clock.ts`. This file goes away in slice 8, when
 * `flow.ts` moves to core and imports `ports/clock.ts`.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Run `fn` once after `ms`; returns cancel. Replaces setTimeout/clearTimeout. */
  after(ms: number, fn: () => void): () => void;
  /** Run `tick` every `ms`; returns stop. Replaces setInterval. */
  every(ms: number, tick: () => void): () => void;
}
