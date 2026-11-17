// All time in core goes through this port (5.1 of the design). The flow
// engine and expect take it (slices 5b-1, 7, 8); the real clocks are the
// transports' `system-clock.ts` adapters.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Run `fn` once after `ms`; returns cancel. Replaces setTimeout/clearTimeout. */
  after(ms: number, fn: () => void): () => void;
}
