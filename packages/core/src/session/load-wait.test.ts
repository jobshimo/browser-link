import { describe, expect, test } from 'vitest';
import { createManualClock, createMemoryPageInfo, definePageInfoContract } from '../index.js';
import { armLoadWait, tabLoadSignal, type LoadSignal, type TabUpdateSource } from './load-wait.js';

type Handler = (tabId: number, info: { status?: string }) => void;

function fakeSource(): TabUpdateSource & { emit: Handler; count: () => number } {
  const handlers = new Set<Handler>();
  return {
    add: (h) => void handlers.add(h),
    remove: (h) => void handlers.delete(h),
    emit: (id, info) => handlers.forEach((h) => h(id, info)),
    count: () => handlers.size,
  };
}

describe('armLoadWait on a tab load signal (extension)', () => {
  test('a page that completes before Page.navigate answers still resolves the wait', async () => {
    const source = fakeSource();
    // Armed first, as navigate does ...
    const wait = armLoadWait(tabLoadSignal(7, source), createManualClock(), 200);
    // ... then the page finishes loading while Page.navigate is in flight ...
    source.emit(7, { status: 'loading' });
    source.emit(7, { status: 'complete' });
    // ... and only afterwards does the caller await it.
    await expect(wait.done).resolves.toBeUndefined();
    expect(source.count()).toBe(0);
  });

  test('another tab completing does not resolve it; the timeout still reports', async () => {
    const source = fakeSource();
    const clock = createManualClock();
    const wait = armLoadWait(tabLoadSignal(7, source), clock, 30);
    source.emit(8, { status: 'complete' });
    await clock.advance(30);
    await expect(wait.done).rejects.toThrow('navigation timed out');
    expect(source.count()).toBe(0);
  });

  test('cancel releases the listener when the navigation itself failed', () => {
    const source = fakeSource();
    const wait = armLoadWait(tabLoadSignal(7, source), createManualClock(), 200);
    expect(source.count()).toBe(1);
    wait.cancel();
    expect(source.count()).toBe(0);
  });
});

describe('armLoadWait on an event signal (cdp-direct)', () => {
  function eventSignal(): { signal: LoadSignal; fire: () => void; count: () => number } {
    const listeners = new Set<() => void>();
    return {
      signal: (loaded) => {
        listeners.add(loaded);
        return () => listeners.delete(loaded);
      },
      fire: () => [...listeners].forEach((l) => l()),
      count: () => listeners.size,
    };
  }

  test('a second load event after the first is ignored', async () => {
    const events = eventSignal();
    const wait = armLoadWait(events.signal, createManualClock(), 200);
    events.fire();
    events.fire();
    await expect(wait.done).resolves.toBeUndefined();
    expect(events.count()).toBe(0);
  });

  test('after cancel neither a load nor the timeout settles it', async () => {
    const events = eventSignal();
    const clock = createManualClock();
    const wait = armLoadWait(events.signal, clock, 30);
    let settled = false;
    wait.done.then(
      () => (settled = true),
      () => (settled = true),
    );
    wait.cancel();
    events.fire();
    await clock.advance(100);
    expect(settled).toBe(false);
    expect(events.count()).toBe(0);
  });
});

describe('PageInfo contract over armLoadWait', () => {
  // A PageInfo whose load wait is the core one, like both adapters.
  for (const c of definePageInfoContract(() => {
    const clock = createManualClock();
    const source = fakeSource();
    const memory = createMemoryPageInfo({ url: 'https://t.test/', title: 'T' }, clock);
    return {
      page: {
        info: () => memory.info(),
        armLoadWait: (ms) => armLoadWait(tabLoadSignal(1, source), clock, ms),
      },
      expected: { url: 'https://t.test/', title: 'T' },
      completeLoad: () => source.emit(1, { status: 'complete' }),
      elapse: (ms) => clock.advance(ms),
    };
  })) {
    test(c.name, () => c.run());
  }
});
