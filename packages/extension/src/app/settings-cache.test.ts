// The settings caches (design 6.1, slice 21b) on the in-memory local storage:
// what each cache holds after load, after a storage change and after a
// `settings.update` push, and the recordings discarded when the toggle goes
// off.
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_IDLE_TTL_MINUTES, MAX_IDLE_TTL_MINUTES } from '@browser-link/core';
import { createMemorySettings } from '../../contract/memory-settings.js';
import {
  FLOW_RECORDING_STORAGE_KEY,
  FLOW_RECORDING_UPDATED_AT_STORAGE_KEY,
} from '../flow-recording-policy.js';
import { CONSOLE_IDLE_TTL_STORAGE_KEY } from '../idle-settings.js';
import { createSettingsCache } from './settings-cache.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function harness(initial: Record<string, unknown> = {}, tabs: number[] = []) {
  const storage = createMemorySettings(initial);
  const discardRecording = vi.fn((_tabId: number) => Promise.resolve());
  const settings = createSettingsCache({ storage, tabIds: () => tabs, discardRecording });
  storage.onChanged((changes, area) => {
    settings.idleTtlChanged(changes, area);
  });
  storage.onChanged((changes, area) => {
    settings.flowRecordingChanged(changes, area);
  });
  return { storage, settings, discardRecording };
}

describe('settings cache: load', () => {
  it('defaults before load: 30 minutes, recording off', () => {
    const { settings } = harness({ [CONSOLE_IDLE_TTL_STORAGE_KEY]: 5 });
    expect(settings.idleTtlMinutes()).toBe(DEFAULT_IDLE_TTL_MINUTES);
    expect(settings.flowRecordingEnabled()).toBe(false);
  });

  it('reads both values from storage', async () => {
    const { settings } = harness({
      [CONSOLE_IDLE_TTL_STORAGE_KEY]: 0,
      [FLOW_RECORDING_STORAGE_KEY]: true,
    });
    await settings.load();
    expect(settings.idleTtlMinutes()).toBe(0);
    expect(settings.flowRecordingEnabled()).toBe(true);
  });

  it('a stored value out of range or not a boolean falls back to the default', async () => {
    const { settings } = harness({
      [CONSOLE_IDLE_TTL_STORAGE_KEY]: MAX_IDLE_TTL_MINUTES + 1,
      [FLOW_RECORDING_STORAGE_KEY]: 'true',
    });
    await settings.load();
    expect(settings.idleTtlMinutes()).toBe(DEFAULT_IDLE_TTL_MINUTES);
    expect(settings.flowRecordingEnabled()).toBe(false);
  });

  it('storage unavailable: the defaults', async () => {
    const { storage, settings } = harness();
    storage.fail(true);
    await settings.load();
    expect(settings.idleTtlMinutes()).toBe(DEFAULT_IDLE_TTL_MINUTES);
    expect(settings.flowRecordingEnabled()).toBe(false);
  });
});

