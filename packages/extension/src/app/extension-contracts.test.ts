// The `Windows`, `Runtime` and `TabEvents` contracts against their in-memory
// fakes (R6 condition 3), and RED probes showing each catches a broken
// subject. The same contracts run against `adapters/chrome-windows.ts`,
// `chrome-runtime.ts` and `chrome-tab-events.ts` inside the real service
// worker (contract/entry.ts).
import { describe, expect, it } from 'vitest';
import type { ContractCase } from '@browser-link/core';
import { defineRuntimeContract, type RuntimeHarness } from '../../contract/runtime.contract.js';
import {
  defineTabEventsContract,
  type TabEventsHarness,
} from '../../contract/tab-events.contract.js';
import { defineWindowsContract, type WindowsHarness } from '../../contract/windows.contract.js';
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

function windowsHarness(wrap: (w: Windows) => Windows = (w) => w): WindowsHarness {
  const windows = createMemoryWindows();
  return { windows: wrap(windows), url: 'about:blank', close: (id) => windows.close(id), until };
}

function runtimeHarness(wrap: (r: Runtime) => Runtime = (r) => r): RuntimeHarness {
  const runtime = createMemoryRuntime('1.2.3');
  return {
    runtime: wrap(runtime),
    version: '1.2.3',
    openPage: () => {
      void runtime.send({ action: 'versionCheck' });
      return Promise.resolve(() => Promise.resolve());
    },
    until,
  };
}

function tabEventsHarness(wrap: (t: TabEvents) => TabEvents = (t) => t): TabEventsHarness {
  const tabs = createMemoryTabEvents();
  return {
    tabEvents: wrap(tabs),
    openTab: () => Promise.resolve(tabs.create({ url: 'about:blank' })),
    attachDebugger: (tabId) => {
      tabs.attachDebugger(tabId);
      return Promise.resolve();
    },
    closeTab: (tabId) => {
      tabs.close(tabId);
      return Promise.resolve();
    },
    until,
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

describe('extension contracts: RED probes', () => {
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
