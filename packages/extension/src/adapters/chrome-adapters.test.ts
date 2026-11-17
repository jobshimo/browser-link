// The ContentSettings and Downloads contracts (design 5.3, item 5; slice 16)
// and the two flow store contracts (slice 17) against the extension adapters,
// over stand-ins for `chrome.contentSettings`, `chrome.downloads`,
// `chrome.debugger.onEvent` and `chrome.storage.session`. In the real
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

beforeEach(() => {
  values.clear();
  session.clear();
  vi.stubGlobal('chrome', {
    contentSettings: { location: contentSetting('location') },
    debugger: { onEvent: { addListener: () => undefined, removeListener: () => undefined } },
    storage: { session: sessionArea },
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
      publish: () => true,
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
