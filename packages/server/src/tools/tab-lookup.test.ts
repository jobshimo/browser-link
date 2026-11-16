import { describe, expect, test, vi } from 'vitest';
import { findTab, listKnownTabs, listTabsForSession, withCallTabMemo } from './tab-lookup.js';

const EXT = { tab_id: 'tab_1', url: 'https://a.test/', title: 'A' };
const CDP = { tab_id: 'cdp:T1', url: 'https://b.test/', title: 'B', transport: 'cdp' as const };

function source(cdp = true) {
  return {
    listTabs: vi.fn(() => [EXT]),
    ...(cdp ? { listCdpTabs: vi.fn(async () => [CDP]) } : {}),
  };
}

describe('tab lookup over both transports', () => {
  test('an extension id is answered from the tab table and never reaches cdp discovery', async () => {
    const s = source();
    expect(await findTab(s, 'tab_1')).toEqual(EXT);
    expect(s.listCdpTabs).not.toHaveBeenCalled();
  });

  test('a cdp: id is answered from cdp discovery, not the extension table', async () => {
    const s = source();
    expect(await findTab(s, 'cdp:T1')).toEqual(CDP);
    expect(s.listTabs).not.toHaveBeenCalled();
  });

  test('an unknown id, or a cdp: id without cdp discovery wired, is undefined', async () => {
    expect(await findTab(source(), 'tab_9')).toBeUndefined();
    expect(await findTab(source(), 'cdp:NOPE')).toBeUndefined();
    expect(await findTab(source(false), 'cdp:T1')).toBeUndefined();
  });

  test('listKnownTabs lists extension tabs first, then cdp tabs', async () => {
    expect(await listKnownTabs(source())).toEqual([EXT, CDP]);
    expect(await listKnownTabs(source(false))).toEqual([EXT]);
  });
});

describe('listTabsForSession: cdp discovery only when the session may have used a cdp tab', () => {
  test('a session that used only extension tabs never runs cdp discovery', async () => {
    const s = source();
    expect(await listTabsForSession(s, new Set(['https://a.test']))).toEqual([EXT]);
    expect(s.listCdpTabs).not.toHaveBeenCalled();
  });

  test('a session that used nothing never runs cdp discovery', async () => {
    const s = source();
    expect(await listTabsForSession(s, new Set())).toEqual([EXT]);
    expect(s.listCdpTabs).not.toHaveBeenCalled();
  });

  test('an origin no extension tab explains triggers one discovery, and cdp tabs follow', async () => {
    const s = source();
    expect(await listTabsForSession(s, new Set(['https://b.test']))).toEqual([EXT, CDP]);
    expect(s.listCdpTabs).toHaveBeenCalledTimes(1);
  });

  test('a rejecting discovery does not throw: the wrap-up has the extension tabs', async () => {
    const s = { ...source(), listCdpTabs: vi.fn(async () => Promise.reject(new Error('down'))) };
    expect(await listTabsForSession(s, new Set(['https://b.test']))).toEqual([EXT]);
    expect(s.listCdpTabs).toHaveBeenCalledTimes(1);
  });

  test('without cdp discovery wired it is the extension tabs', async () => {
    expect(await listTabsForSession(source(false), new Set(['https://b.test']))).toEqual([EXT]);
  });
});

describe('withCallTabMemo: one cdp discovery per call phase', () => {
  function deps() {
    return {
      listTabs: vi.fn(() => [EXT]),
      listCdpTabs: vi.fn(async () => [CDP]),
      callCdpTool: vi.fn(async () => ({ ok: true })),
    };
  }

  test('lookups share one discovery; a page-changing cdp call drops it once', async () => {
    const d = deps();
    const call = withCallTabMemo(d, 'browser.click');
    await findTab(call, 'cdp:T1');
    await findTab(call, 'cdp:T1');
    expect(d.listCdpTabs).toHaveBeenCalledTimes(1);
    await call.callCdpTool?.('cdp:T1', 'click', { selector: '#a' });
    expect(d.callCdpTool).toHaveBeenCalledWith('cdp:T1', 'click', { selector: '#a' });
    await findTab(call, 'cdp:T1');
    await findTab(call, 'cdp:T1');
    expect(d.listCdpTabs).toHaveBeenCalledTimes(2);
  });

  test('a page-preserving tool keeps the discovery across its cdp call', async () => {
    const d = deps();
    const call = withCallTabMemo(d, 'browser.read');
    await findTab(call, 'cdp:T1');
    await call.callCdpTool?.('cdp:T1', 'evaluate', { expression: '1' });
    await findTab(call, 'cdp:T1');
    expect(d.listCdpTabs).toHaveBeenCalledTimes(1);
  });

  test('a failed discovery is not retried within the phase', async () => {
    const d = { ...deps(), listCdpTabs: vi.fn(async () => Promise.reject(new Error('down'))) };
    const call = withCallTabMemo(d, 'browser.click');
    await expect(findTab(call, 'cdp:T1')).rejects.toThrow('down');
    await expect(findTab(call, 'cdp:T1')).rejects.toThrow('down');
    expect(d.listCdpTabs).toHaveBeenCalledTimes(1);
  });

  test('wrapping twice is a no-op, and deps without cdp discovery are returned as they are', () => {
    const d = deps();
    const once = withCallTabMemo(d, 'browser.click');
    expect(withCallTabMemo(once, 'browser.click')).toBe(once);
    const extOnly = { listTabs: vi.fn(() => [EXT]) };
    expect(withCallTabMemo(extOnly, 'browser.click')).toBe(extOnly);
  });
});
