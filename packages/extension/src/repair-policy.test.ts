import { describe, expect, test } from 'vitest';
import {
  MIN_REPAIR_VERSION,
  PREV_TAB_ID_PREFIX,
  describeReconnectResults,
  describeRepairReply,
  planRepair,
  prevTabIdKey,
  rememberedTabIds,
} from './repair-policy.js';

const STOP_AND_RESTART = 'run `browser-link stop` and restart your agent';
const NO_SERVER = 'no server is running: start browser-link from your agent or a console';

describe('planRepair', () => {
  test('the minimum server version that can repair itself is 0.41.0', () => {
    expect(MIN_REPAIR_VERSION).toBe('0.41.0');
  });

  test('a connected server at or above 0.41.0 is asked to restart', () => {
    expect(planRepair({ connected: true, serverVersion: '0.41.0', rememberedTabIds: [7] })).toEqual(
      { step: 'ask-server-restart' },
    );
    expect(planRepair({ connected: true, serverVersion: '0.52.3', rememberedTabIds: [] })).toEqual({
      step: 'ask-server-restart',
    });
  });

  test('a connected server older than 0.41.0 cannot repair itself', () => {
    expect(planRepair({ connected: true, serverVersion: '0.40.0', rememberedTabIds: [7] })).toEqual(
      {
        step: 'manual',
        reason: 'server-too-old',
        message: `server 0.40.0 cannot repair itself: ${STOP_AND_RESTART}`,
      },
    );
  });

  test('a connected server that reports no version is treated as too old', () => {
    expect(planRepair({ connected: true, serverVersion: null, rememberedTabIds: [] })).toEqual({
      step: 'manual',
      reason: 'server-too-old',
      message: `server (unknown version) cannot repair itself: ${STOP_AND_RESTART}`,
    });
  });

  test('with no socket connected, the remembered tabs are reconnected', () => {
    expect(planRepair({ connected: false, serverVersion: null, rememberedTabIds: [3, 9] })).toEqual(
      { step: 'reconnect-only', tabIds: [3, 9] },
    );
  });

  test('with no socket and no remembered tab, the user is told no server is running', () => {
    expect(planRepair({ connected: false, serverVersion: null, rememberedTabIds: [] })).toEqual({
      step: 'manual',
      reason: 'no-server',
      message: NO_SERVER,
    });
  });

  test('a custom minimum version is honoured', () => {
    expect(
      planRepair({
        connected: true,
        serverVersion: '0.41.0',
        rememberedTabIds: [],
        minRepairVersion: '0.42.0',
      }).step,
    ).toBe('manual');
  });
});

describe('rememberedTabIds', () => {
  test('reads the Chrome tab ids out of the prevTabId:* session keys', () => {
    expect(prevTabIdKey(12)).toBe(`${PREV_TAB_ID_PREFIX}12`);
    expect(
      rememberedTabIds({
        'prevTabId:12': 't1',
        'prevTabId:4': 't2',
        'pendingReconnect:12': { attempt: 1 },
        'flowHistory:4': [],
      }),
    ).toEqual([4, 12]);
  });

  test('ignores malformed keys and values', () => {
    expect(
      rememberedTabIds({
        'prevTabId:abc': 't1',
        'prevTabId:-1': 't2',
        'prevTabId:1.5': 't3',
        'prevTabId:8': 42,
        'prevTabId:9': 't4',
      }),
    ).toEqual([9]);
  });
});

describe('describeRepairReply', () => {
  test('a restarting server tells the user the tabs reconnect by themselves', () => {
    expect(
      describeRepairReply({
        kind: 'bridge.repair.result',
        request_id: 'r',
        ok: true,
        action: 'restarting',
      }),
    ).toEqual({
      ok: true,
      message: 'The server is restarting; connected tabs reconnect by themselves.',
    });
  });

  test('a refusal carries the server error', () => {
    expect(
      describeRepairReply({
        kind: 'bridge.repair.result',
        request_id: 'r',
        ok: false,
        error: 'boom',
      }),
    ).toEqual({ ok: false, message: 'Repair failed: boom' });
  });

  test('no answer in time falls back to the manual instruction', () => {
    expect(describeRepairReply('timeout')).toEqual({
      ok: false,
      message: `The server did not answer the repair request: ${STOP_AND_RESTART}`,
    });
  });
});

describe('describeReconnectResults', () => {
  test('any reconnected tab is a success', () => {
    expect(describeReconnectResults([{ ok: false }, { ok: true }])).toEqual({
      ok: true,
      message: 'Reconnected 1 of 2 tabs.',
    });
  });

  test('every reconnect failing means no server is running', () => {
    expect(describeReconnectResults([{ ok: false }, { ok: false }])).toEqual({
      ok: false,
      message: NO_SERVER,
    });
  });
});
