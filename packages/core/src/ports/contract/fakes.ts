// In-memory fakes of the ports, for core's tests and the contract suite
// (condition 3 of R6). Pure: no timers, no globals; time moves only when a
// test advances the manual clock.

import type { CdpSession } from '../cdp-session.js';
import type { Clock } from '../clock.js';
import type { ContentSettings } from '../content-settings.js';
import type { Downloads } from '../downloads.js';
import type { PageInfo } from '../page-info.js';
import type { CaptureOutcome, CapturedDownload, LoadWait } from '../values.js';

export interface ManualClock extends Clock {
  /** Move time forward by `ms`, firing every timer that falls due, in order. */
  advance(ms: number): Promise<void>;
}

interface Timer {
  at: number;
  fn: () => void;
}

export function createManualClock(start = 0): ManualClock {
  let now = start;
  let timers: Timer[] = [];
  const after = (ms: number, fn: () => void): (() => void) => {
    const timer = { at: now + ms, fn };
    timers.push(timer);
    return () => {
      timers = timers.filter((t) => t !== timer);
    };
  };
  return {
    now: () => now,
    sleep: (ms) =>
      new Promise((resolve) => {
        after(ms, resolve);
      }),
    after,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = timers
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at)
          .at(0);
        if (due === undefined) break;
        now = due.at;
        timers = timers.filter((t) => t !== due);
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
  /** Report load complete: every armed load wait resolves. */
  completeLoad(): void;
}

export function createMemoryPageInfo(
  page: { url: string; title: string },
  clock: Clock,
): MemoryPageInfo {
  const waiters = new Set<() => void>();
  return {
    info: () => Promise.resolve({ ...page }),
    armLoadWait(timeoutMs): LoadWait {
      let release = (): void => undefined;
      const done = new Promise<void>((resolve, reject) => {
        const loaded = (): void => {
          release();
          resolve();
        };
        const cancelTimer = clock.after(timeoutMs, () => {
          release();
          reject(new Error('navigation timed out'));
        });
        release = () => {
          cancelTimer();
          waiters.delete(loaded);
        };
        waiters.add(loaded);
      });
      done.catch(() => undefined);
      return {
        done,
        cancel: () => {
          release();
        },
      };
    },
    completeLoad() {
      for (const loaded of [...waiters]) loaded();
    },
  };
}

/** A `CdpSession` that counts its current listeners, for contracts that
 * check a subscriber unsubscribed. Passes every call through unchanged. */
export function countingSession(session: CdpSession): CdpSession & { listening(): number } {
  let count = 0;
  return {
    send: <T>(method: string, params?: Record<string, unknown>) => session.send<T>(method, params),
    onEvent(listener) {
      const off = session.onEvent(listener);
      count += 1;
      let done = false;
      return () => {
        if (!done) {
          done = true;
          count -= 1;
        }
        off();
      };
    },
    listening: () => count,
  };
}

export interface MemoryContentSettings extends ContentSettings {
  /** The value `setting` holds for `primaryPattern`. */
  read(setting: string, primaryPattern: string): string | undefined;
}

/** `ContentSettings` over a map; a setting outside `known` is refused with
 * `refusal(setting)`, as a browser that does not expose it. */
export function createMemoryContentSettings(
  known: readonly string[],
  refusal: (setting: string) => string,
): MemoryContentSettings {
  const values = new Map<string, string>();
  return {
    set(setting, primaryPattern, value) {
      if (!known.includes(setting)) return Promise.reject(new Error(refusal(setting)));
      values.set(`${setting} ${primaryPattern}`, value);
      return Promise.resolve();
    },
    read: (setting, primaryPattern) => values.get(`${setting} ${primaryPattern}`),
  };
}

export interface MemoryDownloads extends Downloads {
  /** Start a download the tab reports, while a capture waits: it is held. */
  start(download: CapturedDownload): void;
}

/** `Downloads` on a clock: one capture waits at a time; a held download is
 * settled once, `removed` when saved, `left_in_chrome` otherwise. */
export function createMemoryDownloads(clock: Clock): MemoryDownloads {
  let waiting: ((outcome: CaptureOutcome) => void) | null = null;
  const held = new Set<number>();
  return {
    async captureAround({ timeoutMs }, act) {
      if (waiting) throw new Error('download: another capture is waiting');
      let finish: (outcome: CaptureOutcome) => void = () => undefined;
      const result = new Promise<CaptureOutcome>((resolve) => {
        finish = resolve;
      });
      const cancel = clock.after(timeoutMs, () => {
        waiting = null;
        finish({ state: 'timeout' });
      });
      waiting = (outcome) => {
        cancel();
        waiting = null;
        finish(outcome);
      };
      const acted = await act();
      if (!acted.ok) {
        cancel();
        waiting = null;
        return acted;
      }
      return { ok: true, outcome: await result };
    },
    settle(downloadId, saved) {
      if (!held.delete(downloadId)) return Promise.resolve('not_held');
      return Promise.resolve(saved ? 'removed' : 'left_in_chrome');
    },
    start(download) {
      if (!waiting) return;
      held.add(download.download_id);
      waiting({ state: 'captured', download });
    },
  };
}
