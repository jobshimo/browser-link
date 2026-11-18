// The `Windows`, `Runtime`, `TabEvents` and `LocalSettingsStorage`
// contracts against their in-memory fakes (R6 condition 3), RED probes
// showing each catches a broken subject, and teardown probes showing a case
// that fails right after it created a window, a tab, a page or a key leaves
// none behind. The same contracts run against `adapters/chrome-windows.ts`,
// `chrome-runtime.ts`, `chrome-tab-events.ts` and `chrome-settings.ts`
// inside the real service worker (contract/entry.ts).
import { describe, expect, it } from 'vitest';
import type { ContractCase } from '@browser-link/core';
import { defineRuntimeContract, type RuntimeHarness } from '../../contract/runtime.contract.js';
import {
  defineTabEventsContract,
  type TabEventsHarness,
} from '../../contract/tab-events.contract.js';
import { defineWindowsContract, type WindowsHarness } from '../../contract/windows.contract.js';
import {
  CONTRACT_SETTINGS_PREFIX,
  defineSettingsContract,
  type SettingsHarness,
} from '../../contract/settings.contract.js';
import { createMemorySettings } from '../../contract/memory-settings.js';
import type { LocalSettingsStorage } from './settings-cache.js';
import { createMemoryRuntime } from '../../contract/memory-runtime.js';
import { createMemoryTabEvents } from '../../contract/memory-tab-events.js';
import { createMemoryWindows } from '../../contract/memory-windows.js';
import type { Runtime } from './popup-router.js';
import type { TabEvents } from './tab-events.js';
import type { Windows } from './windows.js';

/** Resolve when `done` has; the fakes report synchronously. */
async function until(done: Promise<void>, timeoutMs: number): Promise<void> {
  let resolved = false;
  void done.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  if (!resolved) throw new Error(`nothing within ${String(timeoutMs)} ms`);
}

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
}

const forcedFailure = (): Promise<never> => Promise.reject(new Error('forced failure'));

function windowsHarness(
  wrap: (w: Windows) => Windows = (w) => w,
  windows = createMemoryWindows(),
): WindowsHarness {
  return { windows: wrap(windows), url: 'about:blank', close: (id) => windows.close(id), until };
}

function runtimeHarness(
  wrap: (r: Runtime) => Runtime = (r) => r,
  pages = new Set<number>(),
  wait = until,
): RuntimeHarness {
  const runtime = createMemoryRuntime('1.2.3');
  let next = 0;
  return {
    runtime: wrap(runtime),
    version: '1.2.3',
    openPage: () => {
      const page = ++next;
      pages.add(page);
      void runtime.send({ action: 'versionCheck' });
      return Promise.resolve(() => {
        pages.delete(page);
        return Promise.resolve();
      });
    },
    until: wait,
  };
}

function tabEventsHarness(
  wrap: (t: TabEvents) => TabEvents = (t) => t,
  tabs = createMemoryTabEvents(),
  attach?: (tabId: number) => Promise<void>,
): TabEventsHarness {
  return {
    tabEvents: wrap(tabs),
    openTab: () => {
      const tabId = tabs.create({ url: 'about:blank' });
      return Promise.resolve({
        tabId,
        close: () => {
          tabs.close(tabId);
          return Promise.resolve();
        },
      });
    },
    attachDebugger:
      attach ??
      ((tabId) => {
        tabs.attachDebugger(tabId);
        return Promise.resolve();
      }),
    until,
  };
}

function settingsHarness(
  wrap: (s: LocalSettingsStorage) => LocalSettingsStorage = (s) => s,
  storage = createMemorySettings(),
  wait = until,
): SettingsHarness {
  let run = 0;
  return {
    storage: wrap(storage),
    runId: () => `run-${String(++run)}`,
    remove: (key) => storage.remove(key),
    until: wait,
  };
}

describe('Windows contract: in-memory fake', () => {
  run(defineWindowsContract(() => windowsHarness()));
});

describe('Runtime contract: in-memory fake', () => {
  run(defineRuntimeContract(() => runtimeHarness()));
});

describe('TabEvents contract: in-memory fake', () => {
  run(defineTabEventsContract(() => tabEventsHarness()));
});

describe('LocalSettingsStorage contract: in-memory fake', () => {
  run(defineSettingsContract(() => settingsHarness()));
});

