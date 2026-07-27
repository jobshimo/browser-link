import { describe, expect, test, vi } from 'vitest';
import {
  RECONNECT_DELAYS_MS,
  RECONNECT_STATE_TTL_MS,
  RECONNECT_STORAGE_PREFIX,
  createReconnectScheduler,
  isInvoluntaryClose,
  isReconnectStateFresh,
  parseStoredReconnectState,
  reconnectDelayMs,
  reconnectStorageKey,
  tabIdFromReconnectKey,
  type ReconnectAttemptResult,
} from './reconnect-policy.js';

/** Manual timer host so the scheduler's backoff runs deterministically and
 * the injectable-timer seam itself is exercised (no vi.useFakeTimers on the
 * global clock needed). */
function makeTimerHost() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; delayMs: number }>();
  return {
    pending,
    setTimer: (fn: () => void, delayMs: number): unknown => {
      const id = nextId++;
      pending.set(id, { fn, delayMs });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      pending.delete(handle as number);
    },
    /** Fire the single pending timer and return the delay it was armed
     * with. Throws when zero or multiple timers are pending — every test
     * expects exactly one at a time (per-tab backoff, no thundering herd). */
    async fireOnly(): Promise<number> {
      const entries = [...pending.entries()];
      if (entries.length !== 1) {
        throw new Error(`expected exactly 1 pending timer, found ${entries.length}`);
      }
      const [id, { fn, delayMs }] = entries[0];
      pending.delete(id);
      fn();
      // Let the async fire() continuation (attempt + re-arm) settle.
      await Promise.resolve();
      await Promise.resolve();
      return delayMs;
    },
  };
}

