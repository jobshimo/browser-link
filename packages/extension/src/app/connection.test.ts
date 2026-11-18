// The connection lifecycle (design 6.1, slice 19) on fakes: a fake socket,
// in-memory alarms and session storage, a manual clock.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ExtensionToServer } from '@browser-link/shared';
import {
  createManualClock,
  PendingReplies,
  TabRegistry,
  TabSession,
  type PageDriverHandle,
} from '@browser-link/core';
import { createMemoryAlarms } from '../../contract/memory-alarms.js';
import {
  ALARM_MIN_DELAY_MS,
  RECONNECT_DELAYS_MS,
  reconnectStorageKey,
} from '../reconnect-policy.js';
import {
  anyOpenSocket,
  createReconnect,
  createTabIds,
  disconnectTab,
  openBridge,
  roundTrip,
  tabStatus,
  type BridgeDeps,
  type BridgeReplies,
  type ConnectResult,
  type SessionStorage,
} from './connection.js';
import {
  newTabConnection,
  SOCKET_CLOSED,
  SOCKET_OPEN,
  type BridgeSocket,
  type TabConnection,
} from './tab-connection.js';

type Listener = (event?: unknown) => void;

interface FakeSocket extends BridgeSocket {
  readyState: number;
  url: string;
  sent: ExtensionToServer[];
  emit(type: 'open' | 'error'): void;
  emit(type: 'message', event: { data: unknown }): void;
  emit(type: 'close', event: { wasClean: boolean }): void;
}

