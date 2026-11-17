// GENERATED from packages/core/src/ports/clock.ts. Do not edit.
// All time in core goes through this port (5.1 of the design). The flow
// engine and expect adopt it in slice 5b-1; the real clocks are the
// transports' `system-clock.ts` adapters.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Run `fn` once after `ms`; returns cancel. Replaces setTimeout/clearTimeout. */
  after(ms: number, fn: () => void): () => void;
  /** Run `tick` every `ms`; returns stop. Replaces setInterval. */
  every(ms: number, tick: () => void): () => void;
}
