// In-memory fakes of the ports, for core's tests and the contract suite
// (condition 3 of R6). Pure: no timers, no globals; time moves only when a
// test advances the manual clock.

import type { CdpSession } from '../cdp-session.js';
import type { Clock } from '../clock.js';
import type { PageInfo } from '../page-info.js';

export interface ManualClock extends Clock {
  /** Move time forward by `ms`, firing every timer that falls due, in order. */
  advance(ms: number): Promise<void>;
}

interface Timer {
  at: number;
  fn: () => void;
  every: number | null;
}

export function createManualClock(start = 0): ManualClock {
  let now = start;
  let timers: Timer[] = [];
  const schedule = (timer: Timer): (() => void) => {
    timers.push(timer);
    return () => {
      timers = timers.filter((t) => t !== timer);
    };
  };
  const after = (ms: number, fn: () => void): (() => void) =>
    schedule({ at: now + ms, fn, every: null });
  return {
    now: () => now,
    sleep: (ms) =>
      new Promise((resolve) => {
        after(ms, resolve);
      }),
    after,
    every: (ms, tick) => schedule({ at: now + ms, fn: tick, every: ms }),
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = timers
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at)
          .at(0);
        if (due === undefined) break;
        now = due.at;
        if (due.every === null) timers = timers.filter((t) => t !== due);
        else due.at += due.every;
        due.fn();
        await Promise.resolve();
      }
      now = target;
    },
  };
}

export interface MemoryCdpSession extends CdpSession {
  /** Deliver one event to every current listener. */
  emit(method: string, params?: unknown): void;
}

/**
 * A `CdpSession` answering from `handlers`. A handler that throws fails the
 * command with its message; an unknown method fails like Chrome does.
 */
export function createMemoryCdpSession(
  handlers: Record<string, (params: Record<string, unknown>) => unknown>,
): MemoryCdpSession {
  const listeners = new Set<(method: string, params: unknown) => void>();
  return {
    send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (!Object.hasOwn(handlers, method)) {
        return Promise.reject(new Error(`'${method}' wasn't found`));
      }
      const handler = handlers[method];
      try {
        return Promise.resolve(handler(params) as T);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
    onEvent(listener) {
      const own = (method: string, params: unknown): void => {
        listener(method, params);
      };
      listeners.add(own);
      return () => {
        listeners.delete(own);
      };
    },
    emit(method, params = {}) {
      for (const listener of [...listeners]) listener(method, params);
    },
  };
}

export interface MemoryPageInfo extends PageInfo {
  /** Report load complete: every pending `waitForLoad` resolves. */
  completeLoad(): void;
}

export function createMemoryPageInfo(
  page: { url: string; title: string },
  clock: Clock,
): MemoryPageInfo {
  const waiters = new Set<() => void>();
  return {
    info: () => Promise.resolve({ ...page }),
    waitForLoad: (timeoutMs) =>
      new Promise<void>((resolve, reject) => {
        const cancel = clock.after(timeoutMs, () => {
          waiters.delete(loaded);
          reject(new Error(`page did not finish loading within ${timeoutMs}ms`));
        });
        const loaded = (): void => {
          cancel();
          waiters.delete(loaded);
          resolve();
        };
        waiters.add(loaded);
      }),
    completeLoad() {
      for (const loaded of [...waiters]) loaded();
    },
  };
}
