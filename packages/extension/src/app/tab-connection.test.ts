// TabConnection: the debugger intake into its TabSession, the CDP event
// fan-out, and the teardown (design section 4), on fakes.
import { describe, expect, test, vi } from 'vitest';
import {
  createManualClock,
  NETWORK_BUFFER_MAX,
  TabRegistry,
  TabSession,
  type PageDriverHandle,
} from '@browser-link/core';
import {
  closeTabConnection,
  debuggerIntake,
  deliverCdpEvent,
  newTabConnection,
  type TabConnection,
  type TeardownDeps,
} from './tab-connection.js';

interface FakeSocket {
  readyState: number;
  sent: unknown[];
  closed: number;
  send(data: string): void;
  close(): void;
}

function fakeSocket(readyState: number = WebSocket.OPEN): FakeSocket {
  return {
    readyState,
    sent: [],
    closed: 0,
    send(data) {
      this.sent.push(JSON.parse(data));
    },
    close() {
      this.closed++;
    },
  };
}

function connection(tabId = 7) {
  const clock = createManualClock(1_000);
  const uninstall = vi.fn(async () => undefined);
  const driver = { uninstall } as unknown as PageDriverHandle;
  const conn = newTabConnection(tabId, new TabSession({ clock, driver }), new Set());
  const capped = vi.fn();
  conn.debuggerListener = debuggerIntake(conn, { clock, onRecordingCapped: capped });
  return { clock, conn, uninstall, capped };
}

function registered(conn: TabConnection, socket = fakeSocket()): FakeSocket {
  conn.ws = socket as unknown as WebSocket;
  conn.serverTabId = 'tab-1';
  return socket;
}

describe('TabConnection: debugger intake', () => {
  test('console and log entries go into the session with normalised levels', () => {
    const { conn } = connection();
    deliverCdpEvent(conn, 'Runtime.consoleAPICalled', {
      type: 'warning',
      timestamp: 5,
      args: [{ value: 'a' }, { value: { b: 1 } }, { description: 'd' }],
    });
    deliverCdpEvent(conn, 'Log.entryAdded', {
      entry: { level: 'verbose', text: 't', url: 'u', lineNumber: 3 },
    });
    expect(conn.session.consoleBuffer).toEqual([
      { timestamp: 5, level: 'warn', text: 'a {"b":1} d', source: 'console' },
      { timestamp: 1_000, level: 'debug', text: 't', source: 'log', url: 'u', line: 3 },
    ]);
  });

  test('network events fill one bounded entry per request', async () => {
    const { clock, conn } = connection();
    deliverCdpEvent(conn, 'Network.requestWillBeSent', {
      requestId: 'r1',
      type: 'Fetch',
      request: { url: 'https://x.test/a', method: 'POST', postData: 'p' },
    });
    deliverCdpEvent(conn, 'Network.responseReceived', {
      requestId: 'r1',
      response: { status: 201, statusText: 'Created', mimeType: 'application/json' },
    });
    await clock.advance(30);
    deliverCdpEvent(conn, 'Network.loadingFinished', { requestId: 'r1', encodedDataLength: 9 });
    deliverCdpEvent(conn, 'Network.loadingFailed', { requestId: 'r2' });
    expect(conn.session.networkBuffer.get('r1')).toMatchObject({
      url: 'https://x.test/a',
      method: 'POST',
      resource_type: 'Fetch',
      request_post_data: 'p',
      status: 201,
      status_text: 'Created',
      mime_type: 'application/json',
      started_at: 1_000,
      finished_at: 1_030,
      encoded_data_length: 9,
    });
    expect(conn.session.networkBuffer.get('r2')).toMatchObject({ failed: 'failed' });
    for (let i = 0; i < NETWORK_BUFFER_MAX; i++) {
      deliverCdpEvent(conn, 'Network.loadingFinished', { requestId: `n${i}` });
    }
    expect(conn.session.networkOrder).toHaveLength(NETWORK_BUFFER_MAX);
    expect(conn.session.networkBuffer.has('r1')).toBe(false);
  });

  test('a dialog sets the one pending dialog and is reported once the tab is registered', () => {
    const { conn } = connection();
    deliverCdpEvent(conn, 'Page.javascriptDialogOpening', { type: 'prompt', message: 'm' });
    expect(conn.session.pendingDialog).toEqual({ type: 'prompt', message: 'm' });
    const socket = registered(conn);
    deliverCdpEvent(conn, 'Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'sure?',
      defaultPrompt: 'x',
      url: 'https://x.test/',
    });
    expect(conn.session.pendingDialog).toEqual({
      type: 'confirm',
      message: 'sure?',
      default_prompt: 'x',
      url: 'https://x.test/',
    });
    deliverCdpEvent(conn, 'Page.javascriptDialogClosed', { result: true, userInput: 'y' });
    expect(conn.session.pendingDialog).toBeUndefined();
    expect(socket.sent).toEqual([
      {
        kind: 'bridge.event',
        eventKind: 'dialog-opening',
        tabId: 'tab-1',
        data: { type: 'confirm', message: 'sure?', default_prompt: 'x', url: 'https://x.test/' },
      },
      {
        kind: 'bridge.event',
        eventKind: 'dialog-closed',
        tabId: 'tab-1',
        data: { accept: true, user_input: 'y' },
      },
    ]);
  });

  test('a closed socket gets no dialog event', () => {
    const { conn } = connection();
    const socket = registered(conn, fakeSocket(WebSocket.CLOSING));
    deliverCdpEvent(conn, 'Page.javascriptDialogClosed', {});
    expect(socket.sent).toEqual([]);
  });

  test('every CDP event also reaches the other listeners; a missing connection is a no-op', () => {
    const { conn } = connection();
    const seen: string[] = [];
    conn.eventListeners.add((method) => seen.push(method));
    deliverCdpEvent(conn, 'Runtime.bindingCalled', { name: 'other' });
    deliverCdpEvent(undefined, 'Page.frameNavigated', {});
    expect(seen).toEqual(['Runtime.bindingCalled']);
  });

  test('a recorder binding call without the session nonce records nothing', () => {
    const { conn, capped } = connection();
    conn.recording = {
      status: 'recording',
      steps: [],
      lastUrl: '',
      capped: false,
      bindingName: 'b',
      activeFlag: 'f',
      stopFn: 's',
      nonce: 'n',
      ambiguousStepIndices: [],
    };
    deliverCdpEvent(conn, 'Runtime.bindingCalled', {
      name: 'b',
      payload: JSON.stringify({ nonce: 'wrong', kind: 'click', selector: '#a' }),
    });
    expect(conn.recording.steps).toEqual([]);
    expect(capped).not.toHaveBeenCalled();
  });
});

