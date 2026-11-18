// An in-memory `Windows` (the contract's fake, and the window tests'): `open`
// numbers windows from 1, `exists` rejects for one it does not hold, and
// `close` removes one and reports it to every `onClosed` listener.

import type { Windows, WindowSize } from '../src/app/windows.js';

export interface MemoryWindows extends Windows {
  /** The windows open now: id -> its url and size. */
  readonly opened: ReadonlyMap<number, { url: string; size: WindowSize }>;
  /** The ids `focus` was called with, in order. */
  readonly focused: readonly number[];
  /** Close a window, as the user would. */
  close(windowId: number): Promise<void>;
}

export function createMemoryWindows(): MemoryWindows {
  const windows = new Map<number, { url: string; size: WindowSize }>();
  const focused: number[] = [];
  const listeners: ((windowId: number) => void)[] = [];
  let next = 1;
  return {
    opened: windows,
    focused,
    open(url, size) {
      const id = next++;
      windows.set(id, { url, size });
      return Promise.resolve(id);
    },
    focus(windowId) {
      focused.push(windowId);
      return Promise.resolve();
    },
    exists(windowId) {
      return windows.has(windowId)
        ? Promise.resolve(true)
        : Promise.reject(new Error(`No window with id: ${String(windowId)}.`));
    },
    onClosed(listener) {
      listeners.push(listener);
    },
    close(windowId) {
      if (windows.delete(windowId)) for (const listener of listeners) listener(windowId);
      return Promise.resolve();
    },
  };
}
