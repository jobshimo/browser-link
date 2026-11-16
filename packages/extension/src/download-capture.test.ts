import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  attributedSignal,
  captureAround,
  createDownloadCapture,
  type DeterminingItem,
  type DeterminingListener,
  type DownloadsApi,
  type TabDownloadSignals,
} from './download-capture.js';

/** Minimal fake of the slice of `chrome.downloads` the capture uses. Every
 * call made on it lands in `calls`, in order, so tests assert the whole
 * sequence (and the absence of calls on an unrelated download). */
function fakeDownloads() {
  const listeners = new Set<DeterminingListener>();
  const calls: string[] = [];
  const api = {
    onDeterminingFilename: {
      addListener: vi.fn((fn: DeterminingListener) => {
        calls.push('addListener');
        listeners.add(fn);
      }),
      removeListener: vi.fn((fn: DeterminingListener) => {
        calls.push('removeListener');
        listeners.delete(fn);
      }),
    },
    cancel: vi.fn(async (id: number) => {
      calls.push(`cancel ${id}`);
    }),
    erase: vi.fn(async (q: { id: number }) => {
      calls.push(`erase ${q.id}`);
      return [q.id];
    }),
  } satisfies DownloadsApi;
  /** Simulate Chrome starting a download: returns what each listener returned
   * plus the suggest spy (whose calls also land in `calls`). */
  const fire = (item: Partial<DeterminingItem> = {}) => {
    const full: DeterminingItem = {
      id: 7,
      url: 'https://x.test/export',
      finalUrl: 'https://x.test/files/export.csv',
      filename: 'export.csv',
      mime: 'text/csv',
      ...item,
    };
    const suggest = vi.fn(() => {
      calls.push(`suggest ${full.id}`);
    });
    const returns = [...listeners].map((fn) => fn(full, suggest));
    return { suggest, returns };
  };
  return { api, fire, calls, listenerCount: () => listeners.size };
}

/** Fake of the clicked tab's debugger session: `report(url)` is Chrome
 * sending `Page.downloadWillBegin` on it. */