function fakeSocket(url: string): FakeSocket {
  const listeners = new Map<string, Listener[]>();
  const socket = {
    readyState: 0,
    url,
    sent: [] as ExtensionToServer[],
    send(data: string) {
      socket.sent.push(JSON.parse(data) as ExtensionToServer);
    },
    close() {
      socket.readyState = SOCKET_CLOSED;
    },
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    emit(type: string, event?: unknown) {
      if (type === 'open') socket.readyState = SOCKET_OPEN;
      if (type === 'close') socket.readyState = SOCKET_CLOSED;
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
  return socket as FakeSocket;
}

function memoryStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  let failing = false;
  const storage: SessionStorage = {
    get: (keys) => {
      if (failing) return Promise.reject(new Error('storage down'));
      if (keys === null) return Promise.resolve({ ...data });
      return Promise.resolve(keys in data ? { [keys]: data[keys] } : {});
    },
    set: (items) => {
      if (failing) return Promise.reject(new Error('storage down'));
      Object.assign(data, items);
      return Promise.resolve();
    },
    remove: (key) => {
      if (failing) return Promise.reject(new Error('storage down'));
      delete data[key];
      return Promise.resolve();
    },
  };
  return {
    data,
    storage,
    fail() {
      failing = true;
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function connection(tabId = 7): TabConnection {
  const clock = createManualClock(1_000);
  const driver = { observer: undefined } as unknown as PageDriverHandle;
  return newTabConnection(tabId, new TabSession({ clock, driver }), new Set());
}

function replies(): BridgeReplies {
  const clock = createManualClock(0);
  return {
    activity: new PendingReplies(clock),
    admin: new PendingReplies(clock),
    repair: new PendingReplies(clock),
  };
}

function bridge(overrides: Partial<BridgeDeps> = {}) {
  const tabs = new TabRegistry<TabConnection>();
  const state = connection();
  const reservation = tabs.reserve(state.tabId);
  if (!reservation) throw new Error('no reservation');
  tabs.commit(reservation, state);
  const sockets: FakeSocket[] = [];
  const scheduler = {
    cancel: vi.fn(() => false),
    schedule: vi.fn(() => true),
    epoch: () => 0,
    wasCancelledSince: () => false,
    isPending: () => false,
  };
  const tabIdsStore = memoryStorage();
  const deps: BridgeDeps = {
    tabs,
    state,
    openSocket: (url) => {
      const socket = fakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    url: 'ws://127.0.0.1:17529',
    register: {
      url: 'http://a.test/',
      title: 'A',
      previousTabId: 'tab-9',
      extensionVersion: '9.9.9',
    },
    tabIds: createTabIds(tabIdsStore.storage),
    scheduler,
    replies: replies(),
    flushPendingEvents: vi.fn(),
    applySettings: vi.fn(),
    handleTool: vi.fn((msg) =>
      Promise.resolve({
        kind: 'tool.response',
        id: msg.id,
        ok: true,
        result: 1,
      } as ExtensionToServer),
    ),
    cancelFlow: vi.fn(),
    cleanup: vi.fn((id: number) => {
      tabs.remove(id);
      return Promise.resolve();
    }),
    diagnose: vi.fn(() => Promise.resolve({ code: 'ws-connect-failed' as const })),
    ...overrides,
  };
  let result: ConnectResult | undefined;
  void openBridge(deps).then((r) => {
    result = r;
  });
  const socket = sockets[0]!;
  return { deps, tabs, state, socket, scheduler, tabIdsStore, result: () => result };
}

const message = (socket: FakeSocket, msg: unknown): void => {
  socket.emit('message', { data: JSON.stringify(msg) });
};

describe('openBridge: the tab socket', () => {
  test('opens the socket at the url, keeps it on the connection and registers on open', () => {
    const { socket, state } = bridge();
    expect(socket.url).toBe('ws://127.0.0.1:17529');
    expect(state.ws).toBe(socket);
    expect(socket.sent).toEqual([]);
    socket.emit('open');
    expect(socket.sent).toEqual([
      {
        kind: 'tab.register',
        payload: {
          url: 'http://a.test/',
          title: 'A',
          previousTabId: 'tab-9',
          extensionVersion: '9.9.9',
        },
      },
    ]);
  });

  test('tab.registered ends the reconnect cycle, keeps the server metadata, remembers the id and answers ok', async () => {
    const { socket, state, scheduler, tabIdsStore, deps, result } = bridge();
    socket.emit('open');
    message(socket, {
      kind: 'tab.registered',
      payload: { tabId: 'tab-1', serverVersion: '1.2.3', installedVersion: '1.2.4', serverPid: 42 },
    });
    await flush();
    expect(scheduler.cancel).toHaveBeenCalledWith(7);
    expect(state.serverTabId).toBe('tab-1');
    expect(state.serverVersion).toBe('1.2.3');
    expect(state.installedVersion).toBe('1.2.4');
    expect(state.serverPid).toBe(42);
    expect(tabIdsStore.data).toEqual({ 'prevTabId:7': 'tab-1' });
    expect(deps.flushPendingEvents).toHaveBeenCalledWith(7);
    expect(result()).toEqual({ ok: true, serverTabId: 'tab-1' });
  });

  test('metadata of the wrong type is not kept', async () => {
    const { socket, state } = bridge();
    message(socket, {
      kind: 'tab.registered',
      payload: { tabId: 'tab-1', serverVersion: 3, installedVersion: null, serverPid: '42' },
    });
    await flush();
    expect(state.serverVersion).toBeUndefined();
    expect(state.installedVersion).toBeUndefined();
    expect(state.serverPid).toBeUndefined();
  });

  test('a frame that is not text, not JSON or of an unknown kind is ignored', async () => {
    const { socket, deps } = bridge();
    socket.emit('open');
    socket.emit('message', { data: 42 });
    socket.emit('message', { data: '{not json' });
    message(socket, { kind: 'from.the.future' });
    await flush();
    expect(socket.sent).toHaveLength(1);
    expect(deps.handleTool).not.toHaveBeenCalled();
  });

  test('tool.request runs as a call and answers on the socket while it is open', async () => {
    const { socket, deps } = bridge();
    socket.emit('open');
    message(socket, { kind: 'tool.request', id: 'r1', tool: 'browser.ping', params: {} });
    await flush();
    expect(deps.handleTool).toHaveBeenCalledWith({
      kind: 'tool.request',
      id: 'r1',
      tool: 'browser.ping',
      params: {},
    });
    expect(socket.sent.at(-1)).toEqual({ kind: 'tool.response', id: 'r1', ok: true, result: 1 });
  });

  test('a tool answer is dropped when the socket closed meanwhile', async () => {
    let finish: (r: ExtensionToServer) => void = () => undefined;
    const { socket } = bridge({
      handleTool: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    socket.emit('open');
    message(socket, { kind: 'tool.request', id: 'r1', tool: 'browser.ping', params: {} });
    socket.readyState = SOCKET_CLOSED;
    finish({ kind: 'tool.response', id: 'r1', ok: true, result: 1 } as ExtensionToServer);
    await flush();
    expect(socket.sent).toHaveLength(1);
  });

  test('tool.cancel touches the session and cancels the flow, expired or not', async () => {
    const { socket, deps, state } = bridge();
    const touch = vi.spyOn(state.session, 'touch');
    message(socket, { kind: 'tool.cancel', flow_id: 'f1' });
    message(socket, { kind: 'tool.cancel', flow_id: 'f2', reason: 'expired' });
    message(socket, { kind: 'tool.cancel', flow_id: 'f3', reason: 'other' });
    await flush();
    expect(touch).toHaveBeenCalledTimes(3);
    expect(deps.cancelFlow).toHaveBeenNthCalledWith(1, 'f1', undefined);
    expect(deps.cancelFlow).toHaveBeenNthCalledWith(2, 'f2', 'expired');
    expect(deps.cancelFlow).toHaveBeenNthCalledWith(3, 'f3', undefined);
  });

  test('settings.update is applied and does not touch the session', async () => {
    const { socket, deps, state } = bridge();
    const touch = vi.spyOn(state.session, 'touch');
    message(socket, { kind: 'settings.update', settings: { idleTtlMinutes: 5 } });
    await flush();
    expect(deps.applySettings).toHaveBeenCalledWith({ idleTtlMinutes: 5 });
    expect(touch).not.toHaveBeenCalled();
  });

  test('flow.recorded.result settles the pending save, if any', async () => {
    const { socket, state } = bridge();
    message(socket, { kind: 'flow.recorded.result', ok: true, name: 'n' });
    const save = vi.fn();
    state.pendingFlowSave = save;
    message(socket, { kind: 'flow.recorded.result', ok: false, error: 'bad' });
    await flush();
    expect(save).toHaveBeenCalledWith({ ok: false, error: 'bad' });
  });

  test('activity, admin and repair replies settle their waiters by request id', async () => {
    const { socket, deps } = bridge();
    const activity = deps.replies.activity.wait('a1', 1_000, () => {
      throw new Error('timeout');
    });
    const admin = deps.replies.admin.wait('b1', 1_000, () => {
      throw new Error('timeout');
    });
    const repair = deps.replies.repair.wait('c1', 1_000, () => 'timeout');
    const purge = { kind: 'activity.purge.result', request_id: 'a1', ok: true, deleted: 2 };
    message(socket, purge);
    message(socket, { kind: 'admin.state', request_id: 'b1', ok: false, error: 'x' });
    message(socket, {
      kind: 'bridge.repair.result',
      request_id: 'c1',
      ok: true,
      action: 'restarting',
    });
    await expect(activity).resolves.toEqual(purge);
    await expect(admin).resolves.toEqual({
      kind: 'admin.state',
      request_id: 'b1',
      ok: false,
      error: 'x',
    });
    await expect(repair).resolves.toEqual({
      kind: 'bridge.repair.result',
      request_id: 'c1',
      ok: true,
      action: 'restarting',
    });
  });

  test('an unclean close of the registered socket cleans up and schedules a reconnect', async () => {
    const { socket, deps, scheduler } = bridge();
    message(socket, { kind: 'tab.registered', payload: { tabId: 'tab-1' } });
    await flush();
    socket.emit('close', { wasClean: false });
    expect(deps.cleanup).toHaveBeenCalledWith(7);
    expect(scheduler.schedule).toHaveBeenCalledWith(7);
  });

  test('a clean close (browser.reset) cleans up and never reconnects', async () => {
    const { socket, deps, scheduler } = bridge();
    message(socket, { kind: 'tab.registered', payload: { tabId: 'tab-1' } });
    await flush();
    socket.emit('close', { wasClean: true });
    expect(deps.cleanup).toHaveBeenCalledWith(7);
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  test('a close after an extension-initiated teardown (untracked socket) never reconnects', async () => {
    const { socket, tabs, scheduler } = bridge();
    message(socket, { kind: 'tab.registered', payload: { tabId: 'tab-1' } });
    await flush();
    tabs.remove(7);
    socket.emit('close', { wasClean: false });
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  test('a close before registration answers ws-closed-before-registration without reconnecting', async () => {
    const { socket, scheduler, result } = bridge();
    socket.emit('close', { wasClean: false });
    await flush();
    expect(result()).toMatchObject({ ok: false, code: 'ws-closed-before-registration' });
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  test('the close of a superseded socket leaves the newer connection alone', async () => {
    const { socket, state, deps, result } = bridge();
    state.ws = fakeSocket('ws://newer');
    socket.emit('close', { wasClean: false });
    await flush();
    expect(deps.cleanup).not.toHaveBeenCalled();
    expect(result()).toMatchObject({ ok: false, code: 'ws-closed-before-registration' });
  });

  test('an error before registration answers with the bridge diagnosis', async () => {
    const { socket, deps, result } = bridge({
      diagnose: vi.fn(() =>
        Promise.resolve({
          code: 'ws-handshake-refused' as const,
          values: { reason: 'origin-not-allowed' },
        }),
      ),
    });
    socket.emit('error');
    socket.emit('close', { wasClean: false });
    await flush();
    expect(deps.diagnose).toHaveBeenCalledTimes(1);
    expect(result()).toMatchObject({
      ok: false,
      code: 'ws-handshake-refused',
      values: { reason: 'origin-not-allowed' },
    });
  });
});

describe('createTabIds', () => {
  test('remembers, reads and forgets the server tab id of a Chrome tab', async () => {
    const { storage, data } = memoryStorage();
    const ids = createTabIds(storage);
    expect(await ids.previous(3)).toBeUndefined();
    await ids.store(3, 'tab-1');
    expect(data).toEqual({ 'prevTabId:3': 'tab-1' });
    expect(await ids.previous(3)).toBe('tab-1');
    await ids.forget(3);
    expect(await ids.previous(3)).toBeUndefined();
  });

  test('a stored value that is not a string reads as no id', async () => {
    const ids = createTabIds(memoryStorage({ 'prevTabId:3': 5 }).storage);
    expect(await ids.previous(3)).toBeUndefined();
  });

  test('storage failures are non-fatal', async () => {
    const store = memoryStorage({ 'prevTabId:3': 'tab-1' });
    store.fail();
    const ids = createTabIds(store.storage);
    await expect(ids.previous(3)).resolves.toBeUndefined();
    await expect(ids.store(3, 'tab-2')).resolves.toBeUndefined();
    await expect(ids.forget(3)).resolves.toBeUndefined();
  });
});

describe('createReconnect: scheduler, persisted state and alarms', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(initial: Record<string, unknown> = {}) {
    const clock = createManualClock(1_000_000);
    const alarms = createMemoryAlarms(clock);
    const store = memoryStorage(initial);
    const tabs = new TabRegistry<TabConnection>();
    const tabExists = vi.fn((_tabId: number) => Promise.resolve({}));
    const connect = vi.fn((_tabId: number) => Promise.resolve<ConnectResult>({ ok: true }));
    const reconnect = createReconnect({
      storage: store.storage,
      alarms,
      clock,
      tabs,
      tabExists,
      connect,
    });
    return { clock, alarms, store, tabs, tabExists, connect, reconnect };
  }

  test('a scheduled attempt is mirrored to storage and arms an alarm at least ALARM_MIN_DELAY_MS away', async () => {
    const { reconnect, store, alarms } = setup();
    reconnect.scheduler.schedule(4);
    await flush();
    const key = reconnectStorageKey(4);
    const delay = RECONNECT_DELAYS_MS[0]!;
    expect(store.data[key]).toEqual({
      attempt: 0,
      updatedAt: 1_000_000,
      dueAt: 1_000_000 + delay,
    });
    expect(alarms.armed.get(key)).toBe(1_000_000 + Math.max(delay, ALARM_MIN_DELAY_MS));
  });

  test('cancel clears the stored state and the alarm', async () => {
    const { reconnect, store, alarms } = setup();
    reconnect.scheduler.schedule(4);
    await flush();
    reconnect.scheduler.cancel(4);
    await flush();
    expect(store.data).toEqual({});
    expect(alarms.armed.size).toBe(0);
  });

  test('an attempt connects the tab and ends the cycle on success', async () => {
    const { reconnect, connect, store } = setup();
    reconnect.scheduler.schedule(4);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]!);
    await flush();
    expect(connect).toHaveBeenCalledWith(4);
    expect(reconnect.scheduler.isPending(4)).toBe(false);
    expect(store.data).toEqual({});
  });

  test('an attempt stops when the Chrome tab is gone', async () => {
    const { reconnect, connect, tabExists } = setup();
    tabExists.mockRejectedValueOnce(new Error('No tab with id: 4'));
    reconnect.scheduler.schedule(4);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]!);
    await flush();
    expect(connect).not.toHaveBeenCalled();
    expect(reconnect.scheduler.isPending(4)).toBe(false);
  });

  test('an attempt retries while the connect fails or throws', async () => {
    const { reconnect, connect } = setup();
    connect.mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error('boom'));
    reconnect.scheduler.schedule(4);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]!);
    await flush();
    expect(reconnect.scheduler.isPending(4)).toBe(true);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[1]!);
    await flush();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(reconnect.scheduler.isPending(4)).toBe(true);
  });

  test('a live connection whose socket is open ends the cycle; one still connecting retries', async () => {
    const { reconnect, tabs, connect } = setup();
    const conn = connection(4);
    const reservation = tabs.reserve(4)!;
    tabs.commit(reservation, conn);
    conn.ws = fakeSocket('ws://x');
    reconnect.scheduler.schedule(4);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]!);
    await flush();
    expect(reconnect.scheduler.isPending(4)).toBe(true);
    (conn.ws as FakeSocket).readyState = SOCKET_OPEN;
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[1]!);
    await flush();
    expect(reconnect.scheduler.isPending(4)).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });

  test('a reconnect alarm resumes a stored cycle; another alarm reads nothing', async () => {
    const key = reconnectStorageKey(4);
    const { reconnect, clock, store } = setup();
    store.data[key] = { attempt: 2, updatedAt: clock.now(), dueAt: clock.now() + 5_000 };
    const get = vi.spyOn(store.storage, 'get');
    reconnect.onAlarm('browser-link-contract:x');
    await flush();
    expect(get).not.toHaveBeenCalled();
    reconnect.onAlarm(key);
    await flush();
    expect(get).toHaveBeenCalledWith(null);
    expect(reconnect.scheduler.isPending(4)).toBe(true);
  });

  test('resume discards stale entries and skips tabs cancelled meanwhile', async () => {
    const { reconnect, clock, store } = setup();
    store.data[reconnectStorageKey(4)] = { attempt: 1, updatedAt: 1, dueAt: 2 };
    store.data[reconnectStorageKey(5)] = {
      attempt: 1,
      updatedAt: clock.now(),
      dueAt: clock.now() + 1_000,
    };
    const resumed = reconnect.resume();
    reconnect.scheduler.cancel(5);
    await resumed;
    await flush();
    expect(reconnect.scheduler.isPending(4)).toBe(false);
    expect(reconnect.scheduler.isPending(5)).toBe(false);
    expect(store.data[reconnectStorageKey(4)]).toBeUndefined();
  });

  test('alarm and storage failures never break the cycle', async () => {
    const { reconnect, store, alarms } = setup();
    vi.spyOn(alarms, 'set').mockRejectedValue(new Error('alarms down'));
    vi.spyOn(alarms, 'clear').mockRejectedValue(new Error('alarms down'));
    store.fail();
    reconnect.scheduler.schedule(4);
    await flush();
    expect(reconnect.scheduler.isPending(4)).toBe(true);
    reconnect.scheduler.cancel(4);
    await flush();
    await expect(reconnect.resume()).resolves.toBeUndefined();
  });
});

describe('tabStatus and disconnectTab', () => {
  test('a live tab is connected with its server id; a pending or reserved one is reconnecting', () => {
    const tabs = new TabRegistry<TabConnection>();
    const pending = new Set<number>([2]);
    const scheduler = { isPending: (id: number) => pending.has(id) } as never;
    const conn = connection(1);
    conn.serverTabId = 'tab-1';
    tabs.commit(tabs.reserve(1)!, conn);
    tabs.reserve(3);
    expect(tabStatus(tabs, scheduler, 1)).toEqual({ connected: true, serverTabId: 'tab-1' });
    expect(tabStatus(tabs, scheduler, 2)).toEqual({ connected: false, reconnecting: true });
    expect(tabStatus(tabs, scheduler, 3)).toEqual({ connected: false, reconnecting: true });
    expect(tabStatus(tabs, scheduler, 4)).toEqual({ connected: false });
  });

  test('disconnect cancels the reconnect first, then cleans up, then forgets the id', async () => {
    const order: string[] = [];
    const store = memoryStorage({ 'prevTabId:3': 'tab-1' });
    const result = await disconnectTab(3, {
      scheduler: { cancel: () => order.push('cancel') } as never,
      cleanup: () => {
        order.push('cleanup');
        return Promise.resolve();
      },
      tabIds: createTabIds(store.storage),
    });
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['cancel', 'cleanup']);
    expect(store.data).toEqual({});
  });
});