describe('extension contracts: a failing case removes what it created', () => {
  it('Windows: the window it opened', async () => {
    const windows = createMemoryWindows();
    const [contractCase] = defineWindowsContract(() =>
      windowsHarness((w) => ({ ...w, focus: forcedFailure }), windows),
    );
    await expect(contractCase!.run()).rejects.toThrow('forced failure');
    expect(windows.opened.size).toBe(0);
  });

  it('Runtime: the page it opened', async () => {
    const pages = new Set<number>();
    const [, contractCase] = defineRuntimeContract(() =>
      runtimeHarness((r) => r, pages, forcedFailure),
    );
    await expect(contractCase!.run()).rejects.toThrow('forced failure');
    expect(pages.size).toBe(0);
  });

  it('TabEvents: the tab it opened', async () => {
    const tabs = createMemoryTabEvents();
    const [contractCase] = defineTabEventsContract(() =>
      tabEventsHarness((t) => t, tabs, forcedFailure),
    );
    await expect(contractCase!.run()).rejects.toThrow('forced failure');
    expect(tabs.tabs.size).toBe(0);
  });

  it('LocalSettingsStorage: the key it set', async () => {
    const storage = createMemorySettings();
    const [contractCase] = defineSettingsContract(() =>
      settingsHarness((st) => st, storage, forcedFailure),
    );
    await expect(contractCase!.run()).rejects.toThrow('forced failure');
    expect(
      [...storage.values.keys()].filter((k) => k.startsWith(CONTRACT_SETTINGS_PREFIX)),
    ).toEqual([]);
  });
});

describe('extension contracts: RED probes', () => {
  it('LocalSettingsStorage: fails a subject whose changes never reach onChanged', async () => {
    const [contractCase] = defineSettingsContract(() =>
      settingsHarness((st) => ({ ...st, onChanged: () => undefined })),
    );
    await expect(contractCase!.run()).rejects.toThrow(/nothing within/);
  });

  it('LocalSettingsStorage: fails a subject that reports the change in another area', async () => {
    const [contractCase] = defineSettingsContract(() =>
      settingsHarness((st) => ({
        ...st,
        onChanged: (listener) => {
          st.onChanged((changes) => {
            listener(changes, 'session');
          });
        },
      })),
    );
    await expect(contractCase!.run()).rejects.toThrow(/change reports/);
  });

  it('LocalSettingsStorage: fails a subject whose get does not read the value back', async () => {
    const [contractCase] = defineSettingsContract(() =>
      settingsHarness((st) => ({ ...st, get: () => Promise.resolve({}) })),
    );
    await expect(contractCase!.run()).rejects.toThrow(/get after set/);
  });

  it('Windows: fails a subject whose closes never reach onClosed', async () => {
    const [contractCase] = defineWindowsContract(() =>
      windowsHarness((w) => ({ ...w, onClosed: () => undefined })),
    );
    await expect(contractCase!.run()).rejects.toThrow(/nothing within/);
  });

  it('Windows: fails a subject whose exists answers true for a closed window', async () => {
    const [contractCase] = defineWindowsContract(() =>
      windowsHarness((w) => ({ ...w, exists: () => Promise.resolve(true) })),
    );
    await expect(contractCase!.run()).rejects.toThrow(/exists rejects for a closed window/);
  });

  it('Runtime: fails a subject that reports another version', async () => {
    const [contractCase] = defineRuntimeContract(() =>
      runtimeHarness((r) => ({ ...r, manifestVersion: () => '0.0.0' })),
    );
    await expect(contractCase!.run()).rejects.toThrow(/manifestVersion/);
  });

  it('Runtime: fails a subject whose messages never reach onMessage', async () => {
    const [, contractCase] = defineRuntimeContract(() =>
      runtimeHarness((r) => ({ ...r, onMessage: () => undefined })),
    );
    await expect(contractCase!.run()).rejects.toThrow(/nothing within/);
  });

  it('TabEvents: fails a subject that reports another tab as created', async () => {
    const [contractCase] = defineTabEventsContract(() =>
      tabEventsHarness((t) => ({
        ...t,
        onCreated: (listener) => {
          t.onCreated((tab) => {
            listener({ tabId: (tab.tabId ?? 0) + 100 });
          });
        },
      })),
    );
    await expect(contractCase!.run()).rejects.toThrow(/nothing within/);
  });

  it('TabEvents: fails a subject whose removals are never reported', async () => {
    const [contractCase] = defineTabEventsContract(() =>
      tabEventsHarness((t) => ({ ...t, onRemoved: () => undefined })),
    );
    await expect(contractCase!.run()).rejects.toThrow(/nothing within/);
  });

  it('TabEvents: fails a subject whose debugger detaches are never reported', async () => {
    const [contractCase] = defineTabEventsContract(() =>
      tabEventsHarness((t) => ({ ...t, onDebuggerDetach: () => undefined })),
    );
    await expect(contractCase!.run()).rejects.toThrow(/nothing within/);
  });
});
