// The invariants of `FlowHistory` (design section 4; slice 17), over the
// in-memory `FlowHistoryStore` and `DetachedFlowStore`.
import { describe, expect, it } from 'vitest';
import {
  createManualClock,
  createMemoryDetachedFlowStore,
  createMemoryFlowHistoryStore,
  type MemoryDetachedFlowStore,
  type MemoryFlowHistoryStore,
} from '../ports/contract/fakes.js';
import type { DetachedFlowRecord } from '../ports/values.js';
import { MAX_DETACHED_FLOW_RECORDS } from './detached-flows.js';
import type { FlowResult } from './flow-engine.js';
import { createFlowHistory, MAX_FLOW_HISTORY_PER_TAB, type FlowHistory } from './flow-history.js';
import type { FlowRun } from './flow-run.js';

const COMPLETED: FlowResult = { ok: true, steps_completed: 1, results: [{ ok: true }] };

function run(flowId: string, overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    flowId,
    tabId: 7,
    title: '',
    startedAt: 1_000,
    steps: 1,
    cancelled: false,
    progress: { step: 1, steps: 1 },
    detached: false,
    ...overrides,
  };
}

const detachedRun = (flowId: string, startedAt = 1_000): FlowRun =>
  run(flowId, { detached: true, expiresAt: startedAt + 60_000, startedAt });

