// The in-worker contract run (design section 8, R6, primary path; slice 19).
// A test-only IIFE bundle (`build.mjs`) of the extension adapters' contracts
// against the real adapters, which the e2e evaluates in the extension's
// service worker and then calls `browserLinkContract()`. It holds the
// adapters and the contracts only, never `background.ts`, so a wake listener
// registered here (`Alarms.onFire`, `Windows.onClosed`, `Runtime.onMessage`,
// the `TabEvents` ones) is a second listener in a test script, not in the
// product bundle. Never shipped (`scripts/smoke-tarball.mjs`).

import { chromeAlarms } from '../src/adapters/chrome-alarms.js';
import { chromeRuntime } from '../src/adapters/chrome-runtime.js';
import { chromeTabEvents } from '../src/adapters/chrome-tab-events.js';
import { chromeWindows } from '../src/adapters/chrome-windows.js';
import { defineAlarmsContract } from './alarms.contract.js';
import { defineRuntimeContract } from './runtime.contract.js';
import { defineTabEventsContract } from './tab-events.contract.js';
import { defineWindowsContract } from './windows.contract.js';

export interface ContractResult {
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

/** Wait for `done`; reject naming `what` when it has not resolved after `timeoutMs`. */
function until(what: string): (done: Promise<void>, timeoutMs: number) => Promise<void> {
  return (done, timeoutMs) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no ${what} within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      void done.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
}

/** A background tab on `url`. */
async function openTab(url: string): Promise<number> {
  const tab = await chrome.tabs.create({ url, active: false });
  if (tab.id === undefined) throw new Error('chrome.tabs.create answered a tab without an id');
  return tab.id;
}

const cases = [
  ...defineAlarmsContract(() => ({
    alarms: chromeAlarms,
    now: () => Date.now(),
    runId: () => crypto.randomUUID(),
    until: until('alarm'),
  })),
  ...defineWindowsContract(() => ({
    windows: chromeWindows,
    url: 'about:blank',
    close: (windowId) => chrome.windows.remove(windowId),
    until: until('window close report'),
  })),
  ...defineRuntimeContract(() => ({
    runtime: chromeRuntime,
    version: chrome.runtime.getManifest().version,
    openPage: async (url) => {
      const tabId = await openTab(url);
      return () => chrome.tabs.remove(tabId);
    },
    until: until('runtime message'),
  })),
  ...defineTabEventsContract(() => ({
    tabEvents: chromeTabEvents,
    openTab: () => openTab('about:blank'),
    attachDebugger: (tabId) => chrome.debugger.attach({ tabId }, '1.3'),
    closeTab: (tabId) => chrome.tabs.remove(tabId),
    until: until('tab reports'),
  })),
];

async function browserLinkContract(): Promise<ContractResult[]> {
  const results: ContractResult[] = [];
  for (const contractCase of cases) {
    const started = Date.now();
    try {
      await contractCase.run();
      results.push({ name: contractCase.name, ok: true, ms: Date.now() - started });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ name: contractCase.name, ok: false, error, ms: Date.now() - started });
    }
  }
  return results;
}

(globalThis as { browserLinkContract?: typeof browserLinkContract }).browserLinkContract =
  browserLinkContract;
