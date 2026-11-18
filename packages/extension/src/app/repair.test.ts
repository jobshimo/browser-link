// "Repair connection" and the version summary (design 6.1, slice 21) on fakes:
// each step `planRepair` picks is carried out, and a reply or its absence
// becomes the outcome the popup shows. The decisions themselves are
// `repair-policy.test.ts`'s.
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionToServer } from '@browser-link/shared';
import {
  createManualClock,
  PendingReplies,
  TabRegistry,
  TabSession,
  type PageDriverHandle,
} from '@browser-link/core';
import type { ReconnectScheduler } from '../reconnect-policy.js';
import {
  REPAIR_TIMEOUT_MS,
  describeReconnectResults,
  describeRepairReply,
  prevTabIdKey,
  repairOutcome,
} from '../repair-policy.js';
import { computeVersionCheck } from '../version-status.js';
import type { ConnectResult, RepairReply } from './connection.js';
import { currentVersionCheck, repairConnection, type RepairDeps } from './repair.js';
import {
  newTabConnection,
  SOCKET_CLOSED,
  SOCKET_OPEN,
  type BridgeSocket,
  type TabConnection,
} from './tab-connection.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function harness(stored: Record<string, unknown> = {}, overrides: Partial<RepairDeps> = {}) {
  const clock = createManualClock(1_000);
  const tabs = new TabRegistry<TabConnection>();
  const sent: ExtensionToServer[] = [];
  const replies = new PendingReplies<RepairReply>(clock);
  const add = (tabId: number, fields: Partial<TabConnection>, readyState = SOCKET_OPEN) => {
    const driver = { observer: undefined } as unknown as PageDriverHandle;
    const state = newTabConnection(tabId, new TabSession({ clock, driver }), new Set());
    Object.assign(state, fields);
    state.ws = {
      readyState,
      send: (data: string) => {
        sent.push(JSON.parse(data) as ExtensionToServer);
      },
    } as unknown as BridgeSocket;
    tabs.commit(tabs.reserve(tabId)!, state);
  };
  const deps: RepairDeps = {
    tabs,
    storage: { get: vi.fn(() => Promise.resolve(stored)) },
    replies,
    scheduler: { cancel: vi.fn(() => false) } as unknown as ReconnectScheduler,
    connect: vi.fn((): Promise<ConnectResult> => Promise.resolve({ ok: true })),
    extensionVersion: () => '1.4.30',
    ...overrides,
  };
  return { clock, tabs, sent, replies, add, deps };
}

describe('currentVersionCheck', () => {
  it('reads the first tab that reported a server version', () => {
    const { tabs, add } = harness();
    add(1, {});
    add(2, { serverVersion: '1.4.29', installedVersion: '1.4.30' });
    add(3, { serverVersion: '1.0.0' });
    expect(currentVersionCheck(tabs, '1.4.30')).toEqual(
      computeVersionCheck({ extension: '1.4.30', server: '1.4.29', installed: '1.4.30' }),
    );
  });

  it('no registered tab: the server is unknown', () => {
    const { tabs } = harness();
    expect(currentVersionCheck(tabs, '1.4.30')).toEqual(
      computeVersionCheck({ extension: '1.4.30', server: null, installed: null }),
    );
  });
});

describe('repairConnection', () => {
  it('a recent server connected: asks it to restart and reports its answer', async () => {
    const { add, sent, replies, deps } = harness();
    add(1, { serverVersion: '1.4.29' });
    const outcome = repairConnection(deps);
    await flush();
    expect(sent).toEqual([{ kind: 'bridge.repair', request_id: expect.any(String) as string }]);
    const requestId = (sent[0] as { request_id: string }).request_id;
    replies.settle(requestId, { kind: 'bridge.repair.result', request_id: requestId, ok: true });
    expect(await outcome).toEqual(
      describeRepairReply({ kind: 'bridge.repair.result', request_id: requestId, ok: true }),
    );
  });

  it('a recent server that never answers: no answer after the timeout', async () => {
    const { add, clock, deps } = harness();
    add(1, { serverVersion: '1.4.29' });
    const outcome = repairConnection(deps);
    await flush();
    await clock.advance(REPAIR_TIMEOUT_MS);
    expect(await outcome).toEqual(describeRepairReply('timeout'));
  });

  it('no socket open: reconnects every remembered tab, cancelling its pending retry', async () => {
    const stored = { [prevTabIdKey(5)]: 'S5', [prevTabIdKey(3)]: 'S3', other: 1 };
    const { deps } = harness(stored, {
      connect: vi.fn((tabId: number) => Promise.resolve({ ok: tabId === 3 })),
    });
    expect(await repairConnection(deps)).toEqual(
      describeReconnectResults([{ ok: true }, { ok: false }]),
    );
    expect(vi.mocked(deps.scheduler.cancel).mock.calls).toEqual([[3], [5]]);
    expect(vi.mocked(deps.connect).mock.calls).toEqual([[3], [5]]);
  });

  it('a connect that throws counts as not reconnected', async () => {
    const { deps } = harness(
      { [prevTabIdKey(3)]: 'S3' },
      { connect: () => Promise.reject(new Error('attach failed')) },
    );
    expect(await repairConnection(deps)).toEqual(describeReconnectResults([{ ok: false }]));
  });

  it('nothing to repair through: the manual outcome, without plan fields', async () => {
    const { deps } = harness({}, { storage: { get: () => Promise.reject(new Error('down')) } });
    const outcome = await repairConnection(deps);
    expect(outcome).toEqual(repairOutcome(false, { code: 'repair-no-server' }));
    expect(outcome).not.toHaveProperty('step');
    expect(outcome).not.toHaveProperty('reason');
  });

  it('an old server connected: the manual outcome naming its version', async () => {
    const { add, sent, deps } = harness();
    add(1, { serverVersion: '0.40.0' });
    expect(await repairConnection(deps)).toEqual(
      repairOutcome(false, { code: 'repair-server-too-old', values: { version: '0.40.0' } }),
    );
    expect(sent).toEqual([]);
  });

  it('a closed socket does not count as connected', async () => {
    const { add, deps } = harness({ [prevTabIdKey(1)]: 'S1' });
    add(1, { serverVersion: '1.4.29' }, SOCKET_CLOSED);
    await repairConnection(deps);
    expect(deps.connect).toHaveBeenCalledWith(1);
  });
});
