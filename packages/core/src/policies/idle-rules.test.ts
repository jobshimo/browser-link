import { describe, expect, test } from 'vitest';
import {
  DEFAULT_IDLE_TTL_MINUTES,
  IDLE_TTL_NEVER,
  MAX_CALL_HOLD_MS,
  MAX_IDLE_TTL_MINUTES,
  MIN_IDLE_TTL_MINUTES,
  activityAfterFlowEnded,
  clampIdleTtlMinutes,
  idleHoldUntil,
  shouldDisconnectForIdle,
  shouldScheduleIdleSweep,
  tabsToDisconnectForIdle,
} from './idle-rules.js';
import { MAX_DETACHED_FLOW_MS } from '../support/flow-limits.js';

describe('clampIdleTtlMinutes', () => {
  test('0 ("never") passes through unchanged', () => {
    expect(clampIdleTtlMinutes(0)).toBe(IDLE_TTL_NEVER);
  });

  test('in-range integers pass through unchanged', () => {
    expect(clampIdleTtlMinutes(30)).toBe(30);
    expect(clampIdleTtlMinutes(MIN_IDLE_TTL_MINUTES)).toBe(MIN_IDLE_TTL_MINUTES);
    expect(clampIdleTtlMinutes(MAX_IDLE_TTL_MINUTES)).toBe(MAX_IDLE_TTL_MINUTES);
  });

  test('values above the ceiling fall back to the default, not the ceiling', () => {
    expect(clampIdleTtlMinutes(MAX_IDLE_TTL_MINUTES + 1)).toBe(DEFAULT_IDLE_TTL_MINUTES);
    expect(clampIdleTtlMinutes(999_999)).toBe(DEFAULT_IDLE_TTL_MINUTES);
  });

  test('negative values fall back to the default', () => {
    expect(clampIdleTtlMinutes(-5)).toBe(DEFAULT_IDLE_TTL_MINUTES);
  });

  test('non-integer numbers fall back to the default', () => {
    expect(clampIdleTtlMinutes(30.5)).toBe(DEFAULT_IDLE_TTL_MINUTES);
    expect(clampIdleTtlMinutes(Number.NaN)).toBe(DEFAULT_IDLE_TTL_MINUTES);
    expect(clampIdleTtlMinutes(Number.POSITIVE_INFINITY)).toBe(DEFAULT_IDLE_TTL_MINUTES);
  });

  test('malformed stored values (non-numbers) fall back to the default', () => {
    expect(clampIdleTtlMinutes('30')).toBe(DEFAULT_IDLE_TTL_MINUTES);
    expect(clampIdleTtlMinutes(null)).toBe(DEFAULT_IDLE_TTL_MINUTES);
    expect(clampIdleTtlMinutes(undefined)).toBe(DEFAULT_IDLE_TTL_MINUTES);
    expect(clampIdleTtlMinutes({})).toBe(DEFAULT_IDLE_TTL_MINUTES);
  });
});

describe('shouldDisconnectForIdle', () => {
  const NOW = 1_000_000_000;

  test('never disconnects when the setting is IDLE_TTL_NEVER, no matter how stale', () => {
    const longAgo = NOW - 365 * 24 * 60 * 60_000;
    expect(shouldDisconnectForIdle(longAgo, NOW, IDLE_TTL_NEVER)).toBe(false);
  });

  test('does not disconnect a tab whose activity is within the TTL window', () => {
    const lastActivityAt = NOW - 10 * 60_000; // 10 minutes ago
    expect(shouldDisconnectForIdle(lastActivityAt, NOW, 30)).toBe(false);
  });

  test('disconnects a tab exactly at the TTL boundary', () => {
    const lastActivityAt = NOW - 30 * 60_000; // exactly 30 minutes ago
    expect(shouldDisconnectForIdle(lastActivityAt, NOW, 30)).toBe(true);
  });

  test('disconnects a tab well past the TTL window', () => {
    const lastActivityAt = NOW - 45 * 60_000;
    expect(shouldDisconnectForIdle(lastActivityAt, NOW, 30)).toBe(true);
  });

  test('a 1-minute setting disconnects after just over a minute of silence', () => {
    const lastActivityAt = NOW - 61_000;
    expect(shouldDisconnectForIdle(lastActivityAt, NOW, 1)).toBe(true);
  });
});

/*
 * Owner decision D1: the idle disconnect may not fire while a flow runs on
 * the tab; the flow's steps count as activity, so once it ends the window
 * counts from its last step. A flow's own maximum duration bounds the hold.
 */
