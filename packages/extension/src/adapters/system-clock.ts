// The real `Clock` (design 3.1, slice 5b-1): `Date.now`, `setTimeout`,
// `setInterval`, nothing else. The server's cdp-direct transport has the
// same adapter under the same name (`cdp/adapters/system-clock.ts`), so
// the `perform*` handlers that pass it stay textually identical.
import type { Clock } from '../clock.js';

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
  every: (ms, tick) => {
    const timer = setInterval(tick, ms);
    return () => {
      clearInterval(timer);
    };
  },
};
