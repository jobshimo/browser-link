import { describe, expect, test, vi } from 'vitest';
import {
  createDownloadCapture,
  type DeterminingItem,
  type DeterminingListener,
  type DownloadsApi,
} from './download-capture.js';

/** Minimal fake of the slice of `chrome.downloads` the capture uses. */
function fakeDownloads() {
  const listeners = new Set<DeterminingListener>();
  const api = {
    onDeterminingFilename: {
      addListener: vi.fn((fn: DeterminingListener) => {
        listeners.add(fn);
      }),
      removeListener: vi.fn((fn: DeterminingListener) => {
        listeners.delete(fn);
      }),
    },
    cancel: vi.fn(async () => undefined),
    erase: vi.fn(async () => [] as number[]),
  } satisfies DownloadsApi;
  /** Simulate Chrome starting a download: returns what each listener returned
   * plus the suggest spy. */
  const fire = (item: Partial<DeterminingItem> = {}) => {
    const suggest = vi.fn();
    const full: DeterminingItem = {
      id: 7,
      url: 'https://x.test/export',
      finalUrl: 'https://x.test/files/export.csv',
      filename: 'export.csv',
      mime: 'text/csv',
      ...item,
    };
    const returns = [...listeners].map((fn) => fn(full, suggest));
    return { suggest, returns };
  };
  return { api, fire, listenerCount: () => listeners.size };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createDownloadCapture', () => {
  test('captures the next download: cancels it before Chrome can prompt, erases it, reports it', async () => {
    const { api, fire, listenerCount } = fakeDownloads();
    const capture = createDownloadCapture(api);
    const armed = capture.arm(1000);
    expect(listenerCount()).toBe(1);

    const { suggest, returns } = fire();
    // Returning true keeps Chrome waiting on us (async suggest) so it cannot
    // advance to the "Save as" prompt while the cancel is in flight.
    expect(returns).toEqual([true]);

    await expect(armed.result).resolves.toEqual({
      url: 'https://x.test/files/export.csv',
      original_url: 'https://x.test/export',
      filename: 'export.csv',
      mime: 'text/csv',
    });
    await flush();
    expect(api.cancel).toHaveBeenCalledWith(7);
    expect(api.erase).toHaveBeenCalledWith({ id: 7 });
    // Suggest is only released AFTER the cancel landed.
    expect(suggest).toHaveBeenCalledOnce();
    expect(api.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      suggest.mock.invocationCallOrder[0],
    );
    expect(listenerCount()).toBe(0);
  });

  test('falls back to url when finalUrl is empty', async () => {
    const { api, fire } = fakeDownloads();
    const armed = createDownloadCapture(api).arm(1000);
    fire({ finalUrl: '' });
    await expect(armed.result).resolves.toMatchObject({ url: 'https://x.test/export' });
  });

  test('resolves null on timeout and unregisters the listener', async () => {
    vi.useFakeTimers();
    try {
      const { api, listenerCount } = fakeDownloads();
      const armed = createDownloadCapture(api).arm(500);
      vi.advanceTimersByTime(500);
      await expect(armed.result).resolves.toBeNull();
      expect(listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('disarm() resolves null and leaves later downloads alone', async () => {
    const { api, fire, listenerCount } = fakeDownloads();
    const armed = createDownloadCapture(api).arm(1000);
    armed.disarm();
    await expect(armed.result).resolves.toBeNull();
    expect(listenerCount()).toBe(0);
    fire();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  test('only one capture may be armed at a time', () => {
    const { api } = fakeDownloads();
    const capture = createDownloadCapture(api);
    capture.arm(1000);
    expect(() => capture.arm(1000)).toThrow(/already waiting/);
  });

  test('can be re-armed after a capture completes', async () => {
    const { api, fire } = fakeDownloads();
    const capture = createDownloadCapture(api);
    const first = capture.arm(1000);
    fire();
    await first.result;
    const second = capture.arm(1000);
    fire({ id: 8, filename: 'two.csv' });
    await expect(second.result).resolves.toMatchObject({ filename: 'two.csv' });
  });

  test('a failing cancel still releases Chrome (suggest called) and still reports the item', async () => {
    const { api, fire } = fakeDownloads();
    api.cancel.mockRejectedValueOnce(new Error('Download must be in progress'));
    const armed = createDownloadCapture(api).arm(1000);
    const { suggest } = fire();
    await expect(armed.result).resolves.toMatchObject({ filename: 'export.csv' });
    await flush();
    expect(suggest).toHaveBeenCalledOnce();
  });
});
