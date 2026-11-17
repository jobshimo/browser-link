import { describe, expect, test } from 'vitest';
import { armLoadWait, type TabUpdateSource } from './load-wait.js';

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

describe('armLoadWait', () => {
  test('a page that completes before Page.navigate answers still resolves the wait', async () => {
    const source = fakeSource();
    // Armed first, as handleNavigate does ...
    const wait = armLoadWait(7, source, 200);
    // ... then the page finishes loading while Page.navigate is in flight ...
    source.emit(7, { status: 'loading' });
    source.emit(7, { status: 'complete' });
    // ... and only afterwards does the caller await it.
    await expect(wait.done).resolves.toBeUndefined();
    expect(source.count()).toBe(0);
  });

  test('another tab completing does not resolve it; the timeout still reports', async () => {
    const source = fakeSource();
    const wait = armLoadWait(7, source, 30);
    source.emit(8, { status: 'complete' });
    await expect(wait.done).rejects.toThrow('navigation timed out');
    expect(source.count()).toBe(0);
  });

  test('cancel releases the listener when the navigation itself failed', () => {
    const source = fakeSource();
    const wait = armLoadWait(7, source, 200);
    expect(source.count()).toBe(1);
    wait.cancel();
    expect(source.count()).toBe(0);
  });
});
