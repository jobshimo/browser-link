// Connecting a tab and the page driver wiring (design 6.1, slice 21d) on
// fakes: in-memory CDP sessions and page info, fake tab events, a fake
// debugger attach and detach, and a fake socket.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionToServer } from '@browser-link/shared';
import {
  createFlowHistory,
  createFlowRegistry,
  createManualClock,
  createMemoryCdpSession,
  createMemoryDetachedFlowStore,
  createMemoryFlowHistoryStore,
  createMemoryPageInfo,
  PendingReplies,
  TabRegistry,
  type CdpSession,
} from '@browser-link/core';
import type { ReconnectScheduler } from '../reconnect-policy.js';
import { CONNECT_IN_PROGRESS_ERROR } from '../reconnect-policy.js';
import { createMemoryTabEvents } from '../../contract/memory-tab-events.js';
import { createConnect, createTabDrivers, EXTENSION_PROVIDES } from './connect.js';
import type { TabIds } from './connection.js';
import {
  SOCKET_CLOSED,
  SOCKET_OPEN,
  type BridgeSocket,
  type TabConnection,
} from './tab-connection.js';

type Listener = (event?: unknown) => void;

function fakeSocket() {
  const listeners = new Map<string, Listener[]>();
  const sent: ExtensionToServer[] = [];
  const socket = {
    readyState: 0,
    sent,
    send: (data: string) => {
      sent.push(JSON.parse(data) as ExtensionToServer);
    },
    close: () => {
      socket.readyState = SOCKET_CLOSED;
    },
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    emit: (type: string, event?: unknown) => {
      if (type === 'open') socket.readyState = SOCKET_OPEN;
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
  return socket;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const DOMAINS = ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable', 'DOM.enable'];

function harness({ failing = '' as string, attachError = '' } = {}) {
  const clock = createManualClock(1_000);
  const tabs = new TabRegistry<TabConnection>();
  const tabEvents = createMemoryTabEvents();
  const commands: { tabId: number; method: string }[] = [];
  const sessions: CdpSession[] = [];
  const cdpSession = vi.fn((tabId: number) => {
    const handlers = Object.fromEntries(
      DOMAINS.map((m) => [
        m,
        () => {
          commands.push({ tabId, method: m });
          if (m === failing) throw new Error(`${m} failed`);
          return {};
        },
      ]),
    );
    const session = createMemoryCdpSession(handlers);
    sessions.push(session);
    return session;
  });
  const downloads = vi.fn(() => ({}) as never);
  const contentSettings = vi.fn(() => ({}) as never);
  const drivers = createTabDrivers({
    tabs,
    clock,
    cdpSession,
    pageInfo: (_tabId, c) => createMemoryPageInfo({ url: 'https://a.example/', title: 'A' }, c),
    downloads,
    contentSettings,
  });
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const attached: number[] = [];
  const detached: number[] = [];
  const tabIds: TabIds = {
    previous: vi.fn(() => Promise.resolve('tab-9')),
    store: vi.fn(() => Promise.resolve()),
    forget: vi.fn(() => Promise.resolve()),
  };
  const history = createFlowHistory({
    history: createMemoryFlowHistoryStore(),
    detached: createMemoryDetachedFlowStore(),
    clock,
    events: { emit: () => true },
    onRecordLost: () => undefined,
  });
  const cleanup = vi.fn((id: number) => {
    tabs.remove(id);
    return Promise.resolve();
  });
  const connect = createConnect({
    tabs,
    clock,
    drivers,
    tabEvents,
    attachDebugger: (tabId) => {
      if (attachError) return Promise.reject(new Error(attachError));
      attached.push(tabId);
      return Promise.resolve();
    },
    detachDebugger: (tabId) => {
      detached.push(tabId);
      return Promise.resolve();
    },
    tabIds,
    flows: createFlowRegistry(clock),
    history,
    tabTitle: () => Promise.resolve('A'),
    recordingCapped: vi.fn(),
    cleanup,
    bridge: {
      openSocket: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket as unknown as BridgeSocket;
      },
      url: 'ws://127.0.0.1:17529',
      replies: {
        activity: new PendingReplies(clock),
        admin: new PendingReplies(clock),
        repair: new PendingReplies(clock),
      },
      applySettings: vi.fn(),
      scheduler: { cancel: vi.fn(() => false) } as unknown as ReconnectScheduler,
      extensionVersion: () => '1.4.33',
      diagnose: () => Promise.resolve({ code: 'ws-connect-failed' as const }),
    },
  });
  return {
    clock,
    tabs,
    tabEvents,
    drivers,
    connect,
    commands,
    sessions,
    cdpSession,
    downloads,
    contentSettings,
    sockets,
    attached,
    detached,
    cleanup,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('connectTab', () => {
  it('attaches, enables the five domains in order, opens the socket and registers the tab', async () => {
    const h = harness();
    const tabId = h.tabEvents.create({ url: 'https://a.example/', title: 'A' });
    let result: unknown;
    void h.connect.connectTab(tabId).then((r) => {
      result = r;
    });
    await flush();
    expect(h.attached).toEqual([tabId]);
    expect(h.commands.map((c) => c.method)).toEqual(DOMAINS);
    const socket = h.sockets[0]!;
    socket.emit('open');
    expect(socket.sent).toEqual([
      {
        kind: 'tab.register',
        payload: {
          url: 'https://a.example/',
          title: 'A',
          previousTabId: 'tab-9',
          extensionVersion: '1.4.33',
        },
      },
    ]);
    socket.emit('message', {
      data: JSON.stringify({ kind: 'tab.registered', payload: { tabId: 'S1' } }),
    });
    await flush();
    expect(result).toEqual({ ok: true, serverTabId: 'S1' });
    expect(h.tabs.get(tabId)?.serverTabId).toBe('S1');
    expect(h.tabs.isReserved(tabId)).toBe(false);
  });

  it('a second connect while one is in flight answers the in-progress error', async () => {
    const h = harness();
    const tabId = h.tabEvents.create({ url: 'https://a.example/', title: 'A' });
    void h.connect.connectTab(tabId);
    expect(await h.connect.connectTab(tabId)).toEqual({
      ok: false,
      error: CONNECT_IN_PROGRESS_ERROR,
    });
  });

  it('a tab without a URL or a title is refused before any attach', async () => {
    const h = harness();
    const tabId = h.tabEvents.create({ url: 'https://a.example/' });
    expect(await h.connect.connectTab(tabId)).toMatchObject({ ok: false, code: 'tab-no-url' });
    expect(h.attached).toEqual([]);
    expect(h.tabs.isReserved(tabId)).toBe(false);
  });

  it('an attach that fails answers its text and connects nothing', async () => {
    const h = harness({ attachError: 'Another debugger is already attached' });
    const tabId = h.tabEvents.create({ url: 'https://a.example/', title: 'A' });
    const result = await h.connect.connectTab(tabId);
    expect(result).toMatchObject({
      ok: false,
      code: 'debugger-attach-failed',
      values: { detail: 'Another debugger is already attached' },
    });
    expect(h.tabs.has(tabId)).toBe(false);
  });

  it('a domain that fails to enable tears the tab down and answers its text', async () => {
    const h = harness({ failing: 'Network.enable' });
    const tabId = h.tabEvents.create({ url: 'https://a.example/', title: 'A' });
    const result = await h.connect.connectTab(tabId);
    expect(result).toMatchObject({
      ok: false,
      code: 'cdp-enable-failed',
      values: { detail: 'Network.enable failed' },
    });
    expect(h.cleanup).toHaveBeenCalledWith(tabId);
    expect(h.sockets).toEqual([]);
  });

  it('an already connected tab is refused', async () => {
    const h = harness();
    const tabId = h.tabEvents.create({ url: 'https://a.example/', title: 'A' });
    void h.connect.connectTab(tabId);
    await flush();
    await expect(
      (async () => {
        // The first attempt still holds the reservation: release it the way
        // a finished attempt does, by registering.
        h.sockets[0]!.emit('open');
        h.sockets[0]!.emit('message', {
          data: JSON.stringify({ kind: 'tab.registered', payload: { tabId: 'S1' } }),
        });
        await flush();
        return h.connect.connectTab(tabId);
      })(),
    ).resolves.toMatchObject({ ok: false, code: 'tab-already-connected' });
  });

  it('a closed tab rejects the connect, as the browser read does', async () => {
    const h = harness();
    await expect(h.connect.connectTab(99)).rejects.toThrow('No tab');
    expect(h.tabs.isReserved(99)).toBe(false);
  });
});

describe('page driver wiring', () => {
  it("pageDriver answers the connected tab's driver, and a fresh one otherwise", async () => {
    const h = harness();
    const tabId = h.tabEvents.create({ url: 'https://a.example/', title: 'A' });
    void h.connect.connectTab(tabId);
    await flush();
    const driver = h.tabs.get(tabId)!.session.driver;
    expect(h.drivers.pageDriver(tabId)).toBe(driver);
    expect(h.drivers.pageDriver(42)).not.toBe(driver);
  });

  it('cdp sends on the tab and subscribes nothing', async () => {
    const h = harness();
    await h.drivers.cdp(5, 'Page.enable');
    expect(h.commands).toEqual([{ tabId: 5, method: 'Page.enable' }]);
  });

  it('actionDeps builds the downloads and content settings per call, capture buffers only with a session', () => {
    const h = harness();
    const deps = h.drivers.actionDeps(5);
    h.drivers.actionDeps(5);
    expect(h.downloads.mock.calls).toEqual([[5], [5]]);
    expect(h.contentSettings).toHaveBeenCalledTimes(2);
    expect(deps.captureBuffers).toBeUndefined();
    expect(deps.clock).toBe(h.clock);
  });

  it('the extension provides every requirement but flow-cancel', () => {
    expect(EXTENSION_PROVIDES.has('flow-cancel')).toBe(false);
    expect(EXTENSION_PROVIDES.size).toBe(16);
  });
});

describe('handleTool', () => {
  it('answers an unregistered tool with Unknown tool', async () => {
    const h = harness();
    const tabId = h.tabEvents.create({ url: 'https://a.example/', title: 'A' });
    void h.connect.connectTab(tabId);
    await flush();
    const state = h.tabs.get(tabId)!;
    const answer = await h.connect.handleTool(state, {
      kind: 'tool.request',
      id: 'r1',
      tool: 'no_such_tool',
      params: {},
    } as never);
    expect(answer).toMatchObject({ id: 'r1', ok: false });
    expect(JSON.stringify(answer)).toContain('Unknown tool: no_such_tool');
  });
});
