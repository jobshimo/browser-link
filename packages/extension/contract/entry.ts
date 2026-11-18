// The in-worker contract run (design section 8, R6, primary path; slice 19).
// A test-only IIFE bundle (`build.mjs`) of the extension adapters' contracts
// against the real adapters, which the e2e evaluates in the extension's
// service worker and then calls `browserLinkContract()`. It holds the
// adapters and the contracts only, never `background.ts`, so a wake listener
// registered here (`Alarms.onFire`, `Windows.onClosed`, `Runtime.onMessage`,
// the `TabEvents` ones, `LocalSettingsStorage.onChanged`) is a second
// listener in a test script, not in the product bundle. Never shipped
// (`scripts/smoke-tarball.mjs`). To produce the events those listeners
// observe, the harness itself calls `chrome.windows.remove`,
// `chrome.tabs.create`/`remove`, `chrome.debugger.attach` and
// `chrome.storage.local.remove` (design revision 13); every window, tab and
// key a case creates is removed in a `finally`, on failure too, which
// `browserLinkContract({ probe: true })` lets the e2e check.

import { chromeAlarms } from '../src/adapters/chrome-alarms.js';
import { chromeRuntime } from '../src/adapters/chrome-runtime.js';
import { chromeTabEvents } from '../src/adapters/chrome-tab-events.js';
import { chromeWindows } from '../src/adapters/chrome-windows.js';
import { chromeSettings } from '../src/adapters/chrome-settings.js';
import type { ContractCase } from '@browser-link/core';
import { defineAlarmsContract } from './alarms.contract.js';
import { defineRuntimeContract } from './runtime.contract.js';
import { defineSettingsContract } from './settings.contract.js';
import { defineTabEventsContract, type OpenedTab } from './tab-events.contract.js';
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

/** A background tab on `url`; its `close` removes it once, however often called. */
async function openTab(url: string): Promise<OpenedTab> {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  if (tabId === undefined) throw new Error('chrome.tabs.create answered a tab without an id');
  let closed = false;
  return {
    tabId,
    close: async () => {
      if (closed) return;
      closed = true;
      await chrome.tabs.remove(tabId);
    },
  };
}

/** The error a teardown probe forces right after a case created what it must remove. */
const PROBE_FAILURE = 'teardown probe: forced failure';

const forcedFailure = (): Promise<never> => Promise.reject(new Error(PROBE_FAILURE));

/**
 * The contract cases. With `probe`, only the cases that create a window, a tab
 * or a storage key run, each failing on purpose right after it created it, so
 * the e2e can check through the browser that a failing case leaves nothing
 * behind.
 */
function contractCases(probe: boolean): ContractCase[] {
  return [
    ...(probe
      ? []
      : defineAlarmsContract(() => ({
          alarms: chromeAlarms,
          now: () => Date.now(),
          runId: () => crypto.randomUUID(),
          until: until('alarm'),
        }))),
    ...defineWindowsContract(() => ({
      windows: probe ? { ...chromeWindows, focus: forcedFailure } : chromeWindows,
      url: 'about:blank',
      close: (windowId) => chrome.windows.remove(windowId),
      until: until('window close report'),
    })),
    ...defineRuntimeContract(() => ({
      runtime: chromeRuntime,
      version: chrome.runtime.getManifest().version,
      openPage: async (url) => (await openTab(url)).close,
      until: probe ? forcedFailure : until('runtime message'),
    })).slice(probe ? 1 : 0),
    ...defineTabEventsContract(() => ({
      tabEvents: chromeTabEvents,
      openTab: () => openTab('about:blank'),
      attachDebugger: probe ? forcedFailure : (tabId) => chrome.debugger.attach({ tabId }, '1.3'),
      until: until('tab reports'),
    })),
    ...defineSettingsContract(() => ({
      storage: chromeSettings,
      runId: () => crypto.randomUUID(),
      remove: (key) => chrome.storage.local.remove(key),
      until: probe ? forcedFailure : until('storage change'),
    })),
  ];
}

async function browserLinkContract(options: { probe?: boolean } = {}): Promise<ContractResult[]> {
  const results: ContractResult[] = [];
  for (const contractCase of contractCases(options.probe === true)) {
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
