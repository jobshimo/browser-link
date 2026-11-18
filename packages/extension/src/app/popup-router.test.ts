// The popup router (design 6.1, slice 21) on fakes: which messages it accepts,
// which handler answers each, and whether it answers at once (the listener
// returns false) or later (it returns true, keeping the channel open).
import { describe, expect, it, vi } from 'vitest';
import {
  createManualClock,
  TabRegistry,
  TabSession,
  type PageDriverHandle,
} from '@browser-link/core';
import type { ReconnectScheduler } from '../reconnect-policy.js';
import type { ActivityAdmin } from './activity-admin.js';
import type { TabIds } from './connection.js';
import { createPopupRouter, isRuntimeMessage, type PopupRouterDeps } from './popup-router.js';
import type { Recording } from './recording.js';
import { newTabConnection, type TabConnection } from './tab-connection.js';

const TAB = 7;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function harness(overrides: Partial<PopupRouterDeps> = {}) {
  const clock = createManualClock(5_000);
  const tabs = new TabRegistry<TabConnection>();
  const scheduler = {
    cancel: vi.fn(() => false),
    isPending: vi.fn(() => false),
  } as unknown as ReconnectScheduler;
  const tabIds: TabIds = {
    previous: vi.fn(() => Promise.resolve(undefined)),
    store: vi.fn(() => Promise.resolve()),
    forget: vi.fn(() => Promise.resolve()),
  };
  const activityAdmin: ActivityAdmin = {
    queryActivity: vi.fn((query) =>
      Promise.resolve({ kind: 'activity.result', request_id: 'q', ok: true, query } as never),
    ),
    purgeActivity: vi.fn(() =>
      Promise.resolve({ kind: 'activity.result', request_id: 'p', ok: true } as never),
    ),
    adminDescribe: vi.fn(() =>
      Promise.resolve({ kind: 'admin.state', request_id: 'd', ok: true } as never),
    ),
    adminAction: vi.fn(() =>
      Promise.resolve({
        kind: 'admin.action.result',
        request_id: 'a',
        result: { ok: true },
      } as never),
    ),
  };
  const recording = {
    status: vi.fn(() => ({ active: false, reviewing: false, stepCount: 0, capped: false })),
    start: vi.fn(() => Promise.resolve({ ok: true })),
    stop: vi.fn(() => Promise.resolve({ ok: true })),
    discard: vi.fn(() => Promise.resolve({ ok: true })),
    save: vi.fn(() => Promise.resolve({ ok: true })),
  } as unknown as Recording;
  const deps: PopupRouterDeps = {
    tabs,
    scheduler,
    tabIds,
    clock,
    connect: vi.fn(() => Promise.resolve({ ok: true, serverTabId: 'T1' })),
    cleanup: vi.fn(() => Promise.resolve()),
    cdp: vi.fn(() => Promise.resolve({})),
    versionCheck: vi.fn(() => ({ extension: '1.4.30', server: null }) as never),
    repairConnection: vi.fn(() => Promise.resolve({ ok: true } as never)),
    openActivityWindow: vi.fn(() => Promise.resolve({ ok: true as const, windowId: 11 })),
    openAdminWindow: vi.fn(() => Promise.resolve({ ok: true as const, windowId: 12 })),
    activityAdmin,
    recording,
    flows: {
      listRunning: vi.fn(() => []),
      cancel: vi.fn(() => true),
    },
    history: { entries: vi.fn(() => Promise.resolve([])) },
    ...overrides,
  };
  const router = createPopupRouter(deps);
  /** Send one message; `open` is what the listener returned, `replies` what it answered. */
  const send = (message: unknown) => {
    const replies: unknown[] = [];
    const open = router(message, (answer) => replies.push(answer));
    return { open, replies };
  };
  return { deps, tabs, scheduler, tabIds, activityAdmin, recording, clock, send };
}

function connection(tabId = TAB): TabConnection {
  const clock = createManualClock(1_000);
  const driver = { observer: undefined } as unknown as PageDriverHandle;
  return newTabConnection(tabId, new TabSession({ clock, driver }), new Set());
}

