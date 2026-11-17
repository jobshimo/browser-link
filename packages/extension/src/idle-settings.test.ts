import { describe, expect, test } from 'vitest';
import { DEFAULT_IDLE_TTL_MINUTES, IDLE_TTL_NEVER } from '@browser-link/core';
import {
  CONSOLE_IDLE_TTL_STORAGE_KEY,
  LEGACY_IDLE_TTL_STORAGE_KEY,
  LEGACY_IDLE_TTL_UPDATED_AT_STORAGE_KEY,
  effectiveIdleTtlMinutes,
  idleTtlCommand,
  legacyIdleChoice,
  parseIncomingSettings,
  shouldAcceptIncomingSettings,
} from './idle-settings.js';

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

describe('one idle value, owned by the console (S2)', () => {
  test('the value in effect is the one the server pushed, 30 min until it pushes one', () => {
    expect(effectiveIdleTtlMinutes({})).toBe(DEFAULT_IDLE_TTL_MINUTES);
    expect(effectiveIdleTtlMinutes({ [CONSOLE_IDLE_TTL_STORAGE_KEY]: 45 })).toBe(45);
    expect(effectiveIdleTtlMinutes({ [CONSOLE_IDLE_TTL_STORAGE_KEY]: 0 })).toBe(IDLE_TTL_NEVER);
    expect(effectiveIdleTtlMinutes({ [CONSOLE_IDLE_TTL_STORAGE_KEY]: 'x' })).toBe(30);
  });

  test('an old popup choice never wins, whatever its timestamp', () => {
    const stored = {
      [LEGACY_IDLE_TTL_STORAGE_KEY]: 5,
      [LEGACY_IDLE_TTL_UPDATED_AT_STORAGE_KEY]: Number.MAX_SAFE_INTEGER,
    };
    expect(effectiveIdleTtlMinutes(stored)).toBe(30);
    expect(effectiveIdleTtlMinutes({ ...stored, [CONSOLE_IDLE_TTL_STORAGE_KEY]: 120 })).toBe(120);
  });

  test('the old popup choice is reported while it differs from the value in effect, with the command that keeps it', () => {
    expect(legacyIdleChoice({})).toBeNull();
    expect(legacyIdleChoice({ [LEGACY_IDLE_TTL_STORAGE_KEY]: 30 })).toBeNull();
    expect(legacyIdleChoice({ [LEGACY_IDLE_TTL_STORAGE_KEY]: 5 })).toEqual({
      minutes: 5,
      command: 'browser-link config set idle-ttl 5',
    });
    expect(legacyIdleChoice({ [LEGACY_IDLE_TTL_STORAGE_KEY]: 0 })).toEqual({
      minutes: 0,
      command: 'browser-link config set idle-ttl never',
    });
    expect(
      legacyIdleChoice({ [LEGACY_IDLE_TTL_STORAGE_KEY]: 5, [CONSOLE_IDLE_TTL_STORAGE_KEY]: 5 }),
    ).toBeNull();
  });

  test('the console command for the value in effect', () => {
    expect(idleTtlCommand(30)).toBe('browser-link config set idle-ttl 30');
    expect(idleTtlCommand(IDLE_TTL_NEVER)).toBe('browser-link config set idle-ttl never');
  });
});
