import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataDir } from '../map/paths.js';

/**
 * On-disk record of a `browser-link cdp allow` grant — the time-boxed human
 * consent that, together with `cdp-direct.enabled`, is required before any
 * tool may address a `cdp:` tab (see `gate.ts`). Lives in its own small JSON
 * file in the data dir, never in the repo, never in `config.json` (a grant
 * is a momentary permission, not a persistent preference).
 */
export interface CdpGrant {
  grantedAt: number;
  /** `null` means the grant never expires ("never" / `--minutes 0`) —
   * documented in the CLI help and README as reducing the security
   * posture, not a default anyone should reach for casually. */
  expiresAt: number | null;
}

function grantFile(): string {
  return join(getDataDir(), 'cdp-grant.json');
}

/** Absolute path of the grant file — exported so the CLI can name it in an
 * honest "could not remove" error (see `commands/cdp.ts`) rather than
 * leaving the user guessing which file to delete by hand. */
export function grantFilePath(): string {
  return grantFile();
}

function isCdpGrant(value: unknown): value is CdpGrant {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.grantedAt === 'number' && (v.expiresAt === null || typeof v.expiresAt === 'number')
  );
}

/** Read the current grant, or `null` when none exists or the file is
 * corrupt/unreadable — corruption degrades to "no grant" (the safer
 * failure mode for a permission file) rather than throwing. */
export function loadGrant(): CdpGrant | null {
  const path = grantFile();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isCdpGrant(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Record a fresh grant. `ttlMinutes: 0` means "never expires"
 * (`expiresAt: null`); any other value is the grant's lifetime in minutes
 * from `now`. `now` is a parameter so tests do not need to mock the clock. */
export function saveGrant(ttlMinutes: number, now: number = Date.now()): CdpGrant {
  const path = grantFile();
  mkdirSync(dirname(path), { recursive: true });
  const grant: CdpGrant = {
    grantedAt: now,
    expiresAt: ttlMinutes === 0 ? null : now + ttlMinutes * 60_000,
  };
  writeFileSync(path, JSON.stringify(grant, null, 2) + '\n', 'utf8');
  return grant;
}

/** Revoke the current grant, if any. Idempotent — revoking with no grant
 * present is not an error and is a no-op.
 *
 * Deliberately does NOT swallow an unlink failure: this is a SECURITY
 * operation, and a grant file that survives a "revoke" (a transient
 * Windows lock, an EPERM, a read-only dir) is still honoured by the gate
 * on the very next tool call — so reporting success while the door stays
 * open would be a lie. The error propagates; the CLI (`revokeCdpDirect` in
 * `commands/cdp.ts`) catches it and tells the user the grant may still be
 * active and to remove the file by hand. */
export function clearGrant(): void {
  const path = grantFile();
  if (!existsSync(path)) return;
  unlinkSync(path);
}

/** Whether `grant` is currently live: present, and either non-expiring or
 * not yet past its `expiresAt`. */
export function isGrantLive(grant: CdpGrant | null, now: number = Date.now()): boolean {
  if (!grant) return false;
  if (grant.expiresAt === null) return true;
  return grant.expiresAt > now;
}

/** Milliseconds remaining on `grant`, or `null` when it never expires or
 * does not exist (callers distinguish "no grant" from "never expires" by
 * checking `grant` itself first). Never negative — an expired grant reads
 * as `0` remaining, not a negative number. */
export function remainingMs(grant: CdpGrant | null, now: number = Date.now()): number | null {
  if (!grant || grant.expiresAt === null) return null;
  return Math.max(0, grant.expiresAt - now);
}
