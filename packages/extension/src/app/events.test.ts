// The bridge events on a tab's socket (design 6.1, slice 21c) on fake sockets:
// the core's events through `EventsOut` (`adapters/ws-events-out.ts` over
// `emitBridgeEvent`, also held to the core `EventsOut` contract here) and the
// page observer's top-document reports.
import { describe, expect, it } from 'vitest';
import type { ExtensionToServer } from '@browser-link/shared';
import {
  createManualClock,
  defineEventsOutContract,
  TabRegistry,
  TabSession,
  type ContractCase,
  type PageDriverHandle,
} from '@browser-link/core';
import { createWsEventsOut } from '../adapters/ws-events-out.js';
import { emitBridgeEvent, reportTopDocument } from './events.js';
import {
  newTabConnection,
  SOCKET_CLOSED,
  SOCKET_OPEN,
  type BridgeSocket,
  type TabConnection,
} from './tab-connection.js';

function connection(
  tabId: number,
  { readyState = SOCKET_OPEN, serverTabId = 'S1' as string | null, title = 'T' } = {},
) {
  const sent: ExtensionToServer[] = [];
  const page = {
    info: () => (title === '!' ? Promise.reject(new Error('closing')) : Promise.resolve({ title })),
  };
  const driver = { observer: undefined, page } as unknown as PageDriverHandle;
  const conn = newTabConnection(
    tabId,
    new TabSession({ clock: createManualClock(0), driver }),
    new Set(),
  );
  conn.serverTabId = serverTabId ?? undefined;
  conn.ws = {
    readyState,
    send: (data: string) => {
      sent.push(JSON.parse(data) as ExtensionToServer);
    },
  } as unknown as BridgeSocket;
  return { conn, sent };
}

const EVENT = { eventKind: 'flow-finished', data: { flow_id: 'f1' } };

describe('emitBridgeEvent', () => {
  it('sends a bridge.event with the server tab id once registered, and answers true', () => {
    const { conn, sent } = connection(1);
    expect(emitBridgeEvent(conn, EVENT)).toBe(true);
    expect(sent).toEqual([
      { kind: 'bridge.event', eventKind: 'flow-finished', tabId: 'S1', data: { flow_id: 'f1' } },
    ]);
  });

  it('an open socket not registered yet: sent without a tab id', () => {
    const { conn, sent } = connection(1, { serverTabId: null });
    expect(emitBridgeEvent(conn, EVENT)).toBe(true);
    expect(sent).toEqual([
      { kind: 'bridge.event', eventKind: 'flow-finished', data: { flow_id: 'f1' } },
    ]);
  });

  it('a closed socket, no socket or no connection: false and nothing sent', () => {
    const closed = connection(1, { readyState: SOCKET_CLOSED });
    expect(emitBridgeEvent(closed.conn, EVENT)).toBe(false);
    expect(closed.sent).toEqual([]);
    const bare = connection(2);
    bare.conn.ws = undefined;
    expect(emitBridgeEvent(bare.conn, EVENT)).toBe(false);
    expect(emitBridgeEvent(undefined, EVENT)).toBe(false);
  });
});

describe('EventsOut contract: the ws-events-out adapter on fake sockets', () => {
  const cases: ContractCase[] = defineEventsOutContract(() => {
    const tabs = new TabRegistry<TabConnection>();
    let next = 0;
    const tab = (readyState: number) => {
      const tabId = ++next;
      const { conn, sent } = connection(tabId, { readyState });
      tabs.commit(tabs.reserve(tabId)!, conn);
      return {
        tabId,
        received: () =>
          sent.map((f) => ({
            eventKind: (f as { eventKind: string }).eventKind,
            data: (f as { data: Record<string, unknown> }).data,
          })),
      };
    };
    return {
      events: createWsEventsOut(tabs),
      openTab: () => tab(SOCKET_OPEN),
      closedTab: () => tab(SOCKET_CLOSED),
    };
  });
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
});

describe('reportTopDocument', () => {
  it('doc_info: a tab-doc-info event once registered, nothing before', async () => {
    const info = { kind: 'doc_info', url: 'u', build: 'b', view_sig: 'v', title: 't' } as const;
    const registered = connection(1);
    await reportTopDocument(registered.conn, info);
    expect(registered.sent).toEqual([
      {
        kind: 'bridge.event',
        eventKind: 'tab-doc-info',
        tabId: 'S1',
        data: { url: 'u', build: 'b', view_sig: 'v', title: 't' },
      },
    ]);
    const unregistered = connection(2, { serverTabId: null });
    await reportTopDocument(unregistered.conn, info);
    expect(unregistered.sent).toEqual([]);
  });

  it('doc_start and nav: a tab-navigated event with the page title', async () => {
    const { conn, sent } = connection(1, { title: 'Shop' });
    await reportTopDocument(conn, { kind: 'doc_start', url: 'https://a/' });
    await reportTopDocument(conn, { kind: 'nav', url: 'https://a/b' });
    expect(sent.map((f) => (f as { data: unknown }).data)).toEqual([
      { url: 'https://a/', title: 'Shop' },
      { url: 'https://a/b', title: 'Shop' },
    ]);
  });

  it('a title that cannot be read: the URL still goes, with an empty title', async () => {
    const { conn, sent } = connection(1, { title: '!' });
    await reportTopDocument(conn, { kind: 'nav', url: 'https://a/' });
    expect(sent).toEqual([
      {
        kind: 'bridge.event',
        eventKind: 'tab-navigated',
        tabId: 'S1',
        data: { url: 'https://a/', title: '' },
      },
    ]);
  });

  it('summary and ignored messages send nothing', async () => {
    const { conn, sent } = connection(1);
    await reportTopDocument(conn, { kind: 'summary' });
    await reportTopDocument(conn, { kind: 'ignored' });
    expect(sent).toEqual([]);
  });
});
