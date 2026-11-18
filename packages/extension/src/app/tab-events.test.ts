// What the worker does on tab events (design 6.1, slice 21) on fakes: a
// closed tab, a tab a connected tab opened (auto-connect for
// `browser.wait_for_tab`), and a debugger the browser detached.
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionToServer } from '@browser-link/shared';
import {
  createManualClock,
  TabRegistry,
  TabSession,
  type PageDriverHandle,
} from '@browser-link/core';
import { createMemoryTabEvents } from '../../contract/memory-tab-events.js';
import type { ReconnectScheduler } from '../reconnect-policy.js';
import type { ConnectResult } from './connection.js';
import {
  newTabConnection,
  SOCKET_OPEN,
  type BridgeSocket,
  type TabConnection,
} from './tab-connection.js';
import {
  createTabEventHandlers,
  OPENED_TAB_URL_POLL_MS,
  OPENED_TAB_URL_WAIT_MS,
} from './tab-events.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function openSocket(): BridgeSocket & { sent: ExtensionToServer[] } {
  const sent: ExtensionToServer[] = [];
  return {
    readyState: SOCKET_OPEN,
    sent,
    send: (data: string) => {
      sent.push(JSON.parse(data) as ExtensionToServer);
    },
    close: () => undefined,
    addEventListener: () => undefined,
  } as unknown as BridgeSocket & { sent: ExtensionToServer[] };
}

function harness() {
  const clock = createManualClock(1_000);
  const tabs = new TabRegistry<TabConnection>();
  const tabEvents = createMemoryTabEvents();
  const scheduler = { cancel: vi.fn(() => false) } as unknown as ReconnectScheduler;
  const tabIds = { forget: vi.fn(() => Promise.resolve()) };
  const socket = openSocket();
  const add = (tabId: number, serverTabId?: string): TabConnection => {
    const driver = { observer: undefined } as unknown as PageDriverHandle;
    const state = newTabConnection(tabId, new TabSession({ clock, driver }), new Set());
    state.serverTabId = serverTabId;
    state.ws = socket;
    tabs.commit(tabs.reserve(tabId)!, state);
    return state;
  };
  const deps = {
    tabs,
    tabEvents,
    clock,
    scheduler,
    tabIds,
    connect: vi.fn((tabId: number): Promise<ConnectResult> => {
      add(tabId, `S${String(tabId)}`);
      return Promise.resolve({ ok: true, serverTabId: `S${String(tabId)}` });
    }),
    cleanup: vi.fn(() => Promise.resolve()),
    dropFlowHistory: vi.fn(),
  };
  const handlers = createTabEventHandlers(deps);
  tabEvents.onCreated((tab) => {
    handlers.created(tab);
  });
  return { clock, tabs, tabEvents, deps, handlers, socket, add };
}

describe('tab events: a closed tab', () => {
  it('cancels its reconnect, tears it down, forgets its id and drops its flow history', () => {
    const { deps, handlers } = harness();
    handlers.removed(4);
    expect(deps.scheduler.cancel).toHaveBeenCalledWith(4);
    expect(deps.cleanup).toHaveBeenCalledWith(4);
    expect(deps.tabIds.forget).toHaveBeenCalledWith(4);
    expect(deps.dropFlowHistory).toHaveBeenCalledWith(4);
  });

  it('a failed teardown stays quiet', async () => {
    const { deps, handlers } = harness();
    deps.cleanup.mockReturnValueOnce(Promise.reject(new Error('gone')));
    handlers.removed(4);
    await flush();
    expect(deps.dropFlowHistory).toHaveBeenCalledWith(4);
  });
});

describe('tab events: a debugger the browser detached', () => {
  it('marks a connected tab detached and tears it down', () => {
    const { deps, handlers, add } = harness();
    const state = add(3, 'S3');
    state.debuggerAttached = true;
    handlers.debuggerDetached(3);
    expect(state.debuggerAttached).toBe(false);
    expect(deps.cleanup).toHaveBeenCalledWith(3);
  });

  it('ignores a target that is not a tab, and a tab with no connection', () => {
    const { deps, handlers } = harness();
    handlers.debuggerDetached(undefined);
    handlers.debuggerDetached(3);
    expect(deps.cleanup).not.toHaveBeenCalled();
  });
});

describe('tab events: a tab opened by a connected tab', () => {
  it('connects it once it has a URL and announces it as tab-created', async () => {
    const { tabEvents, deps, add, socket, clock } = harness();
    const opener = tabEvents.create({ url: 'https://a.example/' });
    add(opener, 'S1');
    const child = tabEvents.create({}, opener);
    await flush();
    expect(deps.connect).not.toHaveBeenCalled();
    tabEvents.tabs.set(child, { url: 'https://b.example/', pendingUrl: 'https://c.example/' });
    await clock.advance(OPENED_TAB_URL_POLL_MS);
    await flush();
    expect(deps.connect).toHaveBeenCalledWith(child);
    expect(socket.sent).toEqual([
      {
        kind: 'bridge.event',
        eventKind: 'tab-created',
        tabId: `S${String(child)}`,
        data: { opened_from: 'S1', url: 'https://b.example/' },
      },
    ]);
  });

  it('gives up when the tab reports no URL within the wait', async () => {
    const { tabEvents, deps, add, clock } = harness();
    const opener = tabEvents.create({ url: 'https://a.example/' });
    add(opener, 'S1');
    tabEvents.create({}, opener);
    for (let t = 0; t <= OPENED_TAB_URL_WAIT_MS; t += OPENED_TAB_URL_POLL_MS) {
      await clock.advance(OPENED_TAB_URL_POLL_MS);
      await flush();
    }
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it('gives up when the tab closes during the wait', async () => {
    const { tabEvents, deps, add, clock } = harness();
    const opener = tabEvents.create({ url: 'https://a.example/' });
    add(opener, 'S1');
    const child = tabEvents.create({}, opener);
    tabEvents.close(child);
    await clock.advance(OPENED_TAB_URL_POLL_MS);
    await flush();
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it('ignores a tab with no opener, an opener not connected, or one not registered yet', async () => {
    const { tabEvents, deps, add } = harness();
    tabEvents.create({ url: 'https://a.example/' });
    const stranger = tabEvents.create({ url: 'https://a.example/' });
    tabEvents.create({ url: 'https://b.example/' }, stranger);
    const unregistered = tabEvents.create({ url: 'https://a.example/' });
    add(unregistered);
    tabEvents.create({ url: 'https://b.example/' }, unregistered);
    await flush();
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it('announces nothing when the connect fails', async () => {
    const { tabEvents, deps, add, socket } = harness();
    deps.connect.mockResolvedValueOnce({ ok: false, error: 'x' });
    const opener = tabEvents.create({ url: 'https://a.example/' });
    add(opener, 'S1');
    tabEvents.create({ url: 'https://b.example/' }, opener);
    await flush();
    expect(deps.connect).toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
  });
});