function fakeTab() {
  const subscribers = new Set<(url: string) => void>();
  const tab: TabDownloadSignals = {
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
  return {
    tab,
    report: (url: string) => {
      for (const fn of subscribers) fn(url);
    },
    subscriberCount: () => subscribers.size,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** The tab's own download: what the default `fire()` item is. */
const TAB_URL = 'https://x.test/export';

function setup() {
  const downloads = fakeDownloads();
  const tab = fakeTab();
  const capture = createDownloadCapture(downloads.api);
  const arm = (timeoutMs = 1000, holdMs = 60_000) =>
    capture.arm({ timeoutMs, holdMs, tab: tab.tab });
  return { ...downloads, ...tab, capture, arm };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('attributedSignal', () => {
  const item: DeterminingItem = { id: 1, url: 'https://a.test/x', filename: 'x' };
  test('matches the url or the final url the tab reported', () => {
    expect(attributedSignal(item, ['https://a.test/x'])).toBe(0);
    expect(
      attributedSignal({ ...item, finalUrl: 'https://cdn.test/x' }, ['o', 'https://cdn.test/x']),
    ).toBe(1);
  });
  test('no report, or another url: not attributed', () => {
    expect(attributedSignal(item, [])).toBe(-1);
    expect(attributedSignal(item, ['https://a.test/y'])).toBe(-1);
  });
  test('a download an extension started is never the tab click', () => {
    expect(attributedSignal({ ...item, byExtensionId: 'abc' }, ['https://a.test/x'])).toBe(-1);
  });
});

describe('createDownloadCapture — attribution (principle 1)', () => {
  test('an attributed download is captured and held, nothing else is done to it yet', async () => {
    const { fire, report, calls, arm, subscriberCount } = setup();
    const armed = arm();
    report(TAB_URL);
    const { returns, suggest } = fire();
    // Returning true keeps Chrome waiting on us: no completion, no prompt.
    expect(returns).toEqual([true]);
    await expect(armed.result).resolves.toEqual({
      state: 'captured',
      download: {
        download_id: 7,
        url: 'https://x.test/files/export.csv',
        original_url: TAB_URL,
        filename: 'export.csv',
        mime: 'text/csv',
      },
    });
    await flush();
    expect(suggest).not.toHaveBeenCalled();
    // The listener stays while the download is held.
    expect(calls).toEqual(['addListener']);
    expect(subscriberCount()).toBe(0);
  });

  test('an unattributed download during the window is never held, cancelled or erased, and the capture fails', async () => {
    vi.useFakeTimers();
    const { fire, calls, arm } = setup();
    const armed = arm(500);
    // The user's own download, no referrer, while the agent's click waits.
    const { returns, suggest } = fire({
      id: 99,
      url: 'https://cdn.test/users-own.zip',
      finalUrl: '',
    });
    expect(returns).toEqual([undefined]);
    vi.advanceTimersByTime(500);
    await expect(armed.result).resolves.toEqual({ state: 'unattributed' });
    expect(suggest).not.toHaveBeenCalled(); // Chrome calls it for us
    expect(calls).toEqual(['addListener', 'removeListener']);
  });

  test('two downloads in the window, one attributable: only that one is taken', async () => {
    const { fire, report, calls, arm, capture } = setup();
    const armed = arm();
    const users = fire({ id: 99, url: 'https://cdn.test/users-own.zip', finalUrl: '' });
    report(TAB_URL);
    const tabs = fire({ id: 7 });
    expect(users.returns).toEqual([undefined]);
    expect(tabs.returns).toEqual([true]);
    await expect(armed.result).resolves.toMatchObject({
      state: 'captured',
      download: { download_id: 7 },
    });
    await expect(capture.settle(7, true)).resolves.toBe('removed');
    expect(calls).toEqual(['addListener', 'cancel 7', 'erase 7', 'suggest 7', 'removeListener']);
    expect(users.suggest).not.toHaveBeenCalled();
  });

  test('a download an extension started is left alone even with the same url', async () => {
    vi.useFakeTimers();
    const { fire, report, calls, arm } = setup();
    const armed = arm(500);
    report(TAB_URL);
    const { returns } = fire({ byExtensionId: 'other-extension' });
    expect(returns).toEqual([undefined]);
    vi.advanceTimersByTime(500);
    await expect(armed.result).resolves.toEqual({ state: 'unattributed' });
    expect(calls).toEqual(['addListener', 'removeListener']);
  });

  test('the tab report arriving after Chrome showed the download: it was let go, the capture fails at once', async () => {
    const { fire, report, calls, arm } = setup();
    const armed = arm();
    const { returns } = fire();
    expect(returns).toEqual([undefined]);
    report(TAB_URL);
    await expect(armed.result).resolves.toEqual({ state: 'unattributed' });
    expect(calls).toEqual(['addListener', 'removeListener']);
  });

  test('the same url seen twice in the window cannot be told apart: the second is not taken', async () => {
    vi.useFakeTimers();
    const { fire, report, calls, arm } = setup();
    const armed = arm(500);
    fire({ id: 99 }); // same URL, before the tab reported anything
    report(TAB_URL); // -> fails at once: the report could be the first one's
    await expect(armed.result).resolves.toEqual({ state: 'unattributed' });
    expect(calls).toEqual(['addListener', 'removeListener']);
  });

  test('nothing in Chrome during the wait: timeout, listener and tab subscription removed', async () => {
    vi.useFakeTimers();
    const { calls, arm, subscriberCount } = setup();
    const armed = arm(500);
    vi.advanceTimersByTime(500);
    await expect(armed.result).resolves.toEqual({ state: 'timeout' });
    expect(calls).toEqual(['addListener', 'removeListener']);
    expect(subscriberCount()).toBe(0);
  });

  test('disarm() ends the wait and leaves later downloads alone', async () => {
    const { fire, report, calls, arm } = setup();
    const armed = arm();
    armed.disarm();
    await expect(armed.result).resolves.toEqual({ state: 'timeout' });
    report(TAB_URL);
    fire();
    expect(calls).toEqual(['addListener', 'removeListener']);
  });

  test('only one capture may wait at a time', () => {
    const { arm } = setup();
    arm();
    expect(() => arm()).toThrow(/already waiting/);
  });

  test('a new capture may wait while an earlier download is still held, with one listener', async () => {
    const { fire, report, calls, arm, capture } = setup();
    const first = arm();
    report(TAB_URL);
    fire();
    await first.result;
    const second = arm();
    report('https://x.test/two');
    fire({ id: 8, url: 'https://x.test/two', finalUrl: '', filename: 'two.csv' });
    await expect(second.result).resolves.toMatchObject({
      download: { download_id: 8, filename: 'two.csv' },
    });
    await capture.settle(7, false);
    await capture.settle(8, false);
    expect(calls).toEqual(['addListener', 'suggest 7', 'suggest 8', 'removeListener']);
  });
});

describe('createDownloadCapture — settle (principle 2)', () => {
  async function captured() {
    const s = setup();
    const armed = s.arm();
    s.report(TAB_URL);
    const fired = s.fire();
    await armed.result;
    return { ...s, ...fired };
  }

  test('saved: cancel, then erase, then release — nothing before the settle', async () => {
    const { capture, calls, suggest, listenerCount } = await captured();
    await flush();
    expect(calls).toEqual(['addListener']);
    await expect(capture.settle(7, true)).resolves.toBe('removed');
    expect(calls).toEqual(['addListener', 'cancel 7', 'erase 7', 'suggest 7', 'removeListener']);
    expect(suggest).toHaveBeenCalledOnce();
    expect(listenerCount()).toBe(0);
  });

  test('the fetch failed: the original is released untouched, Chrome finishes it', async () => {
    const { capture, calls, api } = await captured();
    await expect(capture.settle(7, false)).resolves.toBe('left_in_chrome');
    expect(calls).toEqual(['addListener', 'suggest 7', 'removeListener']);
    expect(api.cancel).not.toHaveBeenCalled();
    expect(api.erase).not.toHaveBeenCalled();
  });

  test('the write failed: same as a failed fetch, the original is untouched', async () => {
    // The server sends saved: false for any outcome without a written file.
    const { capture, calls } = await captured();
    await expect(capture.settle(7, false)).resolves.toBe('left_in_chrome');
    expect(calls).toEqual(['addListener', 'suggest 7', 'removeListener']);
  });

  test('a cancel that fails (the download already completed) erases nothing and releases', async () => {
    const { capture, calls, api } = await captured();
    api.cancel.mockRejectedValueOnce(new Error('Download must be in progress'));
    await expect(capture.settle(7, true)).resolves.toBe('left_in_chrome');
    expect(api.erase).not.toHaveBeenCalled();
    expect(calls).toEqual(['addListener', 'suggest 7', 'removeListener']);
  });

  test('an erase that fails after the cancel reports cancelled and still releases', async () => {
    const { capture, calls, api } = await captured();
    api.erase.mockRejectedValueOnce(new Error('nope'));
    await expect(capture.settle(7, true)).resolves.toBe('cancelled');
    expect(calls).toEqual(['addListener', 'cancel 7', 'suggest 7', 'removeListener']);
  });

  test('a hold nobody settles is released untouched at holdMs; a late settle touches nothing', async () => {
    vi.useFakeTimers();
    const s = setup();
    const armed = s.arm(1000, 5000);
    s.report(TAB_URL);
    s.fire();
    await armed.result;
    vi.advanceTimersByTime(5000);
    expect(s.calls).toEqual(['addListener', 'suggest 7', 'removeListener']);
    // Released, so Chrome may have completed it: the late "saved" must not cancel or erase.
    await expect(s.capture.settle(7, true)).resolves.toBe('not_held');
    expect(s.calls).toEqual(['addListener', 'suggest 7', 'removeListener']);
  });

  test('a second settle of the same id answers not_held and touches nothing', async () => {
    const { capture, calls, api } = await captured();
    await expect(capture.settle(7, true)).resolves.toBe('removed');
    const before = [...calls];
    await expect(capture.settle(7, true)).resolves.toBe('not_held');
    await expect(capture.settle(7, false)).resolves.toBe('not_held');
    expect(calls).toEqual(before);
    expect(api.cancel).toHaveBeenCalledOnce();
  });

  test('another download with the held url appears: the held one is never cancelled', async () => {
    const { capture, calls, fire } = await captured();
    const other = fire({ id: 12 });
    expect(other.returns).toEqual([undefined]);
    await expect(capture.settle(7, true)).resolves.toBe('left_in_chrome');
    expect(calls).toEqual(['addListener', 'suggest 7', 'removeListener']);
  });

  test('settling an id that was never held touches nothing', async () => {
    const { capture, calls } = setup();
    await expect(capture.settle(42, true)).resolves.toBe('not_held');
    expect(calls).toEqual([]);
  });

  test('a suggest that throws (download gone) is swallowed', async () => {
    const s = setup();
    const armed = s.arm();
    s.report(TAB_URL);
    const { suggest } = s.fire();
    suggest.mockImplementation(() => {
      throw new Error('gone');
    });
    await armed.result;
    await expect(s.capture.settle(7, false)).resolves.toBe('left_in_chrome');
  });
});

describe('captureAround', () => {
  const opts = (tab: TabDownloadSignals) => ({ timeoutMs: 1000, holdMs: 60_000, tab });

  test('a click that throws disarms the capture and rethrows', async () => {
    const { capture, tab, calls, fire, report } = setup();
    await expect(
      captureAround(capture, opts(tab), async () => {
        throw new Error('Debugger is not attached');
      }),
    ).rejects.toThrow(/not attached/);
    report(TAB_URL);
    fire();
    expect(calls).toEqual(['addListener', 'removeListener']);
    // and the worker-wide capture is free again
    expect(() => capture.arm(opts(tab)).disarm()).not.toThrow();
  });

  test('a click that reports failure disarms and returns the error', async () => {
    const { capture, tab, listenerCount } = setup();
    const out = await captureAround(capture, opts(tab), async () => ({
      ok: false as const,
      error: 'Element not found: #x',
    }));
    expect(out).toEqual({ ok: false, error: 'Element not found: #x' });
    expect(listenerCount()).toBe(0);
  });

  test('a successful click waits for the tab download it started', async () => {
    const { capture, tab, fire, report } = setup();
    const pending = captureAround(capture, opts(tab), async () => {
      fire({ id: 1, url: 'https://elsewhere.test/f', finalUrl: '' });
      report('https://x.test/ok');
      fire({ id: 2, url: 'https://x.test/ok', finalUrl: '', filename: 'ok.csv' });
      return { ok: true as const };
    });
    await expect(pending).resolves.toMatchObject({
      ok: true,
      outcome: { state: 'captured', download: { download_id: 2, filename: 'ok.csv' } },
    });
  });
});