function makeScheduler(
  results: ReconnectAttemptResult[],
  overrides: { delaysMs?: readonly number[] } = {},
) {
  const timers = makeTimerHost();
  const attempts: number[] = [];
  const stateChanges: [number, { attempt: number } | null][] = [];
  const scheduler = createReconnectScheduler({
    attempt: (tabId) => {
      attempts.push(tabId);
      const next = results.shift();
      if (!next) throw new Error('unexpected extra attempt');
      return Promise.resolve(next);
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onStateChange: (tabId, state) => {
      stateChanges.push([tabId, state]);
    },
    ...overrides,
  });
  return { scheduler, timers, attempts, stateChanges };
}

describe('isInvoluntaryClose', () => {
  test('an unclean close of a tracked, registered connection is involuntary', () => {
    expect(isInvoluntaryClose({ tracked: true, registered: true, wasClean: false })).toBe(true);
  });

  test('extension-initiated teardown (cleanup ran first, socket untracked) is not', () => {
    // Explicit disconnect, tab removal, idle park, debugger detach — all
    // delete the TabState before the close event dispatches.
    expect(isInvoluntaryClose({ tracked: false, registered: true, wasClean: false })).toBe(false);
  });

  test('a pre-registration close is a connect failure, not a drop to recover', () => {
    expect(isInvoluntaryClose({ tracked: true, registered: false, wasClean: false })).toBe(false);
  });

  test('a clean close (server said goodbye deliberately, e.g. browser.reset) is not', () => {
    expect(isInvoluntaryClose({ tracked: true, registered: true, wasClean: true })).toBe(false);
  });
});

describe('reconnectDelayMs', () => {
  test('walks the backoff schedule in order', () => {
    RECONNECT_DELAYS_MS.forEach((delay, attempt) => {
      expect(reconnectDelayMs(attempt)).toBe(delay);
    });
  });

  test('undefined once the budget is exhausted', () => {
    expect(reconnectDelayMs(RECONNECT_DELAYS_MS.length)).toBeUndefined();
    expect(reconnectDelayMs(999)).toBeUndefined();
  });

  test('undefined for malformed attempt indices', () => {
    expect(reconnectDelayMs(-1)).toBeUndefined();
    expect(reconnectDelayMs(1.5)).toBeUndefined();
  });

  test('schedule is 1s/2s/4s/8s — sized for a primary restarting within seconds', () => {
    expect(RECONNECT_DELAYS_MS).toEqual([1000, 2000, 4000, 8000]);
  });
});

describe('createReconnectScheduler', () => {
  test('an involuntary drop schedules a retry for the SAME tab id (continuity)', async () => {
    const { scheduler, timers, attempts } = makeScheduler(['connected']);
    expect(scheduler.schedule(42)).toBe(true);
    expect(scheduler.isPending(42)).toBe(true);
    const delay = await timers.fireOnly();
    expect(delay).toBe(RECONNECT_DELAYS_MS[0]);
    // connectTab(42) re-reads the preserved prevTabId:42 key itself — the
    // scheduler's job is to hand back the same Chrome tab id.
    expect(attempts).toEqual([42]);
    expect(scheduler.isPending(42)).toBe(false);
  });

  test('retries walk the full backoff sequence, then exhaustion stops cleanly', async () => {
    const { scheduler, timers, attempts, stateChanges } = makeScheduler([
      'retry',
      'retry',
      'retry',
      'retry',
    ]);
    scheduler.schedule(7);
    const delays: number[] = [];
    for (let i = 0; i < RECONNECT_DELAYS_MS.length; i++) {
      delays.push(await timers.fireOnly());
    }
    expect(delays).toEqual([...RECONNECT_DELAYS_MS]);
    expect(attempts).toEqual([7, 7, 7, 7]);
    // Budget exhausted: no timer left, cycle ended, state cleared.
    expect(timers.pending.size).toBe(0);
    expect(scheduler.isPending(7)).toBe(false);
    expect(stateChanges).toEqual([
      [7, { attempt: 0 }],
      [7, { attempt: 1 }],
      [7, { attempt: 2 }],
      [7, { attempt: 3 }],
      [7, null],
    ]);
  });

  test('success cancels the cycle — no further timers', async () => {
    const { scheduler, timers, stateChanges } = makeScheduler(['retry', 'connected']);
    scheduler.schedule(3);
    await timers.fireOnly();
    await timers.fireOnly();
    expect(timers.pending.size).toBe(0);
    expect(scheduler.isPending(3)).toBe(false);
    expect(stateChanges.at(-1)).toEqual([3, null]);
  });

  test('a "stop" outcome (tab gone) ends the cycle immediately', async () => {
    const { scheduler, timers } = makeScheduler(['stop']);
    scheduler.schedule(3);
    await timers.fireOnly();
    expect(timers.pending.size).toBe(0);
    expect(scheduler.isPending(3)).toBe(false);
  });

  test('scheduling while a cycle is pending is a no-op (per-tab backoff, no herd)', () => {
    const { scheduler, timers } = makeScheduler([]);
    expect(scheduler.schedule(5)).toBe(true);
    expect(scheduler.schedule(5)).toBe(false);
    expect(timers.pending.size).toBe(1);
  });

  test('independent tabs back off independently', () => {
    const { scheduler, timers } = makeScheduler([]);
    scheduler.schedule(1);
    scheduler.schedule(2);
    expect(timers.pending.size).toBe(2);
    expect(scheduler.isPending(1)).toBe(true);
    expect(scheduler.isPending(2)).toBe(true);
  });

  test('cancel clears the armed timer and the persisted state', () => {
    const { scheduler, timers, stateChanges } = makeScheduler([]);
    scheduler.schedule(9);
    expect(scheduler.cancel(9)).toBe(true);
    expect(timers.pending.size).toBe(0);
    expect(scheduler.isPending(9)).toBe(false);
    expect(stateChanges).toEqual([
      [9, { attempt: 0 }],
      [9, null],
    ]);
    // Nothing pending → nothing to cancel.
    expect(scheduler.cancel(9)).toBe(false);
  });

  test('cancel during an in-flight attempt prevents the re-arm', async () => {
    const timers = makeTimerHost();
    let resolveAttempt: ((r: ReconnectAttemptResult) => void) | undefined;
    const scheduler = createReconnectScheduler({
      attempt: () =>
        new Promise<ReconnectAttemptResult>((resolve) => {
          resolveAttempt = resolve;
        }),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.schedule(4);
    const entries = [...timers.pending.values()];
    timers.pending.clear();
    entries[0].fn(); // attempt now in flight, unresolved
    expect(scheduler.isPending(4)).toBe(true);
    scheduler.cancel(4);
    resolveAttempt?.('retry');
    await Promise.resolve();
    await Promise.resolve();
    expect(timers.pending.size).toBe(0);
    expect(scheduler.isPending(4)).toBe(false);
  });

  test('cancel from inside the attempt itself ends the cycle with a single notify', async () => {
    // connectTab's tab.registered handler cancels the cycle for its own
    // tab before the attempt promise resolves 'connected' — the cancel
    // must own the (only) end-of-cycle notification, and the resolving
    // attempt must neither re-arm nor notify again.
    const timers = makeTimerHost();
    const stateChanges: [number, { attempt: number } | null][] = [];
    let cancelSelf: () => void = () => undefined;
    const scheduler = createReconnectScheduler({
      attempt: () => {
        cancelSelf();
        return Promise.resolve('connected');
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      onStateChange: (tabId, state) => {
        stateChanges.push([tabId, state]);
      },
    });
    cancelSelf = () => {
      scheduler.cancel(12);
    };
    scheduler.schedule(12);
    await timers.fireOnly();
    expect(scheduler.isPending(12)).toBe(false);
    expect(timers.pending.size).toBe(0);
    expect(stateChanges).toEqual([
      [12, { attempt: 0 }],
      [12, null],
    ]);
  });

  test('a stale in-flight attempt cannot clobber a newly scheduled cycle', async () => {
    // cancel-then-reschedule while the old attempt is still awaited: the
    // stale attempt's result must be discarded (pending entry identity
    // check), leaving the fresh cycle's timer armed and untouched.
    const timers = makeTimerHost();
    let resolveAttempt: ((r: ReconnectAttemptResult) => void) | undefined;
    const scheduler = createReconnectScheduler({
      attempt: () =>
        new Promise<ReconnectAttemptResult>((resolve) => {
          resolveAttempt = resolve;
        }),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.schedule(4);
    const entries = [...timers.pending.values()];
    timers.pending.clear();
    entries[0].fn(); // old attempt now in flight, unresolved
    const resolveStale = resolveAttempt;
    scheduler.cancel(4);
    expect(scheduler.schedule(4)).toBe(true); // a fresh drop arrives
    resolveStale?.('retry');
    await Promise.resolve();
    await Promise.resolve();
    // The fresh cycle still has exactly its own attempt-0 timer armed —
    // the stale result neither re-armed a second timer nor tore it down.
    expect(timers.pending.size).toBe(1);
    expect(scheduler.isPending(4)).toBe(true);
    expect([...timers.pending.values()][0].delayMs).toBe(RECONNECT_DELAYS_MS[0]);
  });

  test('a rejecting attempt counts as a retry instead of stranding the cycle', async () => {
    const timers = makeTimerHost();
    let calls = 0;
    const scheduler = createReconnectScheduler({
      attempt: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('connected');
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.schedule(6);
    await timers.fireOnly();
    expect(scheduler.isPending(6)).toBe(true);
    const delay = await timers.fireOnly();
    expect(delay).toBe(RECONNECT_DELAYS_MS[1]);
    expect(scheduler.isPending(6)).toBe(false);
  });

  test('resuming from a persisted attempt replays that attempt delay', async () => {
    const { scheduler, timers } = makeScheduler(['connected']);
    expect(scheduler.schedule(8, 2)).toBe(true);
    const delay = await timers.fireOnly();
    expect(delay).toBe(RECONNECT_DELAYS_MS[2]);
  });

  test('resuming past the budget schedules nothing and clears state', () => {
    const { scheduler, timers, stateChanges } = makeScheduler([]);
    expect(scheduler.schedule(8, RECONNECT_DELAYS_MS.length)).toBe(false);
    expect(timers.pending.size).toBe(0);
    expect(scheduler.isPending(8)).toBe(false);
    expect(stateChanges).toEqual([[8, null]]);
  });

  test('falls back to real timers when none are injected', async () => {
    vi.useFakeTimers();
    try {
      const attempts: number[] = [];
      const scheduler = createReconnectScheduler({
        attempt: (tabId) => {
          attempts.push(tabId);
          return Promise.resolve('connected');
        },
        delaysMs: [50],
      });
      scheduler.schedule(11);
      await vi.advanceTimersByTimeAsync(50);
      expect(attempts).toEqual([11]);
      expect(scheduler.isPending(11)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reconnect storage keys + stored state', () => {
  test('key round-trips through tabIdFromReconnectKey', () => {
    expect(reconnectStorageKey(123)).toBe(`${RECONNECT_STORAGE_PREFIX}123`);
    expect(tabIdFromReconnectKey(reconnectStorageKey(123))).toBe(123);
  });

  test('foreign and malformed keys are rejected', () => {
    expect(tabIdFromReconnectKey('prevTabId:123')).toBeNull();
    expect(tabIdFromReconnectKey(`${RECONNECT_STORAGE_PREFIX}`)).toBeNull();
    expect(tabIdFromReconnectKey(`${RECONNECT_STORAGE_PREFIX}abc`)).toBeNull();
    expect(tabIdFromReconnectKey(`${RECONNECT_STORAGE_PREFIX}-1`)).toBeNull();
  });

  test('parseStoredReconnectState accepts the persisted shape', () => {
    expect(parseStoredReconnectState({ attempt: 2, updatedAt: 1000 })).toEqual({
      attempt: 2,
      updatedAt: 1000,
    });
  });

  test('parseStoredReconnectState rejects malformed values', () => {
    expect(parseStoredReconnectState(null)).toBeNull();
    expect(parseStoredReconnectState(undefined)).toBeNull();
    expect(parseStoredReconnectState('2')).toBeNull();
    expect(parseStoredReconnectState({})).toBeNull();
    expect(parseStoredReconnectState({ attempt: -1, updatedAt: 1000 })).toBeNull();
    expect(parseStoredReconnectState({ attempt: 1.5, updatedAt: 1000 })).toBeNull();
    expect(parseStoredReconnectState({ attempt: 1, updatedAt: Number.NaN })).toBeNull();
    expect(parseStoredReconnectState({ attempt: 1 })).toBeNull();
  });

  test('freshness window keeps recent entries and drops stale or future ones', () => {
    const NOW = 1_000_000_000;
    expect(isReconnectStateFresh(NOW - 1, NOW)).toBe(true);
    expect(isReconnectStateFresh(NOW, NOW)).toBe(true);
    expect(isReconnectStateFresh(NOW - RECONNECT_STATE_TTL_MS + 1, NOW)).toBe(true);
    expect(isReconnectStateFresh(NOW - RECONNECT_STATE_TTL_MS, NOW)).toBe(false);
    // Clock went backwards → err on the quiet side.
    expect(isReconnectStateFresh(NOW + 1, NOW)).toBe(false);
  });
});
