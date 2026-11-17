/**
 * A load wait that is armed BEFORE the navigation is sent.
 *
 * A fast page can reach `status: 'complete'` before `Page.navigate` resolves;
 * a listener added only after that call never sees the event and the tool
 * waits out its whole timeout. `cancel` releases the listener and timer when
 * the navigation itself fails.
 */

export interface TabUpdateSource {
  add(handler: (tabId: number, info: { status?: string }) => void): void;
  remove(handler: (tabId: number, info: { status?: string }) => void): void;
}

export function armLoadWait(
  tabId: number,
  source: TabUpdateSource,
  timeoutMs = 20_000,
): { done: Promise<void>; cancel: () => void } {
  let release: () => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    const handler = (updatedId: number, info: { status?: string }): void => {
      if (updatedId === tabId && info.status === 'complete') {
        release();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      release();
      reject(new Error('navigation timed out'));
    }, timeoutMs);
    release = () => {
      clearTimeout(timer);
      source.remove(handler);
    };
    source.add(handler);
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
