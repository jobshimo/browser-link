// GENERATED from packages/core/src/ports/contract/flow-stores.contract.ts. Do not edit.
// What every `FlowHistoryStore` and `DetachedFlowStore` guarantees (5.3,
// item 5; slice 17): the stores round-trip what core wrote, a write replaces
// what the same key held, and `drop`/`remove` are idempotent. They run
// against the in-memory fakes and against the extension adapters over a
// stand-in `chrome.storage.session`; in the real service worker the e2e
// reaches every adapter function (R6, condition 1).

import type { DetachedFlowStore } from '../detached-flow-store.js';
import type { FlowHistoryStore } from '../flow-history-store.js';
import type { DetachedFlowRecord, FlowHistoryEntry } from '../values.js';
import { type ContractCase, equal } from './assert.js';

export interface FlowHistoryStoreHarness {
  store: FlowHistoryStore;
  dispose?: () => Promise<void> | void;
}

export interface DetachedFlowStoreHarness {
  store: DetachedFlowStore;
  dispose?: () => Promise<void> | void;
}

function withHarness<H extends { dispose?: () => Promise<void> | void }>(
  make: () => Promise<H> | H,
  body: (harness: H) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const harness = await make();
    try {
      await body(harness);
    } finally {
      await harness.dispose?.();
    }
  };
}

const entry = (flowId: string, extra: Partial<FlowHistoryEntry> = {}): FlowHistoryEntry => ({
  flowId,
  startedAt: 1_000,
  durationMs: 250,
  outcome: 'completed',
  steps: 3,
  stepsCompleted: 3,
  ...extra,
});

const record = (flowId: string, extra: Partial<DetachedFlowRecord> = {}): DetachedFlowRecord => ({
  flowId,
  tabId: 7,
  state: 'running',
  startedAt: 1_000,
  steps: 2,
  stepsCompleted: 0,
  ...extra,
});

const byId = (records: readonly DetachedFlowRecord[]): DetachedFlowRecord[] =>
  [...records].sort((a, b) => (a.flowId < b.flowId ? -1 : a.flowId > b.flowId ? 1 : 0));

export function defineFlowHistoryStoreContract(
  make: () => Promise<FlowHistoryStoreHarness> | FlowHistoryStoreHarness,
): ContractCase[] {
  return [
    {
      name: 'load of a tab never saved answers no entries',
      run: withHarness(make, async ({ store }) => {
        equal(await store.load(41), [], 'entries');
      }),
    },
    {
      name: 'save then load round-trips the entries in order, per tab, the last save winning',
      run: withHarness(make, async ({ store }) => {
        const first = [
          entry('f2', { detached: true, stoppedBy: 'expired', outcome: 'expired' }),
          entry('f1', { failedStep: 1, failedStepKind: 'click', outcome: 'failed' }),
        ];
        await store.save(7, [entry('old')]);
        await store.save(7, first);
        await store.save(8, [entry('other', { iterationsCompleted: 4 })]);
        equal(await store.load(7), first, 'tab 7');
        equal(await store.load(8), [entry('other', { iterationsCompleted: 4 })], 'tab 8');
      }),
    },
    {
      name: 'drop forgets the tab, and dropping again is a no-op',
      run: withHarness(make, async ({ store }) => {
        await store.save(7, [entry('f1')]);
        await store.save(8, [entry('f2')]);
        await store.drop(7);
        await store.drop(7);
        await store.drop(99);
        equal(await store.load(7), [], 'dropped tab');
        equal(await store.load(8), [entry('f2')], 'other tab');
      }),
    },
  ];
}

export function defineDetachedFlowStoreContract(
  make: () => Promise<DetachedFlowStoreHarness> | DetachedFlowStoreHarness,
): ContractCase[] {
  return [
    {
      name: 'list of an empty store answers no records',
      run: withHarness(make, async ({ store }) => {
        equal(await store.list(), [], 'records');
      }),
    },
    {
      name: 'put then list round-trips each record, a put of the same flow id replacing it',
      run: withHarness(make, async ({ store }) => {
        const finished = record('a', {
          state: 'cancelled',
          endedAt: 2_000,
          stepsCompleted: 1,
          iterationsCompleted: 3,
          stoppedBy: 'cancelled',
          error: 'find: no match',
          manifest: [{ ok: true, step: 0 }],
          eventPending: true,
        });
        await store.put(record('a'));
        await store.put(record('b', { manifestTruncated: true }));
        await store.put(finished);
        equal(
          byId(await store.list()),
          [finished, record('b', { manifestTruncated: true })],
          'records',
        );
      }),
    },
    {
      name: 'remove forgets those flow ids and keeps the rest; an unknown id is a no-op',
      run: withHarness(make, async ({ store }) => {
        await store.put(record('a'));
        await store.put(record('b'));
        await store.put(record('c'));
        await store.remove(['a', 'c', 'missing']);
        await store.remove(['a']);
        equal(await store.list(), [record('b')], 'records');
      }),
    },
  ];
}
