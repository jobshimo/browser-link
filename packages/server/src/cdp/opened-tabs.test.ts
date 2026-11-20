import { afterEach, describe, expect, test, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  BROWSER_SOCKET_COMMANDS,
  BROWSER_SOCKET_LOST_ERROR,
  createOpenedTabFilter,
  guardBrowserSocket,
  markOpenedTabReturned,
  watchOpenedTabs,
  type BrowserSocket,
  type OpenedTabsDeps,
} from './opened-tabs.js';

const OPENER = 'OPENER1';
const OPENER_TAB = `cdp:${OPENER}`;

function created(info: Record<string, unknown>): [string, unknown] {
  return ['Target.targetCreated', { targetInfo: info }];
}
function changed(info: Record<string, unknown>): [string, unknown] {
  return ['Target.targetInfoChanged', { targetInfo: info }];
}
const openerPage = { targetId: OPENER, type: 'page', url: 'http://127.0.0.1/app', title: '' };

describe('createOpenedTabFilter', () => {
  test('a page opened by a drivable opener is reported with the url of targetInfoChanged', () => {
    const filter = createOpenedTabFilter(OPENER);
    expect(filter(...created(openerPage))).toEqual([]);
    // The first event of a new page carries an empty url (experiment X3).
    expect(
      filter(...created({ targetId: 'NEW', type: 'page', url: '', openerId: OPENER })),
    ).toEqual([]);
    expect(
      filter(
        ...changed({
          targetId: 'NEW',
          type: 'page',
          url: 'http://127.0.0.1/child',
          openerId: OPENER,
        }),
      ),
    ).toEqual([{ targetId: 'NEW', url: 'http://127.0.0.1/child' }]);
  });

  test('a target is reported once, whatever later changes it has', () => {
    const filter = createOpenedTabFilter(OPENER);
    filter(...created(openerPage));
    filter(...created({ targetId: 'NEW', type: 'page', url: '', openerId: OPENER }));
    expect(
      filter(...changed({ targetId: 'NEW', type: 'page', url: 'http://a/1', openerId: OPENER })),
    ).toHaveLength(1);
    expect(
      filter(...changed({ targetId: 'NEW', type: 'page', url: 'http://a/2', openerId: OPENER })),
    ).toEqual([]);
  });

  test("a page opened by another target is ignored (the user's own tabs included)", () => {
    const filter = createOpenedTabFilter(OPENER);
    filter(...created(openerPage));
    filter(...created({ targetId: 'OTHER', type: 'page', url: 'http://x/', title: '' }));
    expect(
      filter(...created({ targetId: 'NEW', type: 'page', url: '', openerId: 'OTHER' })),
    ).toEqual([]);
    expect(
      filter(...changed({ targetId: 'NEW', type: 'page', url: 'http://x/c', openerId: 'OTHER' })),
    ).toEqual([]);
    // A page with no opener at all (typed into the omnibox, Target.createTarget).
    expect(filter(...created({ targetId: 'LONE', type: 'page', url: 'http://x/lone' }))).toEqual(
      [],
    );
  });

  test('a target that is not a page is ignored even with the opener as openerId', () => {
    const filter = createOpenedTabFilter(OPENER);
    filter(...created(openerPage));
    for (const type of ['service_worker', 'worker', 'iframe', 'browser_ui', 'background_page']) {
      expect(
        filter(...created({ targetId: `T-${type}`, type, url: 'http://x/w', openerId: OPENER })),
      ).toEqual([]);
    }
  });

  test('a new page whose url is a DevTools or extension surface is not reported', () => {
    const filter = createOpenedTabFilter(OPENER);
    filter(...created(openerPage));
    filter(...created({ targetId: 'D', type: 'page', url: '', openerId: OPENER }));
    expect(
      filter(
        ...changed({ targetId: 'D', type: 'page', url: 'devtools://devtools/x', openerId: OPENER }),
      ),
    ).toEqual([]);
    filter(...created({ targetId: 'E', type: 'page', url: '', openerId: OPENER }));
    expect(
      filter(
        ...changed({
          targetId: 'E',
          type: 'page',
          url: 'chrome-extension://abc/p.html',
          openerId: OPENER,
        }),
      ),
    ).toEqual([]);
  });

  test('an opener that is not a drivable page target is not a granted cdp tab: nothing is reported', () => {
    // The opener id names an extension page (never a cdp: tab, isDrivablePageTarget).
    const filter = createOpenedTabFilter(OPENER);
    filter(
      ...created({ targetId: OPENER, type: 'page', url: 'chrome-extension://abc/popup.html' }),
    );
    filter(...created({ targetId: 'NEW', type: 'page', url: '', openerId: OPENER }));
    expect(
      filter(...changed({ targetId: 'NEW', type: 'page', url: 'http://x/c', openerId: OPENER })),
    ).toEqual([]);
  });

  test('an opener not seen at all is not reported until discovery lists it as a page', () => {
    const filter = createOpenedTabFilter(OPENER);
    filter(...created({ targetId: 'NEW', type: 'page', url: '', openerId: OPENER }));
    expect(
      filter(...changed({ targetId: 'NEW', type: 'page', url: 'http://x/c', openerId: OPENER })),
    ).toEqual([]);
    expect(filter(...created(openerPage))).toEqual([{ targetId: 'NEW', url: 'http://x/c' }]);
  });

  test('a page the opener opened before discovery started is reported with the url its first event carries', () => {
    const filter = createOpenedTabFilter(OPENER);
    filter(...created(openerPage));
    expect(
      filter(...created({ targetId: 'OLD', type: 'page', url: 'http://x/old', openerId: OPENER })),
    ).toEqual([{ targetId: 'OLD', url: 'http://x/old' }]);
  });

  test('a target destroyed before it was reportable is forgotten', () => {
    const filter = createOpenedTabFilter(OPENER);
    // Seen before the opener: not reportable yet.
    filter(...created({ targetId: 'NEW', type: 'page', url: 'http://x/c', openerId: OPENER }));
    expect(filter('Target.targetDestroyed', { targetId: 'NEW' })).toEqual([]);
    expect(filter(...created(openerPage))).toEqual([]);
  });

  test('a target in the already-reported set is skipped', () => {
    const filter = createOpenedTabFilter(OPENER, (id) => id === 'SEEN');
    filter(...created(openerPage));
    expect(
      filter(...created({ targetId: 'SEEN', type: 'page', url: 'http://x/s', openerId: OPENER })),
    ).toEqual([]);
  });

  test('malformed events are ignored', () => {
    const filter = createOpenedTabFilter(OPENER);
    expect(filter('Target.targetCreated', null)).toEqual([]);
    expect(filter('Target.targetCreated', { targetInfo: 'x' })).toEqual([]);
    expect(filter('Target.targetCreated', { targetInfo: { type: 'page' } })).toEqual([]);
    expect(filter('Page.loadEventFired', {})).toEqual([]);
  });
});

