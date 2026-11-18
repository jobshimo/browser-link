// An in-memory `Alarms` on a `Clock` (the contract's fake, and the
// connection tests'): `set` arms a timer for the time left, replacing one
// of the same name; `clear` disarms it.

import type { Clock } from '@browser-link/core';
import type { Alarms } from '../src/app/connection.js';

export interface MemoryAlarms extends Alarms {
  /** The alarms armed now: name -> the time it fires. */
  readonly armed: ReadonlyMap<string, number>;
}

export function createMemoryAlarms(clock: Clock): MemoryAlarms {
  const armed = new Map<string, number>();
  const cancels = new Map<string, () => void>();
  const listeners: ((name: string) => void)[] = [];
  const disarm = (name: string): void => {
    cancels.get(name)?.();
    cancels.delete(name);
    armed.delete(name);
  };
  return {
    armed,
    set(name, when) {
      disarm(name);
      armed.set(name, when);
      cancels.set(
        name,
        clock.after(Math.max(0, when - clock.now()), () => {
          cancels.delete(name);
          armed.delete(name);
          for (const listener of listeners) listener(name);
        }),
      );
      return Promise.resolve();
    },
    clear(name) {
      disarm(name);
      return Promise.resolve();
    },
    onFire(listener) {
      listeners.push(listener);
    },
  };
}
