import { describe, expect, test } from 'vitest';
import { shouldAcceptIncomingSettings } from './idle-policy.js';
import {
  DEFAULT_FLOW_RECORDING_ENABLED,
  FLOW_RECORDING_STORAGE_KEY,
  FLOW_RECORDING_UPDATED_AT_STORAGE_KEY,
  normalizeFlowRecordingEnabled,
  parseIncomingFlowRecordingSettings,
} from './flow-recording-policy.js';

describe('storage key constants', () => {
  test('are distinct from each other and non-empty', () => {
    expect(FLOW_RECORDING_STORAGE_KEY).toBe('flowRecordingEnabled');
    expect(FLOW_RECORDING_UPDATED_AT_STORAGE_KEY).toBe('flowRecordingUpdatedAt');
    expect(FLOW_RECORDING_STORAGE_KEY).not.toBe(FLOW_RECORDING_UPDATED_AT_STORAGE_KEY);
  });
});

describe('DEFAULT_FLOW_RECORDING_ENABLED', () => {
  test('is off — strictly opt-in', () => {
    expect(DEFAULT_FLOW_RECORDING_ENABLED).toBe(false);
  });
});

describe('normalizeFlowRecordingEnabled', () => {
  test('only the literal boolean true resolves to true', () => {
    expect(normalizeFlowRecordingEnabled(true)).toBe(true);
  });

  test('everything else — including truthy-looking values — resolves to false', () => {
    expect(normalizeFlowRecordingEnabled(false)).toBe(false);
    expect(normalizeFlowRecordingEnabled(undefined)).toBe(false);
    expect(normalizeFlowRecordingEnabled(null)).toBe(false);
    expect(normalizeFlowRecordingEnabled('true')).toBe(false);
    expect(normalizeFlowRecordingEnabled(1)).toBe(false);
    expect(normalizeFlowRecordingEnabled({})).toBe(false);
  });
});

describe('parseIncomingFlowRecordingSettings', () => {
  test('valid payload parses through', () => {
    const parsed = parseIncomingFlowRecordingSettings({
      flowRecordingEnabled: true,
      flowRecordingUpdatedAt: 123,
    });
    expect(parsed).toEqual({ flowRecordingEnabled: true, updatedAt: 123 });
  });

  test('a settings.update carrying only the idle-ttl pair returns null', () => {
    expect(parseIncomingFlowRecordingSettings({ idleTtlMinutes: 15, updatedAt: 1 })).toBeNull();
  });

  test('a settings.update carrying both pairs parses just the flow-recording half', () => {
    const parsed = parseIncomingFlowRecordingSettings({
      idleTtlMinutes: 15,
      updatedAt: 1,
      flowRecordingEnabled: false,
      flowRecordingUpdatedAt: 999,
    });
    expect(parsed).toEqual({ flowRecordingEnabled: false, updatedAt: 999 });
  });

  test('rejects non-boolean flowRecordingEnabled', () => {
    expect(
      parseIncomingFlowRecordingSettings({
        flowRecordingEnabled: 'yes',
        flowRecordingUpdatedAt: 1,
      }),
    ).toBeNull();
  });

  test('rejects missing/non-finite flowRecordingUpdatedAt', () => {
    expect(parseIncomingFlowRecordingSettings({ flowRecordingEnabled: true })).toBeNull();
    expect(
      parseIncomingFlowRecordingSettings({
        flowRecordingEnabled: true,
        flowRecordingUpdatedAt: Number.NaN,
      }),
    ).toBeNull();
  });

  test('rejects non-object / null input', () => {
    expect(parseIncomingFlowRecordingSettings(null)).toBeNull();
    expect(parseIncomingFlowRecordingSettings('nope')).toBeNull();
    expect(parseIncomingFlowRecordingSettings(undefined)).toBeNull();
  });
});

describe('flow-recording reuses idle-policy.shouldAcceptIncomingSettings for precedence', () => {
  test('no local write yet — incoming always wins', () => {
    expect(shouldAcceptIncomingSettings(undefined, 500)).toBe(true);
  });

  test('newest updatedAt wins regardless of which setting it is stamping', () => {
    expect(shouldAcceptIncomingSettings(1000, 2000)).toBe(true);
    expect(shouldAcceptIncomingSettings(2000, 1000)).toBe(false);
  });
});