/** A fake browser-level socket: records every command and lets the test fire events. */
function fakeSocket(opts: { failDiscover?: boolean; listing?: [string, unknown][] } = {}) {
  const sent: { method: string; params: unknown }[] = [];
  const handlers = new Set<(method: string, params: unknown) => void>();
  const closeHandlers = new Set<() => void>();
  let closed = 0;
  const socket: BrowserSocket = {
    send: vi.fn(
      async (method: string, params: Record<string, unknown> = {}, onAnswer?: () => void) => {
        sent.push({ method, params });
        if (opts.failDiscover) throw new Error('discover refused');
        // Discovery's first listing comes before the answer (X3, and the
        // CdpClient ordering test below).
        for (const [m, p] of opts.listing ?? []) for (const h of [...handlers]) h(m, p);
        onAnswer?.();
        return {};
      },
    ),
    onAny: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onClose: (handler) => {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close: () => {
      closed++;
    },
  };
  return {
    socket,
    sent,
    fire: (method: string, params: unknown) => {
      for (const h of [...handlers]) h(method, params);
    },
    get closed() {
      return closed;
    },
    get listeners() {
      return handlers.size;
    },
    get closeListeners() {
      return closeHandlers.size;
    },
    /** Chrome drops the socket. */
    drop: () => {
      for (const h of [...closeHandlers]) h();
    },
  };
}

function deps(
  fake: ReturnType<typeof fakeSocket>,
  overrides: Partial<OpenedTabsDeps> = {},
): OpenedTabsDeps & { emitted: { tabId: string; data: unknown }[] } {
  const emitted: { tabId: string; data: unknown }[] = [];
  return {
    gate: () => ({ ok: true }),
    socketUrl: async () => 'ws://127.0.0.1:9222/devtools/browser/abc',
    openSocket: async () => fake.socket,
    sink: (tabId, data) => emitted.push({ tabId, data }),
    reported: new Set<string>(),
    emitted,
    ...overrides,
  };
}

describe('watchOpenedTabs', () => {
  test('emits tab-created keyed by the new cdp: id, with opened_from and url', async () => {
    const fake = fakeSocket();
    const d = deps(fake);
    const stop = await watchOpenedTabs(OPENER_TAB, d);
    fake.fire(...created(openerPage));
    fake.fire(...created({ targetId: 'NEW', type: 'page', url: '', openerId: OPENER }));
    fake.fire(...changed({ targetId: 'NEW', type: 'page', url: 'http://x/c', openerId: OPENER }));
    expect(d.emitted).toEqual([
      { tabId: 'cdp:NEW', data: { opened_from: OPENER_TAB, url: 'http://x/c' } },
    ]);
    // Reported is not returned: only a wait that matched it marks it.
    expect(d.reported?.has('NEW')).toBe(false);
    stop();
  });

  test('the browser socket sends only Target.setDiscoverTargets, never a permission command', async () => {
    const fake = fakeSocket();
    const stop = await watchOpenedTabs(OPENER_TAB, deps(fake));
    fake.fire(...created(openerPage));
    fake.fire(...created({ targetId: 'NEW', type: 'page', url: 'http://x/c', openerId: OPENER }));
    stop();
    expect(fake.sent).toEqual([
      { method: 'Target.setDiscoverTargets', params: { discover: true } },
    ]);
    expect(fake.sent.some((c) => c.method.startsWith('Browser.'))).toBe(false);
    expect([...BROWSER_SOCKET_COMMANDS]).toEqual(['Target.setDiscoverTargets']);
    expect(BROWSER_SOCKET_COMMANDS.has('Browser.setPermission')).toBe(false);
    expect(BROWSER_SOCKET_COMMANDS.has('Browser.grantPermissions')).toBe(false);
  });

  test('stop closes the socket and unsubscribes, once however often it is called', async () => {
    const fake = fakeSocket();
    const d = deps(fake);
    const stop = await watchOpenedTabs(OPENER_TAB, d);
    expect(fake.closed).toBe(0);
    stop();
    stop();
    expect(fake.closed).toBe(1);
    expect(fake.listeners).toBe(0);
    // Nothing reaches the sink after stop.
    fake.fire(...created(openerPage));
    fake.fire(...created({ targetId: 'NEW', type: 'page', url: 'http://x/c', openerId: OPENER }));
    expect(d.emitted).toEqual([]);
  });

  test('a failed Target.setDiscoverTargets closes the socket and rejects', async () => {
    const fake = fakeSocket({ failDiscover: true });
    await expect(watchOpenedTabs(OPENER_TAB, deps(fake))).rejects.toThrow('discover refused');
    expect(fake.closed).toBe(1);
    expect(fake.listeners).toBe(0);
  });

  test('a closed gate refuses before any socket is opened', async () => {
    const fake = fakeSocket();
    const openSocket = vi.fn(async () => fake.socket);
    await expect(
      watchOpenedTabs(
        OPENER_TAB,
        deps(fake, { gate: () => ({ ok: false, error: 'no grant' }), openSocket }),
      ),
    ).rejects.toThrow('no grant');
    expect(openSocket).not.toHaveBeenCalled();
  });

  test('no browser endpoint is a clear error and opens nothing', async () => {
    const fake = fakeSocket();
    const openSocket = vi.fn(async () => fake.socket);
    await expect(
      watchOpenedTabs(OPENER_TAB, deps(fake, { socketUrl: async () => null, openSocket })),
    ).rejects.toThrow(/browser-level DevTools endpoint/);
    expect(openSocket).not.toHaveBeenCalled();
  });

  test('a malformed opener id is refused before anything opens', async () => {
    const fake = fakeSocket();
    const openSocket = vi.fn(async () => fake.socket);
    await expect(watchOpenedTabs('cdp:', deps(fake, { openSocket }))).rejects.toThrow(/cdp:/);
    expect(openSocket).not.toHaveBeenCalled();
  });

  test('a gate that closes mid-wait stops the emission', async () => {
    const fake = fakeSocket();
    let open = true;
    const d = deps(fake, { gate: () => (open ? { ok: true } : { ok: false, error: 'revoked' }) });
    const stop = await watchOpenedTabs(OPENER_TAB, d);
    fake.fire(...created(openerPage));
    open = false;
    fake.fire(...created({ targetId: 'NEW', type: 'page', url: 'http://x/c', openerId: OPENER }));
    expect(d.emitted).toEqual([]);
    stop();
  });

  test('a tab an earlier wait reported is not reported again', async () => {
    const fake = fakeSocket();
    const d = deps(fake, { reported: new Set(['NEW']) });
    const stop = await watchOpenedTabs(OPENER_TAB, d);
    fake.fire(...created(openerPage));
    fake.fire(...created({ targetId: 'NEW', type: 'page', url: 'http://x/c', openerId: OPENER }));
    expect(d.emitted).toEqual([]);
    stop();
  });

  test('a tab announced to a wait that did not return it is announced again to the next wait', async () => {
    const reported = new Set<string>();
    for (const round of [1, 2]) {
      const fake = fakeSocket();
      const d = deps(fake, { reported });
      const stop = await watchOpenedTabs(OPENER_TAB, d);
      fake.fire(...created(openerPage));
      fake.fire(...created({ targetId: 'NEW', type: 'page', url: 'http://x/c', openerId: OPENER }));
      expect(d.emitted, `round ${String(round)}`).toHaveLength(1);
      stop();
    }
  });

  test('a tab a wait returned (markOpenedTabReturned) is not announced to a later wait', async () => {
    const reported = new Set<string>();
    markOpenedTabReturned('cdp:NEW', reported);
    expect(reported.has('NEW')).toBe(true);
    markOpenedTabReturned('tab_3', reported);
    expect(reported.size).toBe(1);
    const fake = fakeSocket();
    const d = deps(fake, { reported });
    const stop = await watchOpenedTabs(OPENER_TAB, d);
    fake.fire(...created(openerPage));
    fake.fire(...created({ targetId: 'NEW', type: 'page', url: 'http://x/c', openerId: OPENER }));
    expect(d.emitted).toEqual([]);
    stop();
  });

  test('a socket the browser drops ends the watch with the named error', async () => {
    const fake = fakeSocket();
    const onLost = vi.fn();
    const d = deps(fake, { onLost });
    await watchOpenedTabs(OPENER_TAB, d);
    fake.drop();
    expect(onLost).toHaveBeenCalledTimes(1);
    expect((onLost.mock.calls[0] as [Error])[0].message).toBe(BROWSER_SOCKET_LOST_ERROR);
    expect(fake.listeners).toBe(0);
    expect(fake.closeListeners).toBe(0);
    // Nothing is announced after the loss.
    fake.fire(...created(openerPage));
    fake.fire(...created({ targetId: 'NEW', type: 'page', url: 'http://x/c', openerId: OPENER }));
    expect(d.emitted).toEqual([]);
  });

  test('closing the socket through stop is not a loss', async () => {
    const fake = fakeSocket();
    const onLost = vi.fn();
    const stop = await watchOpenedTabs(OPENER_TAB, deps(fake, { onLost }));
    stop();
    fake.drop();
    expect(onLost).not.toHaveBeenCalled();
  });
});

describe('guardBrowserSocket', () => {
  test('sends an allowlisted command and refuses every other one without sending it', async () => {
    const fake = fakeSocket();
    const guarded = guardBrowserSocket(fake.socket);
    await guarded.send('Target.setDiscoverTargets', { discover: true });
    for (const method of [
      'Browser.setPermission',
      'Browser.grantPermissions',
      'Target.attachToTarget',
    ]) {
      await expect(guarded.send(method, {})).rejects.toThrow(
        `cdp-direct: ${method} is not sent on the browser socket`,
      );
    }
    expect(fake.sent).toEqual([
      { method: 'Target.setDiscoverTargets', params: { discover: true } },
    ]);
  });
});

describe('watchOpenedTabs: the first listing (the 1.5 s window)', () => {
  const child = (id: string, url: string) =>
    created({ targetId: id, type: 'page', url, openerId: OPENER });

  test('a page already open is ignored when the opener did not act recently, for the whole watch', async () => {
    const fake = fakeSocket({ listing: [created(openerPage), child('OLD', 'http://x/old')] });
    const d = deps(fake, { openerActedRecently: () => false });
    const stop = await watchOpenedTabs(OPENER_TAB, d);
    fake.fire(
      ...changed({ targetId: 'OLD', type: 'page', url: 'http://x/old2', openerId: OPENER }),
    );
    expect(d.emitted).toEqual([]);
    // A page created after the listing still counts.
    fake.fire(...created({ targetId: 'NEW', type: 'page', url: '', openerId: OPENER }));
    fake.fire(...changed({ targetId: 'NEW', type: 'page', url: 'http://x/new', openerId: OPENER }));
    expect(d.emitted).toEqual([
      { tabId: 'cdp:NEW', data: { opened_from: OPENER_TAB, url: 'http://x/new' } },
    ]);
    stop();
  });

  test('no openerActedRecently at all means never', async () => {
    const fake = fakeSocket({ listing: [created(openerPage), child('OLD', 'http://x/old')] });
    const d = deps(fake);
    const stop = await watchOpenedTabs(OPENER_TAB, d);
    expect(d.emitted).toEqual([]);
    stop();
  });

  test('one page already open is returned when the opener acted recently', async () => {
    const fake = fakeSocket({ listing: [created(openerPage), child('OLD', 'http://x/old')] });
    const acted = vi.fn(() => true);
    const d = deps(fake, { openerActedRecently: acted });
    const stop = await watchOpenedTabs(OPENER_TAB, d);
    expect(d.emitted).toEqual([
      { tabId: 'cdp:OLD', data: { opened_from: OPENER_TAB, url: 'http://x/old' } },
    ]);
    expect(acted).toHaveBeenCalledTimes(1);
    stop();
  });

  test('a page of the listing whose url is not known yet is returned when its url arrives', async () => {
    const fake = fakeSocket({ listing: [created(openerPage), child('OLD', '')] });
    const d = deps(fake, { openerActedRecently: () => true });
    const stop = await watchOpenedTabs(OPENER_TAB, d);
    expect(d.emitted).toEqual([]);
    fake.fire(...changed({ targetId: 'OLD', type: 'page', url: 'http://x/old', openerId: OPENER }));
    expect(d.emitted).toEqual([
      { tabId: 'cdp:OLD', data: { opened_from: OPENER_TAB, url: 'http://x/old' } },
    ]);
    stop();
  });

  test('several candidates: the watch rejects naming them by url, never picking one', async () => {
    const fake = fakeSocket({
      listing: [created(openerPage), child('ZZZ', 'http://x/a'), child('AAA', 'http://x/b')],
    });
    const d = deps(fake, { openerActedRecently: () => true });
    await expect(watchOpenedTabs(OPENER_TAB, d)).rejects.toThrow(
      'cdp-direct: browser.wait_for_tab cannot tell which tab cdp:OPENER1 opened: 2 tabs it opened were already open when the wait started, within 1.5 s of its last action: cdp:ZZZ (http://x/a), cdp:AAA (http://x/b). Call browser.list_tabs and pick one.',
    );
    expect(d.emitted).toEqual([]);
    expect(fake.closed).toBe(1);
    expect(fake.listeners).toBe(0);
  });

  test('a candidate the url_substring cannot match does not count', async () => {
    const fake = fakeSocket({
      listing: [created(openerPage), child('A', 'http://x/a'), child('B', 'http://x/want')],
    });
    const d = deps(fake, {
      openerActedRecently: () => true,
      accepts: (url) => url.includes('want'),
    });
    const stop = await watchOpenedTabs(OPENER_TAB, d);
    expect(d.emitted).toEqual([
      { tabId: 'cdp:B', data: { opened_from: OPENER_TAB, url: 'http://x/want' } },
    ]);
    stop();
  });

  test('a page a wait already returned is not a candidate', async () => {
    const fake = fakeSocket({
      listing: [created(openerPage), child('A', 'http://x/a'), child('B', 'http://x/b')],
    });
    const d = deps(fake, { openerActedRecently: () => true, reported: new Set(['A']) });
    const stop = await watchOpenedTabs(OPENER_TAB, d);
    expect(d.emitted).toEqual([
      { tabId: 'cdp:B', data: { opened_from: OPENER_TAB, url: 'http://x/b' } },
    ]);
    stop();
  });

  test('pages of other openers in the listing are never candidates', async () => {
    const fake = fakeSocket({
      listing: [
        created(openerPage),
        created({ targetId: 'U', type: 'page', url: 'http://x/u', openerId: 'OTHER' }),
        created({ targetId: 'L', type: 'page', url: 'http://x/l' }),
      ],
    });
    const d = deps(fake, { openerActedRecently: () => true });
    const stop = await watchOpenedTabs(OPENER_TAB, d);
    expect(d.emitted).toEqual([]);
    stop();
  });
});

describe('watchOpenedTabs on a real CdpClient: the answer splits the listing from live events', () => {
  let server: WebSocketServer | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  });

  test('events before the setDiscoverTargets answer are the listing, events right behind it are live', async () => {
    const port = await new Promise<number>((resolve) => {
      server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      server.on('connection', (ws) => {
        ws.on('message', (raw) => {
          const msg = JSON.parse(String(raw)) as { id: number; method: string };
          if (msg.method !== 'Target.setDiscoverTargets') return;
          const event = (info: Record<string, unknown>) =>
            JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: info } });
          // One burst, as Chrome sends it: listing, answer, then a live page.
          ws.send(event(openerPage));
          ws.send(event({ targetId: 'OLD', type: 'page', url: 'http://x/old', openerId: OPENER }));
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
          ws.send(
            event({ targetId: 'LIVE', type: 'page', url: 'http://x/live', openerId: OPENER }),
          );
        });
      });
      server.on('listening', () => {
        const address = server?.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    const emitted: string[] = [];
    let seenLive: () => void = () => {};
    const live = new Promise<void>((resolve) => {
      seenLive = resolve;
    });
    const stop = await watchOpenedTabs(OPENER_TAB, {
      gate: () => ({ ok: true }),
      socketUrl: async () => `ws://127.0.0.1:${String(port)}/devtools/browser/test`,
      reported: new Set(),
      openerActedRecently: () => false,
      sink: (tabId) => {
        emitted.push(tabId);
        seenLive();
      },
    });
    await live;
    expect(emitted).toEqual(['cdp:LIVE']);
    stop();
  });
});