describe('popup router: what it accepts', () => {
  it.each([
    ['not an object', 'connect'],
    ['null', null],
    ['an unknown action', { action: 'explode', tabId: TAB }],
    ['a tab action without a tab id', { action: 'connect' }],
    ['a tab action with a string tab id', { action: 'status', tabId: '7' }],
    ['saveRecording without a name', { action: 'saveRecording', tabId: TAB }],
    ['cancelFlow without a flow id', { action: 'cancelFlow' }],
    ['adminAction without an id', { action: 'adminAction' }],
    ['adminAction with an object value', { action: 'adminAction', id: 'x', value: {} }],
    ['adminAction with a numeric code', { action: 'adminAction', id: 'x', code: 4 }],
  ])('ignores %s: false, no answer', (_what, message) => {
    const { send } = harness();
    expect(isRuntimeMessage(message)).toBe(false);
    expect(send(message)).toEqual({ open: false, replies: [] });
  });

  it.each([
    { action: 'versionCheck' },
    { action: 'repairConnection' },
    { action: 'openActivityWindow' },
    { action: 'openAdminWindow' },
    { action: 'activityQuery' },
    { action: 'activityPurge' },
    { action: 'adminDescribe' },
    { action: 'adminAction', id: 'doctor' },
    { action: 'adminAction', id: 'x', value: 'v', code: '123456' },
    { action: 'adminAction', id: 'x', value: 3 },
    { action: 'adminAction', id: 'x', value: false },
    { action: 'saveRecording', tabId: TAB, name: 'n' },
    { action: 'cancelFlow', flowId: 'f' },
    { action: 'status', tabId: TAB },
  ])('accepts %j', (message) => {
    expect(isRuntimeMessage(message)).toBe(true);
  });
});

describe('popup router: answered at once (the listener returns false)', () => {
  it('status of an unknown tab: not connected', () => {
    const { send } = harness();
    expect(send({ action: 'status', tabId: TAB })).toEqual({
      open: false,
      replies: [{ connected: false }],
    });
  });

  it('status of a pending reconnect: reconnecting', () => {
    const { send, scheduler } = harness();
    vi.mocked(scheduler.isPending).mockReturnValue(true);
    expect(send({ action: 'status', tabId: TAB }).replies).toEqual([
      { connected: false, reconnecting: true },
    ]);
  });

  it('status of a connected tab: connected with its server tab id', () => {
    const { send, tabs } = harness();
    const state = connection();
    state.serverTabId = 'T9';
    tabs.commit(tabs.reserve(TAB)!, state);
    expect(send({ action: 'status', tabId: TAB }).replies).toEqual([
      { connected: true, serverTabId: 'T9' },
    ]);
  });

  it("pendingDialog: the tab's pending dialog, null without one", () => {
    const { send, tabs } = harness();
    expect(send({ action: 'pendingDialog', tabId: TAB })).toEqual({
      open: false,
      replies: [{ pending: null }],
    });
    const state = connection();
    tabs.commit(tabs.reserve(TAB)!, state);
    state.session.dialogOpened({ type: 'alert', message: 'hi' } as never);
    expect(send({ action: 'pendingDialog', tabId: TAB }).replies).toEqual([
      { pending: { type: 'alert', message: 'hi' } },
    ]);
  });

  it('versionCheck: the version summary', () => {
    const { send } = harness();
    expect(send({ action: 'versionCheck' })).toEqual({
      open: false,
      replies: [{ extension: '1.4.30', server: null }],
    });
  });

  it('recordingStatus: the recording of the tab', () => {
    const { send, recording } = harness();
    expect(send({ action: 'recordingStatus', tabId: TAB })).toEqual({
      open: false,
      replies: [{ active: false, reviewing: false, stepCount: 0, capped: false }],
    });
    expect(recording.status).toHaveBeenCalledWith(TAB);
  });

  it('cancelFlow: whether this call stopped the flow', () => {
    const { send, deps } = harness();
    expect(send({ action: 'cancelFlow', flowId: 'f1' })).toEqual({
      open: false,
      replies: [{ cancelled: true }],
    });
    expect(deps.flows.cancel).toHaveBeenCalledWith('f1');
  });
});

