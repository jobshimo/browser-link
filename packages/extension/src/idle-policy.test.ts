import { describe, expect, test } from 'vitest';
import {
  DEFAULT_IDLE_TTL_MINUTES,
  IDLE_TTL_NEVER,
  MAX_IDLE_TTL_MINUTES,
  MIN_IDLE_TTL_MINUTES,
  clampIdleTtlMinutes,
  parseIncomingSettings,
  shouldAcceptIncomingSettings,
  shouldDisconnectForIdle,
  shouldScheduleIdleSweep,
} from './idle-policy.js';

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

describe('shouldAcceptIncomingSettings', () => {
  test('always accepts when there is no local write yet (fresh install)', () => {
    expect(shouldAcceptIncomingSettings(undefined, 1)).toBe(true);
    expect(shouldAcceptIncomingSettings(undefined, 0)).toBe(true);
  });

  test('accepts a strictly newer incoming value', () => {
    expect(shouldAcceptIncomingSettings(1000, 2000)).toBe(true);
  });

  test('rejects an older or equal incoming value — local write wins ties', () => {
    expect(shouldAcceptIncomingSettings(2000, 1000)).toBe(false);
    expect(shouldAcceptIncomingSettings(2000, 2000)).toBe(false);
  });
});

describe('parseIncomingSettings', () => {
  /** Mirror background.ts's real WS message path: `safeParse` is a bare
   * `JSON.parse(raw) as ServerToExtension` cast, then the settings.update
   * branch hands `msg.settings` to `parseIncomingSettings`. These tests
   * feed raw wire strings through the exact same parse-then-guard sequence
   * so the assertions hold for the shipped handling, not a test-only
   * approximation. */
  function settingsFromWire(raw: string): unknown {
    const msg = JSON.parse(raw) as { kind?: string; settings?: unknown };
    expect(msg.kind).toBe('settings.update');
    return msg.settings;
  }

  test('accepts a well-formed wire message, including the 0 ("never") value', () => {
    expect(
      parseIncomingSettings(
        settingsFromWire(
          '{"kind":"settings.update","settings":{"idleTtlMinutes":15,"updatedAt":1700000000000}}',
        ),
      ),
    ).toEqual({ idleTtlMinutes: 15, updatedAt: 1_700_000_000_000 });
    expect(
      parseIncomingSettings(
        settingsFromWire(
          '{"kind":"settings.update","settings":{"idleTtlMinutes":0,"updatedAt":1}}',
        ),
      ),
    ).toEqual({ idleTtlMinutes: 0, updatedAt: 1 });
  });

  test('rejects a wire message whose settings payload is missing', () => {
    expect(parseIncomingSettings(settingsFromWire('{"kind":"settings.update"}'))).toBeNull();
  });

  test('rejects a wire message with a non-object settings payload', () => {
    expect(
      parseIncomingSettings(settingsFromWire('{"kind":"settings.update","settings":null}')),
    ).toBeNull();
    expect(
      parseIncomingSettings(settingsFromWire('{"kind":"settings.update","settings":"30"}')),
    ).toBeNull();
  });

  test('rejects a mistyped idleTtlMinutes', () => {
    expect(
      parseIncomingSettings(
        settingsFromWire(
          '{"kind":"settings.update","settings":{"idleTtlMinutes":"30","updatedAt":1}}',
        ),
      ),
    ).toBeNull();
  });

  test('rejects a missing or mistyped updatedAt', () => {
    expect(
      parseIncomingSettings(
        settingsFromWire('{"kind":"settings.update","settings":{"idleTtlMinutes":30}}'),
      ),
    ).toBeNull();
    expect(
      parseIncomingSettings(
        settingsFromWire(
          '{"kind":"settings.update","settings":{"idleTtlMinutes":30,"updatedAt":"now"}}',
        ),
      ),
    ).toBeNull();
  });

  test('rejects non-finite numbers (defense in depth beyond JSON)', () => {
    // NaN/Infinity cannot arrive via JSON, but the guard must hold for any
    // caller — same defense-in-depth stance as the server's frame parser.
    expect(parseIncomingSettings({ idleTtlMinutes: Number.NaN, updatedAt: 1 })).toBeNull();
    expect(
      parseIncomingSettings({ idleTtlMinutes: 30, updatedAt: Number.POSITIVE_INFINITY }),
    ).toBeNull();
  });
});
