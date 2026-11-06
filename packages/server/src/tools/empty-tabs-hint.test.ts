import { describe, expect, test } from 'vitest';
import type { BridgeEvent, BridgeEventKind } from '../bridge/events.js';
import { EXTENSION_RECONNECT_WINDOW_MS, buildEmptyTabsHint } from './empty-tabs-hint.js';

const T0 = Date.parse('2026-01-01T12:00:00.000Z');
let nextId = 1;

function ev(kind: BridgeEventKind, atMs: number, data: Record<string, unknown> = {}): BridgeEvent {
  return { id: nextId++, at: new Date(atMs).toISOString(), kind, data };
}

describe('buildEmptyTabsHint', () => {
  test('never connected, bridge up for a while: ask the user to press Connect', () => {
    const now = T0 + EXTENSION_RECONNECT_WINDOW_MS + 60_000;
    const hint = buildEmptyTabsHint([ev('primary-elected', T0, { pid: 1 })], now);
    expect(hint).toMatch(/No tab has connected to this bridge/);
    expect(hint).toMatch(/press Connect/i);
    expect(hint).not.toMatch(/wait/i);
  });

  test('never connected, bridge started recently: tabs of the previous process may still reconnect', () => {
    const now = T0 + 20_000;
    const hint = buildEmptyTabsHint([ev('primary-elected', T0, { pid: 1 })], now);
    expect(hint).toMatch(/started 20s ago/);
    expect(hint).toMatch(/wait/i);
    expect(hint).toMatch(/press Connect/i);
  });

  test('no events at all is treated as never connected', () => {
    expect(buildEmptyTabsHint([], T0)).toMatch(/No tab has connected/);
  });

  test('tabs dropped inside the reconnect window: say how many, which, and to wait', () => {
    const events = [
      ev('primary-elected', T0 - 600_000),
      ev('tab-registered', T0 - 500_000, { tabId: 'tab_1', url: 'https://app.example.com/a?x=1' }),
      ev('tab-registered', T0 - 490_000, { tabId: 'tab_2', url: 'https://other.test/' }),
      ev('tab-disconnected', T0 - 30_000, { tabId: 'tab_1', clean: false }),
      ev('tab-disconnected', T0 - 29_000, { tabId: 'tab_2', clean: false }),
    ];
    const hint = buildEmptyTabsHint(events, T0);
    expect(hint).toMatch(/2 tab\(s\) were connected and dropped/);
    expect(hint).toMatch(/29s ago/);
    expect(hint).toContain('tab_1 (https://app.example.com)');
    expect(hint).toContain('tab_2 (https://other.test)');
    expect(hint).not.toContain('?x=1');
    expect(hint).toMatch(/auto-reconnect/);
    expect(hint).toMatch(/wait/i);
    expect(hint).toMatch(/browser\.events/);
  });

  test('tabs dropped longer ago than the reconnect window: ask the user to press Connect', () => {
    const events = [
      ev('tab-registered', T0 - 900_000, { tabId: 'tab_1', url: 'https://a.test/' }),
      ev('tab-disconnected', T0 - EXTENSION_RECONNECT_WINDOW_MS - 120_000, {
        tabId: 'tab_1',
        clean: false,
      }),
    ];
    const hint = buildEmptyTabsHint(events, T0);
    expect(hint).toMatch(/1 tab\(s\) were connected and dropped/);
    expect(hint).toMatch(/press Connect/i);
    expect(hint).not.toMatch(/wait for/i);
  });

  test('attempt time adds on top of the 600s of waits: still "wait" shortly past the window', () => {
    const events = [
      ev('tab-registered', T0 - 900_000, { tabId: 'tab_1', url: 'https://a.test/' }),
      ev('tab-disconnected', T0 - EXTENSION_RECONNECT_WINDOW_MS - 30_000, {
        tabId: 'tab_1',
        clean: false,
      }),
    ];
    expect(buildEmptyTabsHint(events, T0)).toMatch(/wait for reconnect/i);
  });

  test('a clean close (manual Disconnect, tab closed, idle sweep) is NOT "wait for reconnect"', () => {
    const events = [
      ev('tab-registered', T0 - 60_000, { tabId: 'tab_1', url: 'https://a.test/x' }),
      ev('tab-disconnected', T0 - 5_000, { tabId: 'tab_1', clean: true, code: 1000 }),
    ];
    const hint = buildEmptyTabsHint(events, T0);
    expect(hint).toMatch(/disconnected|closed/i);
    expect(hint).toMatch(/does not auto-reconnect/i);
    expect(hint).toMatch(/press Connect/i);
    expect(hint).not.toMatch(/wait for reconnect/i);
  });

  test('mixed clean and unclean drops: wait applies only to the unclean ones', () => {
    const events = [
      ev('tab-registered', T0 - 60_000, { tabId: 'tab_1', url: 'https://a.test/' }),
      ev('tab-registered', T0 - 60_000, { tabId: 'tab_2', url: 'https://b.test/' }),
      ev('tab-disconnected', T0 - 5_000, { tabId: 'tab_1', clean: true }),
      ev('tab-disconnected', T0 - 5_000, { tabId: 'tab_2', clean: false }),
    ];
    const hint = buildEmptyTabsHint(events, T0);
    expect(hint).toMatch(/wait for reconnect/i);
    expect(hint).toContain('tab_2 (https://b.test)');
    expect(hint).toMatch(/tab_1 .*closed|disconnected/i);
  });

  test('a renamed tab is tracked under its new id and the old id is not reported', () => {
    const events = [
      ev('tab-registered', T0 - 60_000, { tabId: 'tab_1', url: 'https://a.test/' }),
      ev('tab-renamed', T0 - 50_000, {
        previous: 'tab_1',
        current: 'tab_9',
        url: 'https://a.test/',
      }),
      ev('tab-disconnected', T0 - 10_000, { tabId: 'tab_9' }),
    ];
    const hint = buildEmptyTabsHint(events, T0);
    expect(hint).toMatch(/1 tab\(s\)/);
    expect(hint).toContain('tab_9');
    expect(hint).not.toContain('tab_1 ');
  });

  test('a tab that reconnected after dropping is not reported as dropped', () => {
    const events = [
      ev('tab-registered', T0 - 60_000, { tabId: 'tab_1', url: 'https://a.test/' }),
      ev('tab-disconnected', T0 - 40_000, { tabId: 'tab_1' }),
      ev('tab-registered', T0 - 30_000, { tabId: 'tab_1', url: 'https://a.test/' }),
      ev('tab-disconnected', T0 - 5_000, { tabId: 'tab_1' }),
    ];
    expect(buildEmptyTabsHint(events, T0)).toMatch(/1 tab\(s\) were connected and dropped/);
  });

  test('after browser.reset the extension does NOT reconnect: ask the user', () => {
    const events = [ev('primary-elected', T0 - 5_000, { pid: 1, reason: 'reset' })];
    const hint = buildEmptyTabsHint(events, T0);
    expect(hint).toMatch(/browser\.reset/);
    expect(hint).toMatch(/press Connect/i);
    expect(hint).not.toMatch(/wait/i);
  });

  test('lists at most 5 dropped tabs and says how many more', () => {
    const events: BridgeEvent[] = [];
    for (let i = 1; i <= 7; i++) {
      events.push(
        ev('tab-registered', T0 - 100_000, { tabId: `tab_${i}`, url: 'https://a.test/' }),
      );
    }
    for (let i = 1; i <= 7; i++)
      events.push(ev('tab-disconnected', T0 - 10_000, { tabId: `tab_${i}` }));
    const hint = buildEmptyTabsHint(events, T0);
    expect(hint).toMatch(/7 tab\(s\)/);
    expect(hint).toMatch(/and 2 more/);
    expect(hint).not.toContain('tab_7');
  });

  test('a malformed url does not break the hint', () => {
    const events = [
      ev('tab-registered', T0 - 60_000, { tabId: 'tab_1', url: 'not a url' }),
      ev('tab-disconnected', T0 - 10_000, { tabId: 'tab_1' }),
    ];
    expect(buildEmptyTabsHint(events, T0)).toContain('tab_1');
  });
});
