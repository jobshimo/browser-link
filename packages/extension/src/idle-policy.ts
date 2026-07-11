/**
 * Pure decision logic for the WS-idle sweep's user-configurable timeout.
 *
 * Deliberately kept free of chrome.* — background.ts owns the
 * `chrome.storage` I/O and the `setInterval` loop that drives the actual
 * sweep, popup.ts owns the settings control that writes the value; both
 * import the constants and pure functions here so the disconnect decision
 * itself is unit-tested without mocking timers or storage. Same separation
 * `settle.ts` already established for the click/type/press settle wait.
 */

/** chrome.storage key the setting is persisted under, in `chrome.storage.local`
 * (a per-device preference, not something that should sync across machines
 * the way a bookmark would — mirrors the local-only intent of the existing
 * `prevTabId:*` session keys, just in a persistent area instead of
 * `chrome.storage.session`). */
export const IDLE_TTL_STORAGE_KEY = 'idleTtlMinutes';

/**
 * chrome.storage key for the epoch-ms timestamp of the last LOCAL write to
 * `IDLE_TTL_STORAGE_KEY` — i.e. from the popup's own control, not from an
 * incoming `settings.update` (see `shouldAcceptIncomingSettings`). Mirrors
 * the server-side `idleTtlUpdatedAt` config field (`packages/server/src/
 * config.ts`) by name, since both sides compare one against the other.
 */
export const IDLE_TTL_UPDATED_AT_STORAGE_KEY = 'idleTtlUpdatedAt';

/** Sentinel value for "auto-disconnect disabled" — surfaced in the popup as
 * "Never". Stored and compared as a plain number so the setting round-trips
 * through `chrome.storage` and a `<select>` value without a union type. */
export const IDLE_TTL_NEVER = 0;

/** Default TTL for new installs and any malformed stored value. Matches the
 * fixed 30-minute constant this feature replaces, so existing users see no
 * behavior change until they open the popup and pick something else. */
export const DEFAULT_IDLE_TTL_MINUTES = 30;

/** Safety-rail bounds for any non-"never" value — see `clampIdleTtlMinutes`. */
export const MIN_IDLE_TTL_MINUTES = 1;
export const MAX_IDLE_TTL_MINUTES = 1440; // 24h — generous ceiling, still a same-day bound.

/**
 * Clamp an arbitrary stored or incoming value into a safe `idleTtlMinutes`.
 *
 * `IDLE_TTL_NEVER` (0) passes through untouched — "never" is a valid,
 * intentional choice, not an out-of-range one to be corrected. Anything
 * else that isn't a finite integer, or falls outside
 * `[MIN_IDLE_TTL_MINUTES, MAX_IDLE_TTL_MINUTES]`, falls back to
 * `DEFAULT_IDLE_TTL_MINUTES` rather than being clamped to the nearest
 * boundary — a malformed value (corrupted storage, a hand-edited value, a
 * future downgrade) should not silently turn into a surprising 1440-minute
 * timeout.
 */
export function clampIdleTtlMinutes(value: unknown): number {
  if (value === IDLE_TTL_NEVER) return IDLE_TTL_NEVER;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return DEFAULT_IDLE_TTL_MINUTES;
  }
  if (value < MIN_IDLE_TTL_MINUTES || value > MAX_IDLE_TTL_MINUTES) {
    return DEFAULT_IDLE_TTL_MINUTES;
  }
  return value;
}

/**
 * Decide whether a tab whose last activity landed at `lastActivityAt`
 * should be disconnected by the idle sweep, given the user's
 * `idleTtlMinutes` setting and the current time `now`. Pure — no timers,
 * no `chrome.*` — background.ts's sweep loop calls this once per connected
 * tab on every tick.
 *
 * The comparison is against the ABSOLUTE last-activity time, not the
 * moment the setting last changed: lowering the TTL (e.g. never → 5 min)
 * immediately puts any tab that has already been idle longer than the new
 * value past the threshold, so it disconnects on the next sweep tick.
 */
export function shouldDisconnectForIdle(
  lastActivityAt: number,
  now: number,
  idleTtlMinutes: number,
): boolean {
  if (idleTtlMinutes === IDLE_TTL_NEVER) return false;
  const ttlMs = idleTtlMinutes * 60_000;
  return now - lastActivityAt >= ttlMs;
}

/**
 * Whether the sweep tick is worth doing any work for. When the setting is
 * "never", `shouldDisconnectForIdle` returns `false` for every tab
 * regardless, so the sweep loop can skip walking `tabStates` entirely
 * instead of iterating it for nothing every `WS_IDLE_SWEEP_MS`.
 */
export function shouldScheduleIdleSweep(idleTtlMinutes: number): boolean {
  return idleTtlMinutes !== IDLE_TTL_NEVER;
}

/**
 * Precedence rule for an incoming `settings.update` WS message (see
 * `@browser-link/shared`'s `SettingsUpdatePayload`) against the value
 * already stored locally (edited from the popup, or a previous
 * `settings.update`): NEWEST WRITE WINS, decided purely by comparing
 * epoch-ms timestamps.
 *
 * `localUpdatedAt` is `undefined` exactly once per install — before the
 * popup has ever been used to change the setting. In that case there is no
 * local intent to protect, so the incoming value is always accepted
 * (this is what lets a value set via `browser-link config set idle-ttl`
 * before the extension was ever configured actually take effect on first
 * connect, instead of losing to a "local wins by default" rule).
 *
 * Comparing raw wall-clock timestamps across the server (Node) and browser
 * processes is safe specifically because browser-link is a loopback-only
 * bridge — both always run on the SAME machine and therefore share one
 * clock. This would NOT be a safe pattern for a distributed, multi-host
 * system.
 */
export function shouldAcceptIncomingSettings(
  localUpdatedAt: number | undefined,
  incomingUpdatedAt: number,
): boolean {
  if (localUpdatedAt === undefined) return true;
  return incomingUpdatedAt > localUpdatedAt;
}

/** Validated shape of an incoming `settings.update` payload. */
export interface IncomingIdleSettings {
  idleTtlMinutes: number;
  updatedAt: number;
}

/**
 * Runtime shape guard for the `settings` field of an incoming
 * `settings.update` WS message. The message arrives as untrusted JSON —
 * background.ts's `safeParse` is only a cast, not a validation — so a
 * malformed payload (missing or mistyped fields) must be rejected HERE, at
 * the wire boundary, instead of throwing inside the async apply path where
 * the error would be silently swallowed as a dropped sync. Mirrors the
 * rigor the IPC `settings.push` frame already gets in the server's
 * protocol.ts parser. Returns the narrowed payload, or `null` when the
 * shape is wrong.
 */
export function parseIncomingSettings(value: unknown): IncomingIdleSettings | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  if (typeof s.idleTtlMinutes !== 'number' || !Number.isFinite(s.idleTtlMinutes)) return null;
  if (typeof s.updatedAt !== 'number' || !Number.isFinite(s.updatedAt)) return null;
  return { idleTtlMinutes: s.idleTtlMinutes, updatedAt: s.updatedAt };
}
