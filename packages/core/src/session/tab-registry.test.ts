// TabRegistry's invariants (design section 4): create once, and the
// in-flight reservation, including concurrent connect attempts.
import { describe, expect, test } from 'vitest';
import { createManualClock } from '../ports/contract/index.js';
import { TAB_ALREADY_CONNECTED, TabRegistry } from './tab-registry.js';

describe('TabRegistry: create once', () => {
  test('commit makes the session live; a second session on the tab is refused', () => {
    const tabs = new TabRegistry<string>();
    const first = tabs.reserve(1)!;
    tabs.commit(first, 'a');
    tabs.release(first);
    expect(tabs.get(1)).toBe('a');
    const second = tabs.reserve(1)!;
    expect(() => tabs.commit(second, 'b')).toThrow(TAB_ALREADY_CONNECTED);
    tabs.release(second);
    expect(tabs.get(1)).toBe('a');
  });

  test('after remove the tab can be connected again', () => {
    const tabs = new TabRegistry<string>();
    const first = tabs.reserve(1)!;
    tabs.commit(first, 'a');
    tabs.release(first);
    expect(tabs.remove(1)).toBe('a');
    expect(tabs.remove(1)).toBeUndefined();
    const second = tabs.reserve(1)!;
    tabs.commit(second, 'b');
    expect(tabs.get(1)).toBe('b');
  });
});

describe('TabRegistry: in-flight reservation', () => {
  test('reserve answers null while a reservation of the tab is open; other tabs are free', () => {
    const tabs = new TabRegistry<string>();
    const r = tabs.reserve(1);
    expect(r).not.toBeNull();
    expect(tabs.reserve(1)).toBeNull();
    expect(tabs.reserve(2)).not.toBeNull();
    tabs.release(r!);
    expect(tabs.reserve(1)).not.toBeNull();
  });

  test('the hold lasts the whole attempt: a committed session is live while still reserved', () => {
    const tabs = new TabRegistry<string>();
    const r = tabs.reserve(1)!;
    expect(tabs.isReservedOrLive(1)).toBe(true);
    expect(tabs.has(1)).toBe(false);
    tabs.commit(r, 'a');
    expect(tabs.has(1)).toBe(true);
    expect(tabs.isReserved(1)).toBe(true);
    expect(tabs.reserve(1)).toBeNull();
    tabs.release(r);
    expect(tabs.isReserved(1)).toBe(false);
    expect(tabs.isReservedOrLive(1)).toBe(true);
    tabs.remove(1);
    expect(tabs.isReservedOrLive(1)).toBe(false);
  });

  test('commit at most once, and never after release (abort)', () => {
    const tabs = new TabRegistry<string>();
    const r = tabs.reserve(1)!;
    tabs.commit(r, 'a');
    expect(() => tabs.commit(r, 'b')).toThrow('already committed');
    tabs.release(r);
    const aborted = tabs.reserve(2)!;
    tabs.release(aborted);
    expect(() => tabs.commit(aborted, 'c')).toThrow('not open');
    expect(tabs.has(2)).toBe(false);
  });

  test('release is idempotent and never ends a newer reservation', () => {
    const tabs = new TabRegistry<string>();
    const old = tabs.reserve(1)!;
    tabs.release(old);
    const newer = tabs.reserve(1)!;
    tabs.release(old);
    expect(tabs.isReserved(1)).toBe(true);
    expect(() => tabs.commit(old, 'x')).toThrow('not open');
    tabs.commit(newer, 'y');
    expect(tabs.get(1)).toBe('y');
  });

  test('iteration lists the live sessions only', () => {
    const tabs = new TabRegistry<string>();
    const a = tabs.reserve(1)!;
    tabs.commit(a, 'a');
    tabs.reserve(2);
    expect([...tabs]).toEqual([[1, 'a']]);
    expect([...tabs.keys()]).toEqual([1]);
    expect([...tabs.values()]).toEqual(['a']);
    expect([...tabs.entries()]).toEqual([[1, 'a']]);
  });
});

describe('TabRegistry: concurrent connects', () => {
  /** The extension's connect shape: reserve, check create-once, wait for the
   * attach, commit, wait for the registration, release in `finally`. */
  function connector(tabs: TabRegistry<string>, clock: ReturnType<typeof createManualClock>) {
    let commits = 0;
    const connect = async (
      tabId: number,
      name: string,
      fail: 'none' | 'before-commit' | 'after-commit' = 'none',
    ): Promise<string> => {
      const r = tabs.reserve(tabId);
      if (!r) return 'in-progress';
      try {
        if (tabs.has(tabId)) return 'tab-already-connected';
        await clock.sleep(10); // attach
        if (fail === 'before-commit') throw new Error('attach failed');
        tabs.commit(r, name);
        commits++;
        await clock.sleep(10); // registration
        if (fail === 'after-commit') {
          tabs.remove(tabId);
          return 'failed';
        }
        return 'ok';
      } finally {
        tabs.release(r);
      }
    };
    return { connect, commits: () => commits };
  }

  test('a second connect while the first is in flight is refused, before and after its commit', async () => {
    const clock = createManualClock();
    const tabs = new TabRegistry<string>();
    const c = connector(tabs, clock);
    const first = c.connect(1, 'a');
    expect(await c.connect(1, 'b')).toBe('in-progress');
    await clock.advance(10);
    expect(tabs.get(1)).toBe('a');
    expect(await c.connect(1, 'b')).toBe('in-progress');
    await clock.advance(10);
    expect(await first).toBe('ok');
    expect(await c.connect(1, 'b')).toBe('tab-already-connected');
    expect(c.commits()).toBe(1);
  });

  test('reserve/abort race: an aborted attempt frees the tab for exactly one next connect', async () => {
    const clock = createManualClock();
    const tabs = new TabRegistry<string>();
    const c = connector(tabs, clock);
    const failing = c.connect(1, 'a', 'before-commit');
    const refused = c.connect(1, 'b');
    await clock.advance(10);
    await expect(failing).rejects.toThrow('attach failed');
    expect(await refused).toBe('in-progress');
    expect(tabs.isReservedOrLive(1)).toBe(false);
    // Two attempts racing right after the abort: one connects, the other is refused.
    const x = c.connect(1, 'x');
    const y = c.connect(1, 'y');
    await clock.advance(20);
    expect(await Promise.all([x, y])).toEqual(['ok', 'in-progress']);
    expect(tabs.get(1)).toBe('x');
    expect(c.commits()).toBe(1);
  });

  test('an attempt that fails after its commit holds the tab until it ends', async () => {
    const clock = createManualClock();
    const tabs = new TabRegistry<string>();
    const c = connector(tabs, clock);
    const failing = c.connect(1, 'a', 'after-commit');
    await clock.advance(10);
    await clock.advance(5);
    expect(await c.connect(1, 'b')).toBe('in-progress');
    await clock.advance(5);
    expect(await failing).toBe('failed');
    expect(tabs.isReservedOrLive(1)).toBe(false);
    const next = c.connect(1, 'b');
    await clock.advance(20);
    expect(await next).toBe('ok');
    expect(c.commits()).toBe(2);
  });
});
