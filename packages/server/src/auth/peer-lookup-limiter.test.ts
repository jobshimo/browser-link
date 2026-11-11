import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  PEER_GATE_MAX_MS,
  PEER_LOOKUP_MAX_IN_FLIGHT,
  PEER_LOOKUP_MAX_WAIT_MS,
  PeerLookupLimiter,
  sharedPeerLookupLimiter,
} from './peer-lookup-limiter.js';
import { PEER_LOOKUP_DEADLINE_MS, type PeerLookupResult } from './process-identity.js';

const ACCEPTED: PeerLookupResult = { ok: true, peer: { pid: 4321, binaryName: 'chrome.exe' } };

/** A lookup that settles only when told to, recording the budget it got. */
function gatedLookup(): {
  lookup: ReturnType<typeof vi.fn<(budget: number) => Promise<PeerLookupResult>>>;
  release: (index: number, result?: PeerLookupResult) => void;
  fail: (index: number, err: Error) => void;
} {
  const settle: Array<{ resolve: (r: PeerLookupResult) => void; reject: (e: Error) => void }> = [];
  const lookup = vi.fn(
    (_budget: number) =>
      new Promise<PeerLookupResult>((resolve, reject) => settle.push({ resolve, reject })),
  );
  return {
    lookup,
    release: (i, result = ACCEPTED) => settle[i]?.resolve(result),
    fail: (i, err) => settle[i]?.reject(err),
  };
}

/** Let settled promises run their callbacks. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('PeerLookupLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('runs at most maxInFlight lookups at once; a waiter starts as soon as a slot frees', async () => {
    const limiter = new PeerLookupLimiter({ maxInFlight: 2, maxWaitMs: 1000, deadlineMs: 10_000 });
    const { lookup, release } = gatedLookup();
    const results = [limiter.run(lookup), limiter.run(lookup), limiter.run(lookup)];
    await flush();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(limiter.inFlightCount()).toBe(2);
    release(0);
    await flush();
    expect(lookup).toHaveBeenCalledTimes(3);
    release(1);
    release(2);
    expect(await Promise.all(results)).toEqual([ACCEPTED, ACCEPTED, ACCEPTED]);
    expect(limiter.inFlightCount()).toBe(0);
  });

  test('a connection with no slot within maxWaitMs is refused as lookup-busy, its lookup never run', async () => {
    const limiter = new PeerLookupLimiter({ maxInFlight: 1, maxWaitMs: 1000, deadlineMs: 10_000 });
    const { lookup, release } = gatedLookup();
    const first = limiter.run(lookup);
    const second = limiter.run(lookup);
    await vi.advanceTimersByTimeAsync(999);
    expect(lookup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toEqual({
      ok: false,
      cause: 'lookup-busy',
      detail: '1 lookup in flight, no slot free within 1000 ms',
    });
    release(0);
    expect(await first).toEqual(ACCEPTED);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('each lookup gets the total deadline as its budget', async () => {
    const limiter = new PeerLookupLimiter({ maxInFlight: 1, maxWaitMs: 1000, deadlineMs: 7000 });
    const { lookup, release } = gatedLookup();
    const done = limiter.run(lookup);
    release(0);
    await done;
    expect(lookup).toHaveBeenCalledWith(7000);
  });

  test('a lookup still running at the deadline is refused as deadline and frees its slot', async () => {
    const limiter = new PeerLookupLimiter({ maxInFlight: 1, maxWaitMs: 5000, deadlineMs: 3000 });
    const { lookup, release } = gatedLookup();
    const hung = limiter.run(lookup);
    const next = limiter.run(lookup);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await hung).toEqual({ ok: false, cause: 'deadline', detail: 'total budget 3000 ms' });
    expect(lookup).toHaveBeenCalledTimes(2);
    // The late answer of the hung lookup changes nothing.
    release(0);
    release(1);
    expect(await next).toEqual(ACCEPTED);
    expect(limiter.inFlightCount()).toBe(0);
  });

  test('a lookup that rejects passes the rejection on and frees its slot', async () => {
    const limiter = new PeerLookupLimiter({ maxInFlight: 1, maxWaitMs: 1000, deadlineMs: 10_000 });
    const { lookup, fail, release } = gatedLookup();
    const broken = limiter.run(lookup);
    const next = limiter.run(lookup);
    fail(0, new Error('lookup exploded'));
    await expect(broken).rejects.toThrow('lookup exploded');
    await flush();
    release(1);
    expect(await next).toEqual(ACCEPTED);
  });

  test('a lookup that throws synchronously rejects and frees its slot', async () => {
    const limiter = new PeerLookupLimiter({ maxInFlight: 1, maxWaitMs: 1000, deadlineMs: 10_000 });
    await expect(
      limiter.run(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(limiter.inFlightCount()).toBe(0);
  });

  test('waiters are served in arrival order', async () => {
    const limiter = new PeerLookupLimiter({ maxInFlight: 1, maxWaitMs: 1000, deadlineMs: 10_000 });
    const order: string[] = [];
    const { lookup, release } = gatedLookup();
    const a = limiter.run(lookup);
    const b = limiter.run(async () => {
      order.push('b');
      return ACCEPTED;
    });
    const c = limiter.run(async () => {
      order.push('c');
      return ACCEPTED;
    });
    release(0);
    await Promise.all([a, b, c]);
    expect(order).toEqual(['b', 'c']);
  });
});

describe('the shared limiter both ports use', () => {
  test('is small, waits briefly, and bounds a lookup by the lookup deadline', () => {
    expect(sharedPeerLookupLimiter.limits).toEqual({
      maxInFlight: PEER_LOOKUP_MAX_IN_FLIGHT,
      maxWaitMs: PEER_LOOKUP_MAX_WAIT_MS,
      deadlineMs: PEER_LOOKUP_DEADLINE_MS,
    });
    expect(PEER_LOOKUP_MAX_IN_FLIGHT).toBeLessThanOrEqual(8);
    expect(PEER_LOOKUP_MAX_WAIT_MS).toBeLessThanOrEqual(2000);
  });

  test('the gate decides within its wait plus the lookup deadline', () => {
    expect(PEER_GATE_MAX_MS).toBe(PEER_LOOKUP_MAX_WAIT_MS + PEER_LOOKUP_DEADLINE_MS);
  });
});