describe('popup router: answered later (the listener returns true)', () => {
  async function later(h: ReturnType<typeof harness>, message: unknown): Promise<unknown[]> {
    const { open, replies } = h.send(message);
    expect(open).toBe(true);
    await flush();
    return replies;
  }

  it('connect cancels the pending reconnect first, then answers the connect result', async () => {
    const h = harness();
    const order: string[] = [];
    vi.mocked(h.scheduler.cancel).mockImplementation(() => {
      order.push('cancel');
      return false;
    });
    vi.mocked(h.deps.connect).mockImplementation(() => {
      order.push('connect');
      return Promise.resolve({ ok: true, serverTabId: 'T1' });
    });
    expect(await later(h, { action: 'connect', tabId: TAB })).toEqual([
      { ok: true, serverTabId: 'T1' },
    ]);
    expect(order).toEqual(['cancel', 'connect']);
  });

  it('disconnect cancels the reconnect, tears down, forgets the tab id', async () => {
    const h = harness();
    expect(await later(h, { action: 'disconnect', tabId: TAB })).toEqual([{ ok: true }]);
    expect(h.scheduler.cancel).toHaveBeenCalledWith(TAB);
    expect(h.deps.cleanup).toHaveBeenCalledWith(TAB);
    expect(h.tabIds.forget).toHaveBeenCalledWith(TAB);
  });

  it('respondDialog answers the dialog through CDP, the prompt text only when given', async () => {
    const h = harness();
    expect(await later(h, { action: 'respondDialog', tabId: TAB, accept: true })).toEqual([
      { ok: true },
    ]);
    expect(h.deps.cdp).toHaveBeenLastCalledWith(TAB, 'Page.handleJavaScriptDialog', {
      accept: true,
    });
    await later(h, { action: 'respondDialog', tabId: TAB, accept: false, promptText: 'x' });
    expect(h.deps.cdp).toHaveBeenLastCalledWith(TAB, 'Page.handleJavaScriptDialog', {
      accept: false,
      promptText: 'x',
    });
  });

  it('respondDialog answers a failed CDP call with its message', async () => {
    const h = harness({ cdp: () => Promise.reject(new Error('No dialog is showing')) });
    expect(await later(h, { action: 'respondDialog', tabId: TAB, accept: true })).toEqual([
      { ok: false, error: 'No dialog is showing' },
    ]);
  });

  it('repairConnection answers the outcome, and a thrown repair with its message', async () => {
    expect(await later(harness(), { action: 'repairConnection' })).toEqual([{ ok: true }]);
    const failing = harness({ repairConnection: () => Promise.reject(new Error('boom')) });
    expect(await later(failing, { action: 'repairConnection' })).toEqual([
      { ok: false, message: 'boom' },
    ]);
  });

  it('openActivityWindow and openAdminWindow answer the window opened', async () => {
    const h = harness();
    expect(await later(h, { action: 'openActivityWindow' })).toEqual([{ ok: true, windowId: 11 }]);
    expect(await later(h, { action: 'openAdminWindow' })).toEqual([{ ok: true, windowId: 12 }]);
  });

  it('activityQuery passes the query, an empty one when absent', async () => {
    const h = harness();
    await later(h, { action: 'activityQuery', query: { limit: 5 } });
    await later(h, { action: 'activityQuery' });
    expect(vi.mocked(h.activityAdmin.queryActivity).mock.calls).toEqual([[{ limit: 5 }], [{}]]);
  });

  it('activityPurge, adminDescribe and adminAction reach their round trips', async () => {
    const h = harness();
    const purge = { action: 'activityPurge', from: 'a', to: 'b', dryRun: true };
    expect(await later(h, purge)).toEqual([{ kind: 'activity.result', request_id: 'p', ok: true }]);
    expect(h.activityAdmin.purgeActivity).toHaveBeenCalledWith(purge);
    await later(h, { action: 'adminDescribe', language: 'es' });
    expect(h.activityAdmin.adminDescribe).toHaveBeenCalledWith('es');
    const action = { action: 'adminAction', id: 'idle-ttl', value: 5 };
    expect(await later(h, action)).toEqual([
      { kind: 'admin.action.result', request_id: 'a', result: { ok: true } },
    ]);
    expect(h.activityAdmin.adminAction).toHaveBeenCalledWith(action);
  });

  it('the recording actions reach the recording of the tab', async () => {
    const h = harness();
    for (const action of ['startRecording', 'stopRecording', 'discardRecording']) {
      expect(await later(h, { action, tabId: TAB })).toEqual([{ ok: true }]);
    }
    await later(h, { action: 'saveRecording', tabId: TAB, name: 'n', description: 'd' });
    expect(h.recording.start).toHaveBeenCalledWith(TAB);
    expect(h.recording.stop).toHaveBeenCalledWith(TAB);
    expect(h.recording.discard).toHaveBeenCalledWith(TAB);
    expect(h.recording.save).toHaveBeenCalledWith(TAB, 'n', 'd');
  });

  it('flowsStatus answers every running flow and the history of the tab', async () => {
    const running = [{ flowId: 'f1' }] as never;
    const history = [{ flowId: 'f0' }] as never;
    const h = harness({
      flows: { listRunning: vi.fn(() => running), cancel: vi.fn(() => false) },
      history: { entries: vi.fn(() => Promise.resolve(history)) },
    });
    expect(await later(h, { action: 'flowsStatus', tabId: TAB })).toEqual([{ running, history }]);
    expect(h.deps.flows.listRunning).toHaveBeenCalledWith(5_000);
    expect(h.deps.history.entries).toHaveBeenCalledWith(TAB);
  });
});