describe('TabConnection: teardown', () => {
  function deps(order: string[]): TeardownDeps {
    return {
      cancelFlows: (id) => order.push(`flows ${id}`),
      removeRecordingNavListener: (id) => order.push(`nav ${id}`),
      teardownRecorder: async (id, stopFn) => {
        order.push(`recorder ${id} ${stopFn}`);
      },
      detachDebugger: async (id) => {
        order.push(`detach ${id}`);
      },
    };
  }

  function live(conn: TabConnection): TabRegistry<TabConnection> {
    const tabs = new TabRegistry<TabConnection>();
    const r = tabs.reserve(conn.tabId)!;
    tabs.commit(r, conn);
    tabs.release(r);
    return tabs;
  }

  test('removes the connection synchronously, then flows, recording, socket and debugger in order', async () => {
    const { conn, uninstall } = connection();
    const socket = registered(conn);
    conn.recording = {
      status: 'reviewing',
      steps: [],
      lastUrl: '',
      capped: false,
      bindingName: 'b',
      activeFlag: 'f',
      stopFn: 'stop',
      nonce: 'n',
      ambiguousStepIndices: [],
    };
    const tabs = live(conn);
    const order: string[] = [];
    const done = closeTabConnection(tabs, 7, deps(order));
    expect(tabs.has(7)).toBe(false);
    expect(order).toEqual(['flows 7', 'nav 7', 'recorder 7 stop']);
    await done;
    expect(socket.closed).toBe(1);
    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['flows 7', 'nav 7', 'recorder 7 stop', 'detach 7']);
  });

  test('a re-entrant or unknown teardown is a no-op', async () => {
    const { conn } = connection();
    const socket = registered(conn);
    const tabs = live(conn);
    const order: string[] = [];
    await Promise.all([
      closeTabConnection(tabs, 7, deps(order)),
      closeTabConnection(tabs, 7, deps(order)),
    ]);
    await closeTabConnection(tabs, 8, deps(order));
    expect(order).toEqual(['flows 7', 'nav 7', 'detach 7']);
    expect(socket.closed).toBe(1);
  });

  test('a closed socket is not closed again; a detached debugger is not detached again', async () => {
    const { conn, uninstall } = connection();
    const socket = registered(conn, fakeSocket(WebSocket.CLOSED));
    conn.debuggerAttached = false;
    const order: string[] = [];
    await closeTabConnection(live(conn), 7, deps(order));
    expect(socket.closed).toBe(0);
    expect(uninstall).not.toHaveBeenCalled();
    expect(order).toEqual(['flows 7', 'nav 7']);
  });

  test('a failing close or detach does not fail the teardown', async () => {
    const { conn } = connection();
    const socket = registered(conn);
    socket.close = () => {
      throw new Error('close');
    };
    const failing = deps([]);
    failing.detachDebugger = () => Promise.reject(new Error('detach'));
    await expect(closeTabConnection(live(conn), 7, failing)).resolves.toBeUndefined();
  });
});