describe('round trips over any open socket', () => {
  test('anyOpenSocket picks the first open socket of a connected tab', () => {
    const tabs = new TabRegistry<TabConnection>();
    const a = connection(1);
    const b = connection(2);
    a.ws = fakeSocket('a');
    b.ws = fakeSocket('b');
    (b.ws as FakeSocket).readyState = SOCKET_OPEN;
    tabs.commit(tabs.reserve(1)!, a);
    expect(anyOpenSocket(tabs)).toBeUndefined();
    tabs.commit(tabs.reserve(2)!, b);
    expect(anyOpenSocket(tabs)).toBe(b.ws);
  });

  test('roundTrip sends the frame with a fresh id and resolves with its reply or its timeout', async () => {
    const clock = createManualClock(0);
    const pending = new PendingReplies<string>(clock);
    const socket = fakeSocket('s');
    const answer = roundTrip(
      pending,
      socket,
      (request_id) => ({ kind: 'bridge.repair', request_id }),
      100,
      (id) => `timeout ${id}`,
    );
    const sent = socket.sent[0] as { kind: string; request_id: string };
    expect(sent.kind).toBe('bridge.repair');
    pending.settle(sent.request_id, 'reply');
    await expect(answer).resolves.toBe('reply');
    const late = roundTrip(
      pending,
      socket,
      (request_id) => ({ kind: 'bridge.repair', request_id }),
      100,
      (id) => `timeout ${id}`,
    );
    const second = socket.sent[1] as { request_id: string };
    expect(second.request_id).not.toBe(sent.request_id);
    await clock.advance(100);
    await expect(late).resolves.toBe(`timeout ${second.request_id}`);
  });
});
