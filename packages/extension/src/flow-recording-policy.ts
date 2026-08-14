/**
 * Pure decision logic for the opt-in flow-recording setting, mirroring
 * idle-policy.ts's separation between chrome.* I/O (background.ts /
 * popup.ts) and the pure precedence/parsing rules tested here.
 *
 * Deliberately does NOT redefine a last-write-wins comparator — that rule
 * is generic (compare two epoch-ms timestamps, newest wins) and already
 * lives as `shouldAcceptIncomingSettings` in idle-policy.ts. A second copy
 * here would just be a fork waiting to drift; callers import that one
 * function for both settings.
 */

/** chrome.storage key the setting is persisted under, in
 * `chrome.storage.local` — same storage area as `IDLE_TTL_STORAGE_KEY`, a
 * per-device preference. */
export const FLOW_RECORDING_STORAGE_KEY = 'flowRecordingEnabled';

/** chrome.storage key for the epoch-ms timestamp of the last LOCAL write
 * to `FLOW_RECORDING_STORAGE_KEY` — i.e. from the popup's own toggle, not
 * from an incoming `settings.update`. Mirrors the server-side
 * `flowRecordingUpdatedAt` config field by name, since both sides compare
 * one against the other. */
export const FLOW_RECORDING_UPDATED_AT_STORAGE_KEY = 'flowRecordingUpdatedAt';

/** STRICTLY OPT-IN — every install starts with recording OFF until the
 * user flips the popup toggle or runs `browser-link config set
 * flow-recording on`. Unlike the idle-TTL default (30 minutes, a UX
 * convenience), this default is a privacy commitment: nothing about a
 * user's interactions is ever captured unless they explicitly turn it on. */
export const DEFAULT_FLOW_RECORDING_ENABLED = false;

/** Coerce an arbitrary stored value into a safe boolean. Any non-`true`
 * value (undefined, a corrupted string, a stale falsy sentinel) resolves
 * to the opt-in default of `false` — never "fail open" into recording. */
export function normalizeFlowRecordingEnabled(value: unknown): boolean {
  return value === true;
}

/** Validated shape of an incoming `settings.update` payload's
 * flow-recording pair. */
export interface IncomingFlowRecordingSettings {
  flowRecordingEnabled: boolean;
  updatedAt: number;
}

/**
 * Runtime shape guard for the flow-recording pair of an incoming
 * `settings.update` WS message. The message arrives as untrusted JSON, and
 * a single `settings.update` may carry the idle-TTL pair, the
 * flow-recording pair, or both — this guard looks ONLY at the
 * flow-recording fields and returns `null` when they are absent or
 * malformed, independent of whether the idle-TTL fields parse. Mirrors
 * `parseIncomingSettings` in idle-policy.ts field-for-field.
 */
export function parseIncomingFlowRecordingSettings(
  value: unknown,
): IncomingFlowRecordingSettings | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  if (typeof s.flowRecordingEnabled !== 'boolean') return null;
  if (typeof s.flowRecordingUpdatedAt !== 'number' || !Number.isFinite(s.flowRecordingUpdatedAt)) {
    return null;
  }
  return { flowRecordingEnabled: s.flowRecordingEnabled, updatedAt: s.flowRecordingUpdatedAt };
}