describe('settings cache: storage changes', () => {
  it('a local change of either key updates its cache', async () => {
    const { storage, settings } = harness();
    await storage.set({ [CONSOLE_IDLE_TTL_STORAGE_KEY]: 12 });
    await storage.set({ [FLOW_RECORDING_STORAGE_KEY]: true });
    expect(settings.idleTtlMinutes()).toBe(12);
    expect(settings.flowRecordingEnabled()).toBe(true);
  });

  it('a change in another area, or of another key, changes nothing', async () => {
    const { storage, settings } = harness();
    storage.changeIn('session', {
      [CONSOLE_IDLE_TTL_STORAGE_KEY]: { newValue: 12 },
      [FLOW_RECORDING_STORAGE_KEY]: { newValue: true },
    });
    await storage.set({ other: 12 });
    expect(settings.idleTtlMinutes()).toBe(DEFAULT_IDLE_TTL_MINUTES);
    expect(settings.flowRecordingEnabled()).toBe(false);
  });

  it('the idle TTL removed: back to the default', async () => {
    const { storage, settings } = harness({ [CONSOLE_IDLE_TTL_STORAGE_KEY]: 12 });
    await settings.load();
    await storage.remove(CONSOLE_IDLE_TTL_STORAGE_KEY);
    expect(settings.idleTtlMinutes()).toBe(DEFAULT_IDLE_TTL_MINUTES);
  });

  it('the toggle going off discards the recording of every connected tab', async () => {
    const { storage, discardRecording } = harness({}, [3, 5]);
    await storage.set({ [FLOW_RECORDING_STORAGE_KEY]: true });
    expect(discardRecording).not.toHaveBeenCalled();
    discardRecording.mockReturnValueOnce(Promise.reject(new Error('mid-teardown')));
    await storage.set({ [FLOW_RECORDING_STORAGE_KEY]: false });
    await flush();
    expect(discardRecording.mock.calls).toEqual([[3], [5]]);
  });

  it('the toggle removed counts as off', async () => {
    const { storage, discardRecording } = harness({ [FLOW_RECORDING_STORAGE_KEY]: true }, [3]);
    await storage.remove(FLOW_RECORDING_STORAGE_KEY);
    expect(discardRecording.mock.calls).toEqual([[3]]);
  });
});

describe('settings cache: settings.update pushes', () => {
  it('the idle TTL is stored clamped, whatever its updatedAt', async () => {
    const { storage, settings } = harness();
    settings.applyPushed({ idleTtlMinutes: 15, updatedAt: 1 });
    await flush();
    expect(storage.values.get(CONSOLE_IDLE_TTL_STORAGE_KEY)).toBe(15);
    settings.applyPushed({ idleTtlMinutes: MAX_IDLE_TTL_MINUTES + 5, updatedAt: 0 });
    await flush();
    expect(storage.values.get(CONSOLE_IDLE_TTL_STORAGE_KEY)).toBe(DEFAULT_IDLE_TTL_MINUTES);
    expect(settings.idleTtlMinutes()).toBe(DEFAULT_IDLE_TTL_MINUTES);
  });

  it('the toggle is stored with its updatedAt only when newer than the stored one', async () => {
    const { storage, settings } = harness({ [FLOW_RECORDING_UPDATED_AT_STORAGE_KEY]: 100 });
    settings.applyPushed({ flowRecordingEnabled: true, flowRecordingUpdatedAt: 100 });
    await flush();
    expect(storage.values.has(FLOW_RECORDING_STORAGE_KEY)).toBe(false);
    settings.applyPushed({ flowRecordingEnabled: true, flowRecordingUpdatedAt: 101 });
    await flush();
    expect(storage.values.get(FLOW_RECORDING_STORAGE_KEY)).toBe(true);
    expect(storage.values.get(FLOW_RECORDING_UPDATED_AT_STORAGE_KEY)).toBe(101);
    expect(settings.flowRecordingEnabled()).toBe(true);
  });

  it('one push may carry both pairs', async () => {
    const { storage, settings } = harness();
    settings.applyPushed({
      idleTtlMinutes: 0,
      updatedAt: 1,
      flowRecordingEnabled: true,
      flowRecordingUpdatedAt: 2,
    });
    await flush();
    expect(storage.values.get(CONSOLE_IDLE_TTL_STORAGE_KEY)).toBe(0);
    expect(storage.values.get(FLOW_RECORDING_STORAGE_KEY)).toBe(true);
  });

  it('a malformed push writes nothing, and a failed write stays quiet', async () => {
    const { storage, settings } = harness();
    settings.applyPushed(null);
    settings.applyPushed({ idleTtlMinutes: '5', updatedAt: 1 });
    settings.applyPushed({ flowRecordingEnabled: 'yes', flowRecordingUpdatedAt: 1 });
    await flush();
    expect(storage.values.size).toBe(0);
    storage.fail(true);
    settings.applyPushed({
      idleTtlMinutes: 5,
      updatedAt: 1,
      flowRecordingEnabled: true,
      flowRecordingUpdatedAt: 1,
    });
    await flush();
    expect(storage.values.size).toBe(0);
  });
});