/** Let every queued store write land (the fakes answer on microtasks). */
async function drain(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

interface Subject {
  history: FlowHistory;
  historyStore: MemoryFlowHistoryStore;
  detachedStore: MemoryDetachedFlowStore;
  published: { tabId: number; record: DetachedFlowRecord }[];
  lost: string[];
  /** Whether `publish` delivers (the tab's socket is open). */
  socketOpen: { value: boolean };
  clock: ReturnType<typeof createManualClock>;
}

function subject(): Subject {
  const historyStore = createMemoryFlowHistoryStore();
  const detachedStore = createMemoryDetachedFlowStore();
  const published: Subject['published'] = [];
  const lost: string[] = [];
  const socketOpen = { value: true };
  const clock = createManualClock(10_000);
  const history = createFlowHistory({
    history: historyStore,
    detached: detachedStore,
    clock,
    publish: (tabId, record) => {
      if (!socketOpen.value) return false;
      published.push({ tabId, record: { ...record } });
      return true;
    },
    onRecordLost: (flowId) => lost.push(flowId),
  });
  return { history, historyStore, detachedStore, published, lost, socketOpen, clock };
}

describe('FlowHistory: bounded storage', () => {
  it(`keeps the newest ${String(MAX_FLOW_HISTORY_PER_TAB)} history entries of a tab`, async () => {
    const { history } = subject();
    for (let i = 0; i <= MAX_FLOW_HISTORY_PER_TAB; i += 1) {
      history.recordFinished(run(`f${String(i)}`), COMPLETED, 2_000);
    }
    await drain();
    const entries = await history.entries(7);
    expect(entries).toHaveLength(MAX_FLOW_HISTORY_PER_TAB);
    expect(entries[0]?.flowId).toBe(`f${String(MAX_FLOW_HISTORY_PER_TAB)}`);
    expect(entries.at(-1)?.flowId).toBe('f1');
  });

  it(`keeps at most ${String(MAX_DETACHED_FLOW_RECORDS)} records, evicting the oldest terminal one, never a running one`, async () => {
    const { history, detachedStore } = subject();
    expect(await history.persistLaunch(detachedRun('oldest-running', 1))).toBe(true);
    for (let i = 0; i < MAX_DETACHED_FLOW_RECORDS; i += 1) {
      const r = detachedRun(`d${String(i)}`, 100 + i);
      expect(await history.persistLaunch(r)).toBe(true);
      history.recordFinished(r, COMPLETED, 5_000);
      await drain();
    }
    const ids = (await detachedStore.list()).map((r) => r.flowId).sort();
    expect(ids).toHaveLength(MAX_DETACHED_FLOW_RECORDS);
    expect(ids).toContain('oldest-running');
    expect(ids).not.toContain('d0');
    expect(await history.record('d0')).toBeUndefined();
  });
});

describe('FlowHistory: serialized writes', () => {
  it('two runs of one tab finishing together both reach the history', async () => {
    const { history } = subject();
    history.recordFinished(run('a'), COMPLETED, 2_000);
    history.recordFinished(run('b'), COMPLETED, 2_000);
    await drain();
    expect((await history.entries(7)).map((e) => e.flowId)).toEqual(['b', 'a']);
  });

  it('a failed write never breaks the chain', async () => {
    const { history, historyStore } = subject();
    let refusals = 1;
    historyStore.refuse = (operation) => operation === 'save' && refusals-- > 0;
    history.recordFinished(run('lost'), COMPLETED, 2_000);
    history.recordFinished(run('kept'), COMPLETED, 2_000);
    await drain();
    expect((await history.entries(7)).map((e) => e.flowId)).toEqual(['kept']);
  });

  it('a status read waits for the terminal write, never answering the stale launch record', async () => {
    const { history } = subject();
    const r = detachedRun('d');
    await history.persistLaunch(r);
    history.recordFinished(r, COMPLETED, 2_000);
    expect((await history.record('d'))?.state).toBe('completed');
  });

  it('an unreadable history answers no entries', async () => {
    const { history, historyStore } = subject();
    historyStore.refuse = (operation) => operation === 'load';
    expect(await history.entries(7)).toEqual([]);
  });
});

describe('FlowHistory: no resurrection', () => {
  it('a run that started before its tab was dropped does not write the history back', async () => {
    const { history, clock } = subject();
    history.recordFinished(run('before-close', { startedAt: 1_000 }), COMPLETED, 2_000);
    await clock.advance(1_000);
    history.dropTab(7);
    history.recordFinished(run('late', { startedAt: 9_000 }), COMPLETED, 12_000);
    await drain();
    expect(await history.entries(7)).toEqual([]);
    // A flow that started after the drop belongs to whatever tab holds the id now.
    history.recordFinished(run('new-tab', { startedAt: 11_000 }), COMPLETED, 12_000);
    await drain();
    expect((await history.entries(7)).map((e) => e.flowId)).toEqual(['new-tab']);
  });

  it('a tab connecting again under the id writes history again', async () => {
    const { history } = subject();
    history.dropTab(7);
    history.tabConnected(7);
    history.recordFinished(run('old', { startedAt: 1_000 }), COMPLETED, 2_000);
    await drain();
    expect((await history.entries(7)).map((e) => e.flowId)).toEqual(['old']);
  });
});

describe('FlowHistory: one terminal record and one flow-finished event per detached flow', () => {
  it('publishes the event once and stores the terminal record', async () => {
    const { history, published } = subject();
    const r = detachedRun('d');
    await history.persistLaunch(r);
    history.recordFinished(r, COMPLETED, 2_000);
    await drain();
    expect(published.map((p) => p.record.flowId)).toEqual(['d']);
    expect(await history.record('d')).toMatchObject({ state: 'completed', endedAt: 2_000 });
    // A synchronous run gets neither.
    history.recordFinished(run('fg'), COMPLETED, 2_000);
    await drain();
    expect(published).toHaveLength(1);
    expect(await history.record('fg')).toBeUndefined();
  });

  it('an event that could not go out is owed on the record and flushed once, even by two flushes', async () => {
    const { history, published, socketOpen } = subject();
    socketOpen.value = false;
    const r = detachedRun('d');
    await history.persistLaunch(r);
    history.recordFinished(r, COMPLETED, 2_000);
    await drain();
    expect((await history.record('d'))?.eventPending).toBe(true);
    socketOpen.value = true;
    await Promise.all([history.flushPendingEvents(7), history.flushPendingEvents(7)]);
    await drain();
    await history.flushPendingEvents(7);
    await drain();
    expect(published.map((p) => p.record.flowId)).toEqual(['d']);
    expect((await history.record('d'))?.eventPending).toBeUndefined();
  });

  it('an event that still cannot go out stays owed', async () => {
    const { history, published, socketOpen } = subject();
    socketOpen.value = false;
    const r = detachedRun('d');
    await history.persistLaunch(r);
    history.recordFinished(r, COMPLETED, 2_000);
    await history.flushPendingEvents(7);
    await drain();
    expect(published).toEqual([]);
    expect((await history.record('d'))?.eventPending).toBe(true);
  });
});

describe('FlowHistory: worker restart', () => {
  it('a record still running becomes failed / worker-terminated, once, with its history entry', async () => {
    const before = subject();
    await before.history.persistLaunch(detachedRun('orphan', 1_000));
    // A new worker over the same stores.
    const after = createFlowHistory({
      history: before.historyStore,
      detached: before.detachedStore,
      clock: createManualClock(20_000),
      publish: () => true,
      onRecordLost: () => undefined,
    });
    await after.recover();
    await drain();
    expect(await after.record('orphan')).toMatchObject({
      state: 'failed',
      stoppedBy: 'worker-terminated',
      endedAt: 20_000,
      manifestTruncated: true,
      eventPending: true,
    });
    await after.recover();
    await drain();
    expect(await after.entries(7)).toEqual([
      expect.objectContaining({ flowId: 'orphan', outcome: 'failed', durationMs: 19_000 }),
    ]);
  });
});

describe('FlowHistory: refused writes', () => {
  it('a refused launch record is retried once after pruning finished records', async () => {
    const { history, detachedStore } = subject();
    const done = detachedRun('done', 1);
    await history.persistLaunch(done);
    history.recordFinished(done, COMPLETED, 2);
    await drain();
    let refusals = 1;
    detachedStore.refuse = (record) => record.flowId === 'new' && refusals-- > 0;
    expect(await history.persistLaunch(detachedRun('new', 5))).toBe(true);
    expect((await detachedStore.list()).map((r) => r.flowId)).toEqual(['new']);
  });

  it('a launch record the store keeps refusing is reported unstored', async () => {
    const { history, detachedStore } = subject();
    detachedStore.refuse = () => true;
    expect(await history.persistLaunch(detachedRun('new'))).toBe(false);
  });

  it('a refused terminal record is stored without its manifest, then reported lost', async () => {
    const { history, detachedStore, lost } = subject();
    const r = detachedRun('d');
    await history.persistLaunch(r);
    detachedStore.refuse = (record) => record.manifest !== undefined;
    history.recordFinished(r, COMPLETED, 2_000);
    await drain();
    expect(await history.record('d')).toMatchObject({
      state: 'completed',
      manifestTruncated: true,
    });
    expect(lost).toEqual([]);
    const other = detachedRun('e');
    await history.persistLaunch(other);
    detachedStore.refuse = (record) => record.state !== 'running';
    history.recordFinished(other, COMPLETED, 2_000);
    await drain();
    expect(lost).toEqual(['e']);
  });
});
