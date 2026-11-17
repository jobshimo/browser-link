// The real `Clock` of the cdp-direct transport (design 3.1, slice 5b-1):
// `Date.now` and `setTimeout`, nothing else. Same name and
// shape as the extension's `adapters/system-clock.ts`, so the `perform*`
// handlers that pass it stay textually identical.
import type { Clock } from '../../generated/core/ports/clock.js';

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};
