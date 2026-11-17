/**
 * A load wait that is armed BEFORE the navigation is sent (the 1.3.4 fix),
 * behind both transports' `PageInfo.armLoadWait`.
 *
 * A fast page can report load complete before `Page.navigate` resolves; a
 * listener added only after that call never sees it and the tool waits out
 * its whole timeout. `cancel` releases the listener and timer when the
 * navigation itself fails; after it, `done` never settles.
 */
import type { Clock } from '../ports/clock.js';
import type { LoadWait } from '../ports/values.js';

/** How long `navigate` waits for the load, on both transports. */
export const NAVIGATE_LOAD_TIMEOUT_MS = 20_000;

/** Subscribe `loaded` to the page's load-complete signal; returns the
 * unsubscribe function. */
export type LoadSignal = (loaded: () => void) => () => void;

export function armLoadWait(signal: LoadSignal, clock: Clock, timeoutMs: number): LoadWait {
  let release: () => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    let settled = false;
    const unsubscribe = signal(() => {
      if (settled) return;
      settled = true;
      release();
      resolve();
    });
    const cancelTimer = clock.after(timeoutMs, () => {
      if (settled) return;
      settled = true;
      release();
      reject(new Error('navigation timed out'));
    });
    release = () => {
      cancelTimer();
      unsubscribe();
    };
  });
  // `done` is awaited only after Page.navigate answers; keep an early timeout
  // from surfacing as an unhandled rejection in between.
  done.catch(() => {});
  return {
    done,
    cancel: () => {
      release();
    },
  };
}

/** Where the extension hears tab updates (`chrome.tabs.onUpdated`). */
export interface TabUpdateSource {
  add(handler: (tabId: number, info: { status?: string }) => void): void;
  remove(handler: (tabId: number, info: { status?: string }) => void): void;
}

/** The extension's load signal: the tab reports `status: 'complete'`. */
export function tabLoadSignal(tabId: number, source: TabUpdateSource): LoadSignal {
  return (loaded) => {
    const handler = (updatedId: number, info: { status?: string }): void => {
      if (updatedId === tabId && info.status === 'complete') loaded();
    };
    source.add(handler);
    return () => {
      source.remove(handler);
    };
  };
}
