import { describe, expect, test, vi } from 'vitest';
import {
  captureAround,
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

  test('with an origin, a download whose referrer is another origin is left alone', async () => {
    const { api, fire, listenerCount } = fakeDownloads();
    const armed = createDownloadCapture(api).arm(1000, 'https://app.test');
    const { returns, suggest } = fire({ referrer: 'https://elsewhere.test/page' });
    expect(returns).toEqual([undefined]);
    expect(suggest).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(1); // still waiting for the right one
    fire({ id: 9, referrer: 'https://app.test/reports', filename: 'mine.csv' });
    await expect(armed.result).resolves.toMatchObject({ filename: 'mine.csv' });
  });

  test('with an origin, a blob: download of that origin matches even without a referrer', async () => {
    const { api, fire } = fakeDownloads();
    const armed = createDownloadCapture(api).arm(1000, 'https://app.test');
    fire({ referrer: '', url: 'blob:https://other.test/1', finalUrl: '' });
    expect(api.cancel).not.toHaveBeenCalled();
    fire({ id: 9, referrer: '', url: 'blob:https://app.test/2', finalUrl: '' });
    await expect(armed.result).resolves.toMatchObject({ url: 'blob:https://app.test/2' });
  });

  test('with an origin, a download carrying no origin evidence is still taken (cannot tell)', async () => {
    const { api, fire } = fakeDownloads();
    const armed = createDownloadCapture(api).arm(1000, 'https://app.test');
    fire({ referrer: '', url: 'https://cdn.test/f.zip' });
    await expect(armed.result).resolves.toMatchObject({ url: 'https://x.test/files/export.csv' });
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

describe('captureAround', () => {
  test('a click that throws disarms the capture and rethrows', async () => {
    const { api, listenerCount, fire } = fakeDownloads();
    const capture = createDownloadCapture(api);
    await expect(
      captureAround(capture, { timeoutMs: 1000 }, async () => {
        throw new Error('Debugger is not attached');
      }),
    ).rejects.toThrow(/not attached/);
    expect(listenerCount()).toBe(0);
    fire();
    expect(api.cancel).not.toHaveBeenCalled();
    // and the worker-wide capture is free again
    expect(() => capture.arm(1000).disarm()).not.toThrow();
  });

  test('a click that reports failure disarms and returns the error', async () => {
    const { api, listenerCount } = fakeDownloads();
    const out = await captureAround(createDownloadCapture(api), { timeoutMs: 1000 }, async () => ({
      ok: false as const,
      error: 'Element not found: #x',
    }));
    expect(out).toEqual({ ok: false, error: 'Element not found: #x' });
    expect(listenerCount()).toBe(0);
  });

  test('a successful click waits for the capture, armed with the origin', async () => {
    const { api, fire } = fakeDownloads();
    const pending = captureAround(
      createDownloadCapture(api),
      { timeoutMs: 1000, origin: 'https://app.test' },
      async () => {
        fire({ referrer: 'https://elsewhere.test/' });
        fire({ id: 2, referrer: 'https://app.test/', filename: 'ok.csv' });
        return { ok: true as const };
      },
    );
    await expect(pending).resolves.toMatchObject({
      ok: true,
      captured: { filename: 'ok.csv' },
    });
  });
});
