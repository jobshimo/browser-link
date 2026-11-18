// The extension's settings caches (design 6.1, slice 21b): the idle TTL the
// sweep reads and the flow-recording toggle recording reads, both mirrored
// from local storage, and the `settings.update` pushes that write them. No
// `chrome`: `background.ts` passes in the local-storage adapter
// (`adapters/chrome-settings.ts`) and subscribes its `onChanged` at top level.

import {
  DEFAULT_IDLE_TTL_MINUTES,
  clampIdleTtlMinutes,
  type IdleSettings,
} from '@browser-link/core';
import {
  DEFAULT_FLOW_RECORDING_ENABLED,
  FLOW_RECORDING_STORAGE_KEY,
  FLOW_RECORDING_UPDATED_AT_STORAGE_KEY,
  normalizeFlowRecordingEnabled,
  parseIncomingFlowRecordingSettings,
  type IncomingFlowRecordingSettings,
} from '../flow-recording-policy.js';
import {
  CONSOLE_IDLE_TTL_STORAGE_KEY,
  effectiveIdleTtlMinutes,
  parseIncomingSettings,
  shouldAcceptIncomingSettings,
  type IncomingIdleSettings,
} from '../idle-settings.js';

/** One storage change: the key's new value, absent when it was removed. */
export interface StorageChange {
  newValue?: unknown;
}

/** The extension's local storage (`adapters/chrome-settings.ts`). */
export interface LocalSettingsStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  /** Called with every storage change and the area it happened in (`local`,
   * `session`, ...). A wake listener: subscribed only at the top level of
   * `background.ts` (R1). */
  onChanged(listener: (changes: Record<string, StorageChange>, area: string) => void): void;
}

export interface SettingsCacheDeps {
  storage: Pick<LocalSettingsStorage, 'get' | 'set'>;
  /** The tabs that may be recording, read when the toggle goes off. */
  tabIds(): Iterable<number>;
  /** Stop and discard the tab's recording (`Recording.forceStopAndDiscard`). */
  discardRecording(tabId: number): Promise<unknown>;
}

/**
 * The settings the worker reads synchronously (core `IdleSettings`, plus the
 * flow-recording toggle). Stateful (the two caches), so `background.ts`
 * builds it once.
 */
export interface SettingsCache extends IdleSettings {
  flowRecordingEnabled(): boolean;
  /** Read both values from storage; once per worker start. */
  load(): Promise<void>;
  /** A storage change that may concern the idle TTL. */
  idleTtlChanged(changes: Record<string, StorageChange>, area: string): void;
  /** A storage change that may concern the flow-recording toggle. */
  flowRecordingChanged(changes: Record<string, StorageChange>, area: string): void;
  /** A `settings.update` push, validated here at the wire boundary. */
  applyPushed(pushed: unknown): void;
}

