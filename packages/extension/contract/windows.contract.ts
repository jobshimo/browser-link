// What every `Windows` guarantees (design 3.1; slice 21): a window it opens
// exists and takes focus, closing it reports its id through `onClosed`, and
// afterwards `exists` rejects for it. It runs against the in-memory fake
// under vitest (`src/app/extension-contracts.test.ts`) and against the real
// `chrome.windows` adapter inside the service worker (`entry.ts`, run by the
// e2e; R6). The window is not one the product opened, so the product's own
// `onClosed` listeners ignore it.

import { type ContractCase, equal } from '@browser-link/core';
import type { Windows } from '../src/app/windows.js';

export interface WindowsHarness {
  windows: Windows;
  /** A page any window may show. */
  url: string;
  /** Close the window, as the user would. */
  close(windowId: number): Promise<void>;
  /** Let time pass until `done` resolves; reject when it has not after `timeoutMs`. */
  until(done: Promise<void>, timeoutMs: number): Promise<void>;
}

/** How long the contract waits for the close report. */
export const CONTRACT_WINDOW_TIMEOUT_MS = 10_000;

export function defineWindowsContract(make: () => WindowsHarness): ContractCase[] {
  return [
    {
      name: 'a window opened exists and takes focus; its close reaches onClosed, then exists rejects',
      run: async () => {
        const { windows, url, close, until } = make();
        const closed: number[] = [];
        let opened: number | undefined;
        let closeSeen = (): void => undefined;
        const done = new Promise<void>((resolve) => {
          closeSeen = resolve;
        });
        windows.onClosed((windowId) => {
          if (windowId !== opened) return;
          closed.push(windowId);
          closeSeen();
        });
        opened = await windows.open(url, { width: 400, height: 300 });
        if (opened === undefined) throw new Error('open answered no window');
        equal(await windows.exists(opened), true, 'exists after open');
        await windows.focus(opened);
        await close(opened);
        await until(done, CONTRACT_WINDOW_TIMEOUT_MS);
        equal(closed, [opened], 'closed windows');
        let rejected = false;
        try {
          await windows.exists(opened);
        } catch {
          rejected = true;
        }
        equal(rejected, true, 'exists rejects for a closed window');
      },
    },
  ];
}
