/**
 * Pure decision logic for the WS-idle sweep's timeout.
 *
 * The timeout has ONE value, owned by the console (1.3.0, S2):
 * `browser-link config set idle-ttl <minutes|never>`. The server pushes it on
 * every tab registration and on change; background.ts stores it under
 * `CONSOLE_IDLE_TTL_STORAGE_KEY` and the popup shows it read-only with the
 * console command. A value the popup stored before 1.3.0 is never applied:
 * the popup reports it while it differs, with the command that keeps it.
 *
 * Deliberately kept free of chrome.* — background.ts owns the
 * `chrome.storage` I/O and the `setInterval` loop that drives the actual
 * sweep; both it and popup.ts import the constants and pure functions here
 * so the decisions are unit-tested without mocking timers or storage. Same
 * separation `settle.ts` already established for the settle wait.
 */

import { MAX_DETACHED_FLOW_MS } from './flow-registry.js';

/** `chrome.storage.local` key of the value the console set, as the server
 * last pushed it. The only idle value the sweep applies. */
export const CONSOLE_IDLE_TTL_STORAGE_KEY = 'consoleIdleTtlMinutes';

/** `chrome.storage.local` keys where the popup kept its own idle choice
 * before 1.3.0. Read only to report that choice (`legacyIdleChoice`); never
 * applied, never written. */
export const LEGACY_IDLE_TTL_STORAGE_KEY = 'idleTtlMinutes';
export const LEGACY_IDLE_TTL_UPDATED_AT_STORAGE_KEY = 'idleTtlUpdatedAt';

/** Sentinel value for "auto-disconnect disabled" — surfaced in the popup as
 * "Never". Stored and compared as a plain number so the setting round-trips
 * through `chrome.storage` and a `<select>` value without a union type. */
export const IDLE_TTL_NEVER = 0;

/** Default TTL for new installs and any malformed stored value. Matches the
 * fixed 30-minute constant this feature replaces, so existing users see no
 * behavior change until they open the popup and pick something else. */
export const DEFAULT_IDLE_TTL_MINUTES = 30;

/** How long a single tool call in progress holds its tab's idle clock. Longer
 * than any one call may last (a download waits at most 2 minutes, a
 * screenshot 90 s); past it a call that never answered stops holding and
 * counts as activity at that bound, so a stuck call cannot keep a tab
 * connected for ever. Flows have their own, longer, bound. */
export const MAX_CALL_HOLD_MS = 10 * 60_000;

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
  /** Owner decision D1: the bound (`idleHoldUntil`) of every flow running
   * on the tab. A flow before its bound keeps the tab connected; one past
   * it counts as activity at that bound. */
  flowHoldsUntil: readonly number[] = [],
): boolean {
  if (idleTtlMinutes === IDLE_TTL_NEVER) return false;
  let lastActiveAt = lastActivityAt;
  for (const holdUntil of flowHoldsUntil) {
    if (now < holdUntil) return false;
    lastActiveAt = Math.max(lastActiveAt, holdUntil);
  }
  const ttlMs = idleTtlMinutes * 60_000;
  return now - lastActiveAt >= ttlMs;
}

/** A flow running on a tab, as the idle sweep sees it. */
export interface IdleFlowHold {
  tabId: number;
  /** See `idleHoldUntil`. */
  holdUntil: number;
}

/**
 * Until when a running flow holds its tab's idle clock: the flow's own
 * maximum duration, never longer. A detached flow ends at its ceiling
 * (`expiresAt`, `MAX_DETACHED_FLOW_MS` after it started); a foreground one
 * at the deadline the server sent with it. A server that sent no deadline
 * gets the longest any flow may run.
 */
export function idleHoldUntil(
  flow: { detached: boolean; startedAt: number; expiresAt?: number },
  foregroundDeadlineAt: number | undefined,
): number {
  const longest = flow.startedAt + MAX_DETACHED_FLOW_MS;
  if (flow.detached) return flow.expiresAt ?? longest;
  return foregroundDeadlineAt ?? longest;
}

/** When a flow ends, its last step is the tab's last activity: the idle
 * window restarts from it, not from the request that launched the flow. */
export function activityAfterFlowEnded(lastActivityAt: number, endedAt: number): number {
  return Math.max(lastActivityAt, endedAt);
}

/** A tool call the tab is still answering, as the idle sweep sees it. */
export interface IdleCallInProgress {
  tabId: number;
  /** When its `tool.request` arrived. */
  startedAt: number;
}

/** The tabs one sweep tick disconnects, from `[tabId, lastActivityAt]`
 * pairs, the flows running now and the calls in progress (BL-EXT-098: a
 * call longer than the TTL is not parked in the middle of its run; it holds
 * its tab like a flow, up to `MAX_CALL_HOLD_MS`). */
export function tabsToDisconnectForIdle(
  tabs: Iterable<readonly [number, number]>,
  holds: readonly IdleFlowHold[],
  now: number,
  idleTtlMinutes: number,
  calls: readonly IdleCallInProgress[] = [],
): number[] {
  const idle: number[] = [];
  for (const [tabId, lastActivityAt] of tabs) {
    const tabHolds = [
      ...holds.filter((h) => h.tabId === tabId).map((h) => h.holdUntil),
      ...calls.filter((c) => c.tabId === tabId).map((c) => c.startedAt + MAX_CALL_HOLD_MS),
    ];
    if (shouldDisconnectForIdle(lastActivityAt, now, idleTtlMinutes, tabHolds)) idle.push(tabId);
  }
  return idle;
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

/** The idle TTL in effect, from `chrome.storage.local`: the console's value
 * as last pushed, 30 minutes until a server pushed one. A legacy popup
 * value is ignored whatever its timestamp. */
export function effectiveIdleTtlMinutes(stored: Readonly<Record<string, unknown>>): number {
  const pushed = stored[CONSOLE_IDLE_TTL_STORAGE_KEY];
  return pushed === undefined ? DEFAULT_IDLE_TTL_MINUTES : clampIdleTtlMinutes(pushed);
}

/** The console command that sets `minutes` (`0` = never). */
export function idleTtlCommand(minutes: number): string {
  return `browser-link config set idle-ttl ${minutes === IDLE_TTL_NEVER ? 'never' : String(minutes)}`;
}

/** A choice the popup stored before 1.3.0, reported only while it differs
 * from the value in effect, with the command that would keep it. */
export function legacyIdleChoice(
  stored: Readonly<Record<string, unknown>>,
): { minutes: number; command: string } | null {
  const raw = stored[LEGACY_IDLE_TTL_STORAGE_KEY];
  if (raw === undefined) return null;
  const minutes = clampIdleTtlMinutes(raw);
  if (minutes === effectiveIdleTtlMinutes(stored)) return null;
  return { minutes, command: idleTtlCommand(minutes) };
}

/**
 * Precedence rule for an incoming `settings.update` WS message (see
 * `@browser-link/shared`'s `SettingsUpdatePayload`) against the value
 * already stored locally (edited from the popup, or a previous
 * `settings.update`): NEWEST WRITE WINS, decided purely by comparing
 * epoch-ms timestamps. Used by the flow-recording toggle; the idle TTL
 * (1.3.0) applies the console's value unconditionally.
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