export function createSettingsCache(deps: SettingsCacheDeps): SettingsCache {
  const { storage } = deps;
  /* Idle TTL for a tab's WebSocket bridge.
   *
   * After this many minutes without a tool.request from the server, the
   * extension closes its side of the WS and detaches the debugger. The
   * popup then shows "Not connected" again and the user explicitly
   * re-presses Connect when they want to reactivate — unless the console
   * set "never", in which case the sweep never fires.
   *
   * The TTL has one value, owned by the console (`browser-link config set
   * idle-ttl`, 1.3.0): the server pushes it in `settings.update` and it is
   * stored under `CONSOLE_IDLE_TTL_STORAGE_KEY` (see idle-settings.ts). A
   * value the popup stored before 1.3.0 is never applied. `idleTtlMinutes`
   * is the in-memory mirror the sweep reads on every tick: storage is async,
   * the sweep loop is not, so the value is loaded once at startup and kept
   * current via the storage change listener instead of being awaited inside
   * the interval callback. */
  let idleTtlMinutes = DEFAULT_IDLE_TTL_MINUTES;

  /* Opt-in flow-recording toggle — mirrors the idle-ttl cache/apply pair
   * exactly, independent storage keys, independent updatedAt. The recorder
   * is gated behind `flowRecordingEnabled`: `Recording.start` refuses when
   * it is false, and turning it off WHILE a recording is in progress
   * force-stops and DISCARDS it immediately (`flowRecordingChanged`) —
   * "nothing records when the popup toggle is off" is enforced the instant
   * the toggle flips, not just for recordings started afterward. */
  let flowRecordingEnabled = DEFAULT_FLOW_RECORDING_ENABLED;

  async function loadIdleTtlMinutes(): Promise<void> {
    try {
      const data = await storage.get(CONSOLE_IDLE_TTL_STORAGE_KEY);
      idleTtlMinutes = effectiveIdleTtlMinutes(data);
    } catch {
      idleTtlMinutes = DEFAULT_IDLE_TTL_MINUTES;
    }
  }

  async function loadFlowRecordingEnabled(): Promise<void> {
    try {
      const data = await storage.get(FLOW_RECORDING_STORAGE_KEY);
      flowRecordingEnabled = normalizeFlowRecordingEnabled(data[FLOW_RECORDING_STORAGE_KEY]);
    } catch {
      flowRecordingEnabled = DEFAULT_FLOW_RECORDING_ENABLED;
    }
  }

  /**
   * Apply an incoming `settings.update` push from the server (see the
   * server-message switch of `app/connection.ts` `openBridge`). The server
   * sends this both right after `tab.registered` (when `browser-link config
   * set idle-ttl` was run at least once) AND on demand when the CLI pushes a
   * change to an already-connected tab.
   *
   * The console owns the value (1.3.0, S2): it is applied whatever its
   * `updatedAt` says, and whatever the popup stored before 1.3.0. Writing it
   * to storage is enough to take effect: the change listener keeps the cache
   * current, and the popup re-reads storage on its own refresh interval.
   */
  async function applyIncomingSettings(settings: IncomingIdleSettings): Promise<void> {
    try {
      await storage.set({
        [CONSOLE_IDLE_TTL_STORAGE_KEY]: clampIdleTtlMinutes(settings.idleTtlMinutes),
      });
    } catch {
      // Best effort — a failed sync just leaves the local value as-is; the
      // next settings.update (or a popup edit) can still apply it.
    }
  }

  async function applyIncomingFlowRecordingSettings(
    settings: IncomingFlowRecordingSettings,
  ): Promise<void> {
    try {
      const data = await storage.get(FLOW_RECORDING_UPDATED_AT_STORAGE_KEY);
      const rawLocalUpdatedAt = data[FLOW_RECORDING_UPDATED_AT_STORAGE_KEY];
      const localUpdatedAt = typeof rawLocalUpdatedAt === 'number' ? rawLocalUpdatedAt : undefined;
      if (!shouldAcceptIncomingSettings(localUpdatedAt, settings.updatedAt)) return;
      await storage.set({
        [FLOW_RECORDING_STORAGE_KEY]: settings.flowRecordingEnabled,
        [FLOW_RECORDING_UPDATED_AT_STORAGE_KEY]: settings.updatedAt,
      });
    } catch {
      // Best effort — same degrade-gracefully rule as applyIncomingSettings.
    }
  }

  return {
    idleTtlMinutes: () => idleTtlMinutes,
    flowRecordingEnabled: () => flowRecordingEnabled,
    async load() {
      await Promise.all([loadIdleTtlMinutes(), loadFlowRecordingEnabled()]);
    },
    idleTtlChanged(changes, area) {
      if (area !== 'local') return;
      if (!(CONSOLE_IDLE_TTL_STORAGE_KEY in changes)) return;
      idleTtlMinutes = effectiveIdleTtlMinutes({
        [CONSOLE_IDLE_TTL_STORAGE_KEY]: changes[CONSOLE_IDLE_TTL_STORAGE_KEY].newValue,
      });
    },
    flowRecordingChanged(changes, area) {
      if (area !== 'local') return;
      if (!(FLOW_RECORDING_STORAGE_KEY in changes)) return;
      flowRecordingEnabled = normalizeFlowRecordingEnabled(
        changes[FLOW_RECORDING_STORAGE_KEY].newValue,
      );
      if (flowRecordingEnabled) return;
      // Turned off (popup toggle, or a losing settings.update — either way
      // the new effective value is false): stop AND discard every
      // in-progress recording right now, across every connected tab
      // (`app/recording.ts`).
      for (const tabId of deps.tabIds()) {
        void deps.discardRecording(tabId).catch(() => {
          // Best effort — the tab may already be mid-teardown.
        });
      }
    },
    /** The frame is only cast (`app/connection.ts`), so each payload is
     * validated at the wire boundary (same rigor the IPC settings.push frame
     * gets in the server's protocol.ts): a malformed push is dropped here
     * instead of throwing inside the apply path. */
    applyPushed(pushed) {
      const settings = parseIncomingSettings(pushed);
      if (settings) void applyIncomingSettings(settings);
      const flowRecordingSettings = parseIncomingFlowRecordingSettings(pushed);
      if (flowRecordingSettings) void applyIncomingFlowRecordingSettings(flowRecordingSettings);
    },
  };
}
