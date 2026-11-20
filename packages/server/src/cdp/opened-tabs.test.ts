import { describe, expect, test, vi } from 'vitest';
import {
  BROWSER_SOCKET_COMMANDS,
  createOpenedTabFilter,
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
function fakeSocket(opts: { failDiscover?: boolean } = {}) {
  const sent: { method: string; params: unknown }[] = [];
  const handlers = new Set<(method: string, params: unknown) => void>();
  let closed = 0;
  const socket: BrowserSocket = {
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      sent.push({ method, params });
      if (opts.failDiscover) throw new Error('discover refused');
      return {};
    }),
    onAny: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
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
    expect(d.reported?.has('NEW')).toBe(true);
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
});
