// The ContentSettings and Downloads contracts (design 5.3, item 5; slice 16)
// and the two flow store contracts (slice 17) against the extension adapters,
// over stand-ins for `chrome.contentSettings`, `chrome.downloads`,
// `chrome.debugger.onEvent` and `chrome.storage.session`, and the Windows,
// Runtime and TabEvents adapters (slice 21) and the LocalSettingsStorage adapter
// (slice 21b) over stand-ins of their APIs. In the real
// service worker the e2e reaches every adapter function (R6, condition 1).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFlowHistory,
  createFlowRegistry,
  createManualClock,
  defineContentSettingsContract,
  defineDetachedFlowStoreContract,
  defineDownloadsContract,
  defineFlowHistoryStoreContract,
  type ContractCase,
  type DetachedFlowRecord,
} from '@browser-link/core';
import { createDownloadCapture, type DownloadsApi } from '../download-capture.js';
import { createChromeContentSettings } from './chrome-content-settings.js';
import { createChromeDownloads } from './chrome-downloads.js';
import { chromeDetachedFlowStore } from './chrome-detached-flow-store.js';
import { chromeFlowHistoryStore } from './chrome-flow-history-store.js';
import { chromeTabEvents } from './chrome-tab-events.js';
import { chromeRuntime } from './chrome-runtime.js';
import { chromeWindows } from './chrome-windows.js';
import { chromeSettings } from './chrome-settings.js';

const values = new Map<string, string>();

function contentSetting(key: string) {
  return {
    set: ({ primaryPattern, setting }: { primaryPattern: string; setting: string }) => {
      values.set(`${key} ${primaryPattern}`, setting);
      return Promise.resolve();
    },
  };
}

/** `chrome.storage.session`: what it holds, serialised as Chrome does. */
const session = new Map<string, unknown>();
const sessionArea = {
  get: (key: string | null) =>
    Promise.resolve(
      Object.fromEntries(
        [...session].filter(([k]) => key === null || k === key).map(([k, v]) => [k, v]),
      ),
    ),
  set: (items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) session.set(k, JSON.parse(JSON.stringify(v)));
    return Promise.resolve();
  },
  remove: (keys: string | string[]) => {
    for (const k of typeof keys === 'string' ? [keys] : keys) session.delete(k);
    return Promise.resolve();
  },
};

const downloadsApi: DownloadsApi = {
  onDeterminingFilename: { addListener: () => undefined, removeListener: () => undefined },
  cancel: () => Promise.resolve(),
  erase: () => Promise.resolve([]),
};

/** `chrome.tabs`: `get` answers one fixed tab; `onUpdated` keeps its listeners, `updated` fires them. */
const tabListeners = new Set<(tabId: number, info: unknown, tab: unknown) => void>();
const tabsApi = {
  get: (tabId: number) =>
    tabId === 7
      ? Promise.resolve({ id: 7, url: 'https://a.example/' })
      : Promise.reject(new Error('No tab')),
  onUpdated: {
    addListener: (l: (tabId: number, info: unknown, tab: unknown) => void) => tabListeners.add(l),
    removeListener: (l: (tabId: number, info: unknown, tab: unknown) => void) =>
      tabListeners.delete(l),
  },
};
const updated = (tabId: number, info: unknown, tab: unknown): void => {
  for (const l of [...tabListeners]) l(tabId, info, tab);
};

beforeEach(() => {
  tabListeners.clear();
  values.clear();
  session.clear();
  vi.stubGlobal('chrome', {
    contentSettings: { location: contentSetting('location') },
    debugger: { onEvent: { addListener: () => undefined, removeListener: () => undefined } },
    storage: { session: sessionArea },
    tabs: tabsApi,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
}

describe('ContentSettings contract: the chrome.contentSettings adapter', () => {
  run(
    defineContentSettingsContract(() => ({
      settings: createChromeContentSettings(),
      read: (setting, pattern) => Promise.resolve(values.get(`${setting} ${pattern}`)),
      failing: {
        setting: 'sensors',
        message: 'chrome.contentSettings.sensors is not exposed in this Chrome build',
      },
    })),
  );
});

describe('Downloads contract: the chrome.downloads adapter', () => {
  run(
    defineDownloadsContract(() => ({
      downloads: createChromeDownloads(createDownloadCapture(downloadsApi), 4),
      elapse: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms + 5);
        }),
    })),
  );
});

describe('FlowHistoryStore contract: the chrome.storage.session adapter', () => {
  run(defineFlowHistoryStoreContract(() => ({ store: chromeFlowHistoryStore })));
});

describe('DetachedFlowStore contract: the chrome.storage.session adapter', () => {
  run(defineDetachedFlowStoreContract(() => ({ store: chromeDetachedFlowStore })));
});

