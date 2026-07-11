import { describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import {
  buildRegisterSettingsUpdate,
  pushSettingsToAllTabs,
  type TabSession,
} from './ws-bridge.js';

/* Wire-level coverage for the two settings-push paths in ws-bridge.ts.
 *
 * `startWsBridge` itself binds the FIXED 127.0.0.1:17529 and its
 * verifyClient does a kernel-level peer lookup that rejects anything that
 * is not a Chromium binary — a Node test process cannot pass it without
 * invasive production refactoring. So the register-path decision is
 * extracted into `buildRegisterSettingsUpdate` (tested directly here), and
 * `pushSettingsToAllTabs` is exercised against fake WS sessions capturing
 * exactly what would go over the wire. */

interface FakeWs {
  session: TabSession;
  sent: string[];
}

function fakeSession(tabId: string, readyState: number): FakeWs {
  const sent: string[] = [];
  const ws = {
    readyState,
    send: (data: string) => {
      sent.push(data);
    },
  } as unknown as WebSocket;
  return {
    session: { tabId, url: `https://example.com/${tabId}`, title: tabId, ws },
    sent,
  };
}

describe('buildRegisterSettingsUpdate', () => {
  test('returns null when the CLI never set idleTtlMinutes (popup-only user)', () => {
    expect(buildRegisterSettingsUpdate({})).toBeNull();
    expect(buildRegisterSettingsUpdate({ idleTtlUpdatedAt: 123 })).toBeNull();
  });

  test('builds the message when the CLI set a value, carrying its updatedAt', () => {
    expect(
      buildRegisterSettingsUpdate({ idleTtlMinutes: 45, idleTtlUpdatedAt: 1_700_000_000_000 }),
    ).toEqual({
      kind: 'settings.update',
      settings: { idleTtlMinutes: 45, updatedAt: 1_700_000_000_000 },
    });
  });

  test('0 ("never") is a real value and DOES push — only undefined suppresses', () => {
    expect(buildRegisterSettingsUpdate({ idleTtlMinutes: 0, idleTtlUpdatedAt: 5 })).toEqual({
      kind: 'settings.update',
      settings: { idleTtlMinutes: 0, updatedAt: 5 },
    });
  });

  test('a missing idleTtlUpdatedAt degrades to updatedAt 0 (always loses precedence)', () => {
    expect(buildRegisterSettingsUpdate({ idleTtlMinutes: 15 })).toEqual({
      kind: 'settings.update',
      settings: { idleTtlMinutes: 15, updatedAt: 0 },
    });
  });
});

describe('pushSettingsToAllTabs', () => {
  const SETTINGS = { idleTtlMinutes: 25, updatedAt: 1_700_000_000_000 };

  test('sends the exact settings.update frame to every OPEN session and counts them', () => {
    const a = fakeSession('tab_1', WebSocket.OPEN);
    const b = fakeSession('tab_2', WebSocket.OPEN);
    const tabs = new Map<string, TabSession>([
      ['tab_1', a.session],
      ['tab_2', b.session],
    ]);

    const notified = pushSettingsToAllTabs(tabs, SETTINGS);

    expect(notified).toBe(2);
    for (const sent of [a.sent, b.sent]) {
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]!)).toEqual({ kind: 'settings.update', settings: SETTINGS });
    }
  });

  test('skips sessions whose socket is not OPEN, without counting them', () => {
    const open = fakeSession('tab_1', WebSocket.OPEN);
    const closing = fakeSession('tab_2', WebSocket.CLOSING);
    const closed = fakeSession('tab_3', WebSocket.CLOSED);
    const tabs = new Map<string, TabSession>([
      ['tab_1', open.session],
      ['tab_2', closing.session],
      ['tab_3', closed.session],
    ]);

    const notified = pushSettingsToAllTabs(tabs, SETTINGS);

    expect(notified).toBe(1);
    expect(open.sent).toHaveLength(1);
    expect(closing.sent).toHaveLength(0);
    expect(closed.sent).toHaveLength(0);
  });

  test('returns 0 for an empty tabs map', () => {
    expect(pushSettingsToAllTabs(new Map(), SETTINGS)).toBe(0);
  });
});
