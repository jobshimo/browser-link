import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
  MAX_FLOW_DESCRIPTION_LENGTH,
  MAX_FLOW_NAME_LENGTH,
  buildRegisterSettingsUpdate,
  handleFlowRecordedMessage,
  pushSettingsToAllTabs,
  type TabSession,
} from './ws-bridge.js';
import { BridgeEventLog, isExtensionEventKind } from './events.js';
import { closeDb } from '../map/db.js';
import { recall } from '../map/queries.js';
import type { FlowRecordedPayload } from '../messages.js';

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

  test('returns null when the CLI never set flowRecordingEnabled either', () => {
    expect(buildRegisterSettingsUpdate({ flowRecordingUpdatedAt: 123 })).toBeNull();
  });

  test('builds the message for flow-recording alone, independent of idle-ttl', () => {
    expect(
      buildRegisterSettingsUpdate({
        flowRecordingEnabled: true,
        flowRecordingUpdatedAt: 1_700_000_000_000,
      }),
    ).toEqual({
      kind: 'settings.update',
      settings: { flowRecordingEnabled: true, flowRecordingUpdatedAt: 1_700_000_000_000 },
    });
  });

  test('false ("off") is a real value and DOES push — only undefined suppresses', () => {
    expect(
      buildRegisterSettingsUpdate({ flowRecordingEnabled: false, flowRecordingUpdatedAt: 5 }),
    ).toEqual({
      kind: 'settings.update',
      settings: { flowRecordingEnabled: false, flowRecordingUpdatedAt: 5 },
    });
  });

  test('a missing flowRecordingUpdatedAt degrades to 0 (always loses precedence)', () => {
    expect(buildRegisterSettingsUpdate({ flowRecordingEnabled: true })).toEqual({
      kind: 'settings.update',
      settings: { flowRecordingEnabled: true, flowRecordingUpdatedAt: 0 },
    });
  });

  test('builds a combined message when both pairs are set', () => {
    expect(
      buildRegisterSettingsUpdate({
        idleTtlMinutes: 10,
        idleTtlUpdatedAt: 1,
        flowRecordingEnabled: true,
        flowRecordingUpdatedAt: 2,
      }),
    ).toEqual({
      kind: 'settings.update',
      settings: {
        idleTtlMinutes: 10,
        updatedAt: 1,
        flowRecordingEnabled: true,
        flowRecordingUpdatedAt: 2,
      },
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

  test('forwards a flow-recording-only settings payload the same way', () => {
    const a = fakeSession('tab_1', WebSocket.OPEN);
    const tabs = new Map<string, TabSession>([['tab_1', a.session]]);
    const flowSettings = { flowRecordingEnabled: true, flowRecordingUpdatedAt: 42 };

    const notified = pushSettingsToAllTabs(tabs, flowSettings);

    expect(notified).toBe(1);
    expect(JSON.parse(a.sent[0]!)).toEqual({ kind: 'settings.update', settings: flowSettings });
  });
});

/* handleFlowRecordedMessage — real temp-dir SQLite DB (same fixture
 * pattern as map-hint.integration.test.ts), not mocks: the validation ->
 * saveFlow -> events.add pipeline is exactly what's under test. */
describe('handleFlowRecordedMessage', () => {
  let dataDir: string;
  let events: BridgeEventLog;

  const VALID_STEPS = [{ click: { selector: '#save-btn' } }, { press: { key: 'Enter' } }];

  function payload(overrides: Partial<FlowRecordedPayload> = {}): FlowRecordedPayload {
    return {
      tab_id: 'tab_1',
      origin: 'https://myapp.example.com',
      name: 'open task detail',
      steps: VALID_STEPS,
      ...overrides,
    };
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-flow-recorded-test-'));
    process.env.BROWSER_LINK_DATA_DIR = dataDir;
    events = new BridgeEventLog();
  });

  afterEach(() => {
    closeDb();
    delete process.env.BROWSER_LINK_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('saves a valid recording and returns ok:true with the name', () => {
    const result = handleFlowRecordedMessage(payload(), events);
    expect(result).toEqual({ kind: 'flow.recorded.result', ok: true, name: 'open task detail' });

    const recalled = recall({ origin: 'https://myapp.example.com' });
    expect(recalled.flows).toHaveLength(1);
    expect(recalled.flows[0]).toMatchObject({ name: 'open task detail', steps: VALID_STEPS });
  });

  test('emits a server-owned flow-recorded bridge event on success', () => {
    handleFlowRecordedMessage(payload({ tab_id: 'tab_7' }), events);

    const recent = events.recent();
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      kind: 'flow-recorded',
      data: { tab_id: 'tab_7', name: 'open task detail', step_count: 2 },
    });
  });

  test('canonicalizes a free-text origin the same way every other map write does', () => {
    handleFlowRecordedMessage(payload({ origin: 'https://myapp.example.com/' }), events);

    const recalled = recall({ origin: 'https://myapp.example.com' });
    expect(recalled.app?.origin).toBe('https://myapp.example.com');
    expect(recalled.flows).toHaveLength(1);
  });

  test('persists an optional description', () => {
    handleFlowRecordedMessage(payload({ description: 'opens the detail dialog' }), events);
    const recalled = recall({ origin: 'https://myapp.example.com' });
    expect(recalled.flows[0]?.description).toBe('opens the detail dialog');
  });

  test('rejects an empty/whitespace name, saving nothing and emitting no event', () => {
    expect(handleFlowRecordedMessage(payload({ name: '' }), events)).toEqual({
      kind: 'flow.recorded.result',
      ok: false,
      error: 'flow.recorded: name is required',
    });
    expect(handleFlowRecordedMessage(payload({ name: '   ' }), events).ok).toBe(false);
    expect(recall({ origin: 'https://myapp.example.com' }).flows).toHaveLength(0);
    expect(events.recent()).toHaveLength(0);
  });

  test('rejects invalid steps with the SAME validateFlowSteps error browser.flow would give', () => {
    const result = handleFlowRecordedMessage(payload({ steps: [] }), events);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/flow\.recorded: steps must be a non-empty array/);
    expect(recall({ origin: 'https://myapp.example.com' }).flows).toHaveLength(0);
  });

  test('rejects a recording over the 20-step cap', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ press: { key: `k${i}` } }));
    const result = handleFlowRecordedMessage(payload({ steps: tooMany }), events);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/at most 20 steps allowed, got 21/);
  });

  test('saving the same name twice upserts (replaces steps) rather than duplicating', () => {
    handleFlowRecordedMessage(payload(), events);
    const second = [{ press: { key: 'Escape' } }];
    handleFlowRecordedMessage(payload({ steps: second }), events);

    const recalled = recall({ origin: 'https://myapp.example.com' });
    expect(recalled.flows).toHaveLength(1);
    expect(recalled.flows[0]?.steps).toEqual(second);
  });

  test('rejects a name over the length cap, saving nothing', () => {
    const result = handleFlowRecordedMessage(
      payload({ name: 'x'.repeat(MAX_FLOW_NAME_LENGTH + 1) }),
      events,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/name exceeds/);
    expect(recall({ origin: 'https://myapp.example.com' }).flows).toHaveLength(0);
  });

  test('rejects a description over the length cap, saving nothing', () => {
    const result = handleFlowRecordedMessage(
      payload({ description: 'y'.repeat(MAX_FLOW_DESCRIPTION_LENGTH + 1) }),
      events,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/description must be a string of at most/);
    expect(recall({ origin: 'https://myapp.example.com' }).flows).toHaveLength(0);
  });
});

describe('flow-recorded is not spoofable via the extension bridge.event channel', () => {
  test('isExtensionEventKind rejects flow-recorded — only handleFlowRecordedMessage can produce it', () => {
    expect(isExtensionEventKind('flow-recorded')).toBe(false);
  });
});