// The stored format is unchanged by slice 17 (design 3.1: the adapters keep
// today's keys and values). The values below are written out by hand as
// 1.4.22 stored them, so a change of key or field fails here.
describe('flow storage format: the same keys and values as 1.4.22', () => {
  const historyAsStored = [
    {
      flowId: 'flow_b',
      startedAt: 2_000,
      durationMs: 500,
      steps: 2,
      outcome: 'cancelled',
      stepsCompleted: 1,
      iterationsCompleted: 3,
      detached: true,
      stoppedBy: 'cancelled',
    },
    {
      flowId: 'flow_a',
      startedAt: 1_000,
      durationMs: 40,
      steps: 3,
      outcome: 'failed',
      stepsCompleted: 1,
      failedStep: 1,
      failedStepKind: 'click',
    },
  ];
  const recordAsStored = {
    flowId: 'flow_b',
    tabId: 7,
    state: 'cancelled',
    startedAt: 2_000,
    endedAt: 2_500,
    steps: 2,
    stepsCompleted: 1,
    iterationsCompleted: 3,
    stoppedBy: 'cancelled',
    manifest: [{ iterations_completed: 3 }],
  };

  it('reads a history and a detached-flow record stored by 1.4.22', async () => {
    session.set('flow-history:7', historyAsStored);
    session.set('detached-flow:flow_b', recordAsStored);
    session.set('pendingReconnect:7', { attempt: 1 });
    expect(await chromeFlowHistoryStore.load(7)).toEqual(historyAsStored);
    expect(await chromeDetachedFlowStore.list()).toEqual([recordAsStored]);
  });

  it('a finished detached flow is stored under the same keys with the same values', async () => {
    const clock = createManualClock(2_000);
    const registry = createFlowRegistry(clock);
    const history = createFlowHistory({
      history: chromeFlowHistoryStore,
      detached: chromeDetachedFlowStore,
      clock,
      events: { emit: () => true },
      onRecordLost: () => undefined,
    });
    session.set('flow-history:7', [historyAsStored[1]]);
    const run = registry.register({
      flowId: 'flow_b',
      tabId: 7,
      steps: 2,
      detached: true,
      expiresAt: 1_802_000,
    });
    expect(await history.persistLaunch(run)).toBe(true);
    expect(session.get('detached-flow:flow_b')).toEqual({
      flowId: 'flow_b',
      tabId: 7,
      state: 'running',
      startedAt: 2_000,
      steps: 2,
      stepsCompleted: 0,
    });
    registry.cancel('flow_b');
    history.recordFinished(
      registry.finish('flow_b')!,
      {
        ok: true,
        steps_completed: 1,
        results: [{ iterations_completed: 3 }],
        stopped_by: 'cancelled',
      },
      2_500,
    );
    const record: DetachedFlowRecord | undefined = await history.record('flow_b');
    expect(record).toEqual(recordAsStored);
    expect(session.get('detached-flow:flow_b')).toEqual(recordAsStored);
    expect(session.get('flow-history:7')).toEqual(historyAsStored);
    expect([...session.keys()].sort()).toEqual(['detached-flow:flow_b', 'flow-history:7']);
  });
});

describe('TabEvents: the chrome.tabs adapter', () => {
  it('get answers the tab and rejects for a closed one, as chrome.tabs.get does', async () => {
    expect(await chromeTabEvents.get(7)).toMatchObject({ url: 'https://a.example/' });
    await expect(chromeTabEvents.get(8)).rejects.toThrow('No tab');
  });

  it('onUpdated hands on tab, status and url of every update until it is unsubscribed', () => {
    const seen: unknown[] = [];
    const stop = chromeTabEvents.onUpdated((u) => seen.push(u));
    updated(7, { status: 'complete' }, { url: 'https://a.example/b' });
    updated(9, {}, {});
    expect(seen).toEqual([
      { tabId: 7, status: 'complete', url: 'https://a.example/b' },
      { tabId: 9, status: undefined, url: undefined },
    ]);
    expect(tabListeners.size).toBe(1);
    stop();
    expect(tabListeners.size).toBe(0);
    updated(7, { status: 'complete' }, { url: 'x' });
    expect(seen).toHaveLength(2);
  });

  it('two subscriptions are independent', () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const stopA = chromeTabEvents.onUpdated((u) => a.push(u));
    chromeTabEvents.onUpdated((u) => b.push(u));
    stopA();
    updated(7, { status: 'complete' }, { url: 'u' });
    expect([a.length, b.length]).toEqual([0, 1]);
  });
});

/** A `chrome.*.onX` stand-in that keeps its listeners; `fire` calls them. */
function event<A extends unknown[]>() {
  const listeners: ((...args: A) => unknown)[] = [];
  return {
    listeners,
    addListener: (l: (...args: A) => unknown) => listeners.push(l),
    fire: (...args: A) => listeners.map((l) => l(...args)),
  };
}

