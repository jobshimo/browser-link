// What every `TabEvents` guarantees for its wake listeners (design 3.1;
// slice 21): a tab opened reports its id through `onCreated`; closing it
// while a debugger is attached reports the tab through `onDebuggerDetach`
// and `onRemoved`. `get` and `onUpdated` are reached by the e2e's recording
// case, and `onCreated`'s opener by its `browser.wait_for_tab` case (a tab
// `chrome.tabs.create` opens with an `openerTabId` is reported without it).
// It runs against the in-memory fake under vitest
// (`src/app/extension-contracts.test.ts`) and against the real adapter inside
// the service worker (`entry.ts`, run by the e2e; R6). The product's own
// listeners ignore the tab: it has no opener and no connection to tear down.
// The tab is closed in a `finally`, on failure too.

import { type ContractCase, equal } from '@browser-link/core';
import type { CreatedTab, TabEvents } from '../src/app/tab-events.js';

/** A tab the harness opened, and its closer; closing twice closes once. */
export interface OpenedTab {
  tabId: number;
  close(): Promise<void>;
}

export interface TabEventsHarness {
  tabEvents: TabEvents;
  /** Open a background tab. */
  openTab(): Promise<OpenedTab>;
  /** Attach a debugger session to the tab. */
  attachDebugger(tabId: number): Promise<void>;
  /** Let time pass until `done` resolves; reject when it has not after `timeoutMs`. */
  until(done: Promise<void>, timeoutMs: number): Promise<void>;
}

/** How long the contract waits for the reports. */
export const CONTRACT_TAB_TIMEOUT_MS = 10_000;

export function defineTabEventsContract(make: () => TabEventsHarness): ContractCase[] {
  return [
    {
      name: 'a tab opened reaches onCreated; its close reaches onDebuggerDetach and onRemoved',
      run: async () => {
        const { tabEvents, openTab, attachDebugger, until } = make();
        const created: CreatedTab[] = [];
        const removed: number[] = [];
        const detached: (number | undefined)[] = [];
        let tab: number | undefined;
        let settled = (): void => undefined;
        const done = new Promise<void>((resolve) => {
          settled = resolve;
        });
        const check = (): void => {
          const reported =
            created.some((t) => t.tabId === tab) &&
            removed.includes(tab ?? -1) &&
            detached.length > 0;
          if (reported) settled();
        };
        tabEvents.onCreated((t) => {
          created.push(t);
          check();
        });
        tabEvents.onRemoved((tabId) => {
          if (tabId !== tab) return;
          removed.push(tabId);
          check();
        });
        tabEvents.onDebuggerDetach((tabId) => {
          if (tabId !== tab) return;
          detached.push(tabId);
          check();
        });
        const opened = await openTab();
        tab = opened.tabId;
        try {
          await attachDebugger(tab);
          await opened.close();
          await until(done, CONTRACT_TAB_TIMEOUT_MS);
          equal(
            created.filter((t) => t.tabId === tab).map((t) => t.tabId),
            [tab],
            'created reports of the tab',
          );
          equal(detached, [tab], 'debugger detach reports');
          equal(removed, [tab], 'removed reports');
        } finally {
          // On failure too: the tab this case opened never outlives it.
          await opened.close();
        }
      },
    },
  ];
}
