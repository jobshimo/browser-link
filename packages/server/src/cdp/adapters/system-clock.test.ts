import { afterEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from './system-clock.js';

/** The real clock is the platform timers and nothing else. The extension's
 * `adapters/system-clock.test.ts` asserts the same of its original. */
describe('systemClock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('now reads Date.now', () => {
    vi.useFakeTimers({ now: 1_234 });
    expect(systemClock.now()).toBe(1_234);
  });

  it('sleep resolves after ms, not before', async () => {
    vi.useFakeTimers();
    let done = false;
    const pending = systemClock.sleep(100).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });

  it('after runs once, and its cancel stops it', async () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const cancelled = vi.fn();
    systemClock.after(50, fired);
    const cancel = systemClock.after(50, cancelled);
    cancel();
    await vi.advanceTimersByTimeAsync(200);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('every ticks each ms until stopped', async () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const stop = systemClock.every(10, tick);
    await vi.advanceTimersByTimeAsync(35);
    stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(tick).toHaveBeenCalledTimes(3);
  });
});