describe('Windows: the chrome.windows adapter', () => {
  it('opens a popup window of the size, focuses it, and maps get to exists', async () => {
    const calls: unknown[] = [];
    const onRemoved = event<[number]>();
    vi.stubGlobal('chrome', {
      windows: {
        create: (opts: unknown) => {
          calls.push(['create', opts]);
          return Promise.resolve({ id: 5 });
        },
        update: (id: number, opts: unknown) => {
          calls.push(['update', id, opts]);
          return Promise.resolve({});
        },
        get: (id: number) =>
          id === 5 ? Promise.resolve({ id }) : Promise.reject(new Error('No window')),
        onRemoved,
      },
    });
    expect(await chromeWindows.open('u', { width: 1, height: 2 })).toBe(5);
    await chromeWindows.focus(5);
    expect(calls).toEqual([
      ['create', { url: 'u', type: 'popup', width: 1, height: 2 }],
      ['update', 5, { focused: true }],
    ]);
    expect(await chromeWindows.exists(5)).toBe(true);
    await expect(chromeWindows.exists(6)).rejects.toThrow('No window');
    const closed: number[] = [];
    chromeWindows.onClosed((id) => closed.push(id));
    onRemoved.fire(5);
    expect(closed).toEqual([5]);
  });

  it('a window the browser did not create answers undefined', async () => {
    vi.stubGlobal('chrome', { windows: { create: () => Promise.resolve(undefined) } });
    expect(await chromeWindows.open('u', { width: 1, height: 2 })).toBeUndefined();
  });
});

describe('Runtime: the chrome.runtime adapter', () => {
  it('reads the manifest version and page URLs, and hands messages and replies on', () => {
    const onMessage = event<[unknown, unknown, (answer: unknown) => void]>();
    vi.stubGlobal('chrome', {
      runtime: {
        getManifest: () => ({ version: '9.9.9' }),
        getURL: (path: string) => `chrome-extension://id/${path}`,
        onMessage,
      },
    });
    expect(chromeRuntime.manifestVersion()).toBe('9.9.9');
    expect(chromeRuntime.pageUrl('admin.html')).toBe('chrome-extension://id/admin.html');
    const answers: unknown[] = [];
    chromeRuntime.onMessage((message, reply) => {
      reply({ echo: message });
      return true;
    });
    expect(onMessage.fire({ action: 'x' }, {}, (a) => answers.push(a))).toEqual([true]);
    expect(answers).toEqual([{ echo: { action: 'x' } }]);
  });
});

describe('TabEvents: the wake listeners', () => {
  it('hands on removed tabs, created tabs with their opener, and detached debuggees', () => {
    const onRemoved = event<[number, unknown]>();
    const onCreated = event<[{ id?: number; openerTabId?: number; url?: string }]>();
    const onDetach = event<[{ tabId?: number }, string]>();
    vi.stubGlobal('chrome', { tabs: { onRemoved, onCreated }, debugger: { onDetach } });
    const seen: unknown[] = [];
    chromeTabEvents.onRemoved((tabId) => seen.push(['removed', tabId]));
    chromeTabEvents.onCreated((tab) => seen.push(['created', tab]));
    chromeTabEvents.onDebuggerDetach((tabId) => seen.push(['detached', tabId]));
    onRemoved.fire(3, { windowId: 1 });
    onCreated.fire({ id: 4, openerTabId: 3, url: 'x' });
    onCreated.fire({ id: 5 });
    onDetach.fire({ tabId: 4 }, 'target_closed');
    onDetach.fire({}, 'target_closed');
    expect(seen).toEqual([
      ['removed', 3],
      ['created', { tabId: 4, openerTabId: 3 }],
      ['created', { tabId: 5, openerTabId: undefined }],
      ['detached', 4],
      ['detached', undefined],
    ]);
  });
});

describe('LocalSettingsStorage: the chrome.storage.local adapter', () => {
  it('gets and sets local values, and hands every change on with its area', async () => {
    const calls: unknown[] = [];
    const onChanged = event<[Record<string, { newValue?: unknown }>, string]>();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: (key: string) => {
            calls.push(['get', key]);
            return Promise.resolve({ [key]: 1 });
          },
          set: (items: unknown) => {
            calls.push(['set', items]);
            return Promise.resolve();
          },
        },
        onChanged,
      },
    });
    expect(await chromeSettings.get('k')).toEqual({ k: 1 });
    await chromeSettings.set({ k: 2 });
    expect(calls).toEqual([
      ['get', 'k'],
      ['set', { k: 2 }],
    ]);
    const seen: unknown[] = [];
    chromeSettings.onChanged((changes, area) => seen.push([changes, area]));
    onChanged.fire({ k: { newValue: 2 } }, 'local');
    onChanged.fire({ s: {} }, 'session');
    expect(seen).toEqual([
      [{ k: { newValue: 2 } }, 'local'],
      [{ s: {} }, 'session'],
    ]);
  });
});
