/**
 * The idle settings: where the WS-idle sweep's timeout is stored, how a
 * stored or incoming value is read, and the console command that sets it.
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
 * so the decisions are unit-tested without mocking timers or storage. The
 * idle rules themselves (the TTL bounds, the clamp, what holds a tab) live
 * in core's `policies/idle-rules.ts`.
 */

import { clampIdleTtlMinutes, DEFAULT_IDLE_TTL_MINUTES, IDLE_TTL_NEVER } from '@browser-link/core';

/** `chrome.storage.local` key of the value the console set, as the server
 * last pushed it. The only idle value the sweep applies. */
export const CONSOLE_IDLE_TTL_STORAGE_KEY = 'consoleIdleTtlMinutes';

/** `chrome.storage.local` keys where the popup kept its own idle choice
 * before 1.3.0. Read only to report that choice (`legacyIdleChoice`); never
 * applied, never written. */
export const LEGACY_IDLE_TTL_STORAGE_KEY = 'idleTtlMinutes';
export const LEGACY_IDLE_TTL_UPDATED_AT_STORAGE_KEY = 'idleTtlUpdatedAt';

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