describe('the idle sweep and running flows (owner decision D1)', () => {
  const NOW = 1_000_000_000;
  const MIN = 60_000;

  test('a running flow keeps its tab connected past the TTL', () => {
    expect(shouldDisconnectForIdle(NOW - 45 * MIN, NOW, 30, [NOW + 1])).toBe(false);
  });

  test('a flow past its own maximum no longer holds, and the window counts from that bound', () => {
    expect(shouldDisconnectForIdle(NOW - 45 * MIN, NOW, 30, [NOW - 30 * MIN + 1])).toBe(false);
    expect(shouldDisconnectForIdle(NOW - 45 * MIN, NOW, 30, [NOW - 30 * MIN])).toBe(true);
  });

  test('"never" stays never with a flow running', () => {
    expect(shouldDisconnectForIdle(NOW - 45 * MIN, NOW, IDLE_TTL_NEVER, [NOW - 99 * MIN])).toBe(
      false,
    );
  });

  test('when a flow ends, its last step is the last activity (and never moves it backwards)', () => {
    const endedAt = NOW - 5 * MIN;
    const after = activityAfterFlowEnded(NOW - 40 * MIN, endedAt);
    expect(after).toBe(endedAt);
    expect(shouldDisconnectForIdle(after, NOW, 30)).toBe(false);
    expect(shouldDisconnectForIdle(after, endedAt + 30 * MIN, 30)).toBe(true);
    expect(activityAfterFlowEnded(NOW, endedAt)).toBe(NOW);
  });

  test("a hold's bound is the flow's own maximum: the detached ceiling or the foreground deadline", () => {
    const startedAt = NOW;
    expect(idleHoldUntil({ detached: true, startedAt, expiresAt: NOW + 30 * MIN }, undefined)).toBe(
      NOW + 30 * MIN,
    );
    expect(idleHoldUntil({ detached: false, startedAt }, NOW + 57_000)).toBe(NOW + 57_000);
    // A server that sent no deadline: the longest any flow may run.
    expect(idleHoldUntil({ detached: false, startedAt }, undefined)).toBe(
      NOW + MAX_DETACHED_FLOW_MS,
    );
  });

  test('the sweep disconnects only idle tabs with no flow holding them', () => {
    const tabs: [number, number][] = [
      [1, NOW - 45 * MIN],
      [2, NOW - 45 * MIN],
      [3, NOW - 5 * MIN],
    ];
    const holds = [{ tabId: 2, holdUntil: NOW + 10 * MIN }];
    expect(tabsToDisconnectForIdle(tabs, holds, NOW, 30)).toEqual([1]);
    expect(tabsToDisconnectForIdle(tabs, [], NOW, 30)).toEqual([1, 2]);
    expect(tabsToDisconnectForIdle(tabs, holds, NOW, IDLE_TTL_NEVER)).toEqual([]);
  });
});

describe('shouldScheduleIdleSweep', () => {
  test('false when the setting is "never"', () => {
    expect(shouldScheduleIdleSweep(IDLE_TTL_NEVER)).toBe(false);
  });

  test('true for any positive minute setting', () => {
    expect(shouldScheduleIdleSweep(1)).toBe(true);
    expect(shouldScheduleIdleSweep(DEFAULT_IDLE_TTL_MINUTES)).toBe(true);
    expect(shouldScheduleIdleSweep(MAX_IDLE_TTL_MINUTES)).toBe(true);
  });
});

describe('the idle sweep and calls in progress (BL-EXT-098)', () => {
  const NOW = 1_000_000_000;
  const MIN = 60_000;

  test('a call still running keeps its tab connected past a TTL shorter than the call', () => {
    // A 2-minute browser.download started at its tool.request, idle-ttl 1 minute.
    const tabs: [number, number][] = [[1, NOW - 2 * MIN]];
    const calls = [{ tabId: 1, startedAt: NOW - 2 * MIN }];
    expect(tabsToDisconnectForIdle(tabs, [], NOW, 1, calls)).toEqual([]);
    expect(tabsToDisconnectForIdle(tabs, [], NOW, 1)).toEqual([1]);
  });

  test('a call that never answers stops holding at its bound, and the window counts from there', () => {
    const startedAt = NOW - MAX_CALL_HOLD_MS - 30 * MIN;
    const tabs: [number, number][] = [[1, startedAt]];
    const calls = [{ tabId: 1, startedAt }];
    expect(tabsToDisconnectForIdle(tabs, [], NOW, 31, calls)).toEqual([]);
    expect(tabsToDisconnectForIdle(tabs, [], NOW, 30, calls)).toEqual([1]);
  });

  test('a call holds only its own tab, and "never" stays never', () => {
    const tabs: [number, number][] = [
      [1, NOW - 45 * MIN],
      [2, NOW - 45 * MIN],
    ];
    const calls = [{ tabId: 2, startedAt: NOW - 2 * MIN }];
    expect(tabsToDisconnectForIdle(tabs, [], NOW, 30, calls)).toEqual([1]);
    expect(tabsToDisconnectForIdle(tabs, [], NOW, IDLE_TTL_NEVER, calls)).toEqual([]);
  });
});
