// The FlowHistoryStore and DetachedFlowStore contracts against their
// in-memory fakes (condition 3 of R6, slice 17), and RED probes showing each
// contract catches a broken subject.
import { describe, expect, it } from 'vitest';
import {
  createMemoryDetachedFlowStore,
  createMemoryFlowHistoryStore,
  defineDetachedFlowStoreContract,
  defineFlowHistoryStoreContract,
  type ContractCase,
} from './index.js';

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
}

async function failures(cases: ContractCase[]): Promise<string[]> {
  const failed: string[] = [];
  for (const contractCase of cases) {
    try {
      await contractCase.run();
    } catch {
      failed.push(contractCase.name);
    }
  }
  return failed;
}

describe('FlowHistoryStore contract: in-memory fake', () => {
  run(defineFlowHistoryStoreContract(() => ({ store: createMemoryFlowHistoryStore() })));
});

describe('DetachedFlowStore contract: in-memory fake', () => {
  run(defineDetachedFlowStoreContract(() => ({ store: createMemoryDetachedFlowStore() })));
});

describe('the flow store contracts catch a broken subject (RED probes)', () => {
  it('FlowHistoryStore: a drop that forgets every tab', async () => {
    const cases = defineFlowHistoryStoreContract(() => {
      const store = createMemoryFlowHistoryStore();
      const saved = new Set<number>();
      return {
        store: {
          load: (tabId) => store.load(tabId),
          save: (tabId, entries) => {
            saved.add(tabId);
            return store.save(tabId, entries);
          },
          drop: async () => {
            for (const tabId of saved) await store.drop(tabId);
          },
        },
      };
    });
    expect(await failures(cases)).toEqual(['drop forgets the tab, and dropping again is a no-op']);
  });

  it('DetachedFlowStore: a put that keeps the first record of a flow id', async () => {
    const cases = defineDetachedFlowStoreContract(() => {
      const store = createMemoryDetachedFlowStore();
      const seen = new Set<string>();
      return {
        store: {
          list: () => store.list(),
          put: (record) => {
            if (seen.has(record.flowId)) return Promise.resolve();
            seen.add(record.flowId);
            return store.put(record);
          },
          remove: (flowIds) => store.remove(flowIds),
        },
      };
    });
    expect(await failures(cases)).toEqual([
      'put then list round-trips each record, a put of the same flow id replacing it',
    ]);
  });

  it('DetachedFlowStore: a remove that rejects an unknown id', async () => {
    const cases = defineDetachedFlowStoreContract(() => {
      const store = createMemoryDetachedFlowStore();
      return {
        store: {
          list: () => store.list(),
          put: (record) => store.put(record),
          remove: async (flowIds) => {
            const known = new Set((await store.list()).map((r) => r.flowId));
            if (flowIds.some((id) => !known.has(id))) throw new Error('unknown flow id');
            await store.remove(flowIds);
          },
        },
      };
    });
    expect(await failures(cases)).toEqual([
      'remove forgets those flow ids and keeps the rest; an unknown id is a no-op',
    ]);
  });
});
