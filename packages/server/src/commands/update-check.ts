import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataDir } from '../map/paths.js';
import { checkUpdates, type UpdateInfo } from './updates.js';
import { VERSION } from '../version.js';

/**
 * Background update check — thin wrapper around `checkUpdates` for the
 * passive update banner in the TUI. We persist the last successful check
 * to disk under the existing data dir so opening the TUI repeatedly
 * within a 6-hour window does not hammer the npm registry.
 *
 * Failure modes are silent by design: the banner is passive, so anything
 * we cannot determine (offline, registry down, malformed cache) collapses
 * to "no banner". The user never sees an error from this path.
 */

export interface UpdateCheckResult {
  /** The version baked into this build. */
  current: string;
  /** The latest version on the registry, or null when the check failed
   * AND no cached value is available. */
  latest: string | null;
  /** True only when we successfully determined latest > current. */
  isNewer: boolean;
}

interface CacheFile {
  current: string;
  latest: string | null;
  /** Epoch millis when the cache was written. */
  checkedAtMs: number;
}

const CACHE_FILE_NAME = 'update-check.json';
/** How long a cached registry response is considered fresh. Six hours
 * matches the in-memory poll interval in `useBackgroundUpdateCheck`, so
 * the disk cache is a peer (not a tighter limit). */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function cachePath(): string {
  return join(getDataDir(), CACHE_FILE_NAME);
}

function readCache(): CacheFile | null {
  const p = cachePath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const cf = parsed as Partial<CacheFile>;
    if (typeof cf.current !== 'string' || typeof cf.checkedAtMs !== 'number') return null;
    if (cf.latest !== null && typeof cf.latest !== 'string') return null;
    // Defense in depth: even though we only write semver-validated values
    // ourselves, a cache file authored by an older release or hand-edited
    // could contain something else. Drop anything that does not match.
    const safeLatest = cf.latest && isValidSemver(cf.latest) ? cf.latest : null;
    return { current: cf.current, latest: safeLatest, checkedAtMs: cf.checkedAtMs };
  } catch {
    return null;
  }
}

function writeCache(cf: CacheFile): void {
  const p = cachePath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cf, null, 2) + '\n', 'utf8');
  } catch {
    /* swallow — the banner is passive, persistence failures are not user-facing */
  }
}

/** Strict semver-with-optional-prerelease regex used to validate every
 * `latest` string before we trust it enough to persist to disk. The npm
 * registry would only ever return a value of this shape, but CodeQL
 * (correctly) treats anything that crossed the network boundary as
 * untrusted, so we validate at the boundary. A bad value just collapses
 * to "no cache update" — the banner is passive. */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

function isValidSemver(s: string): boolean {
  return SEMVER_RE.test(s);
}

/** Compare two plain semver triplets. Reuses the same loose comparison
 * style as `commands/updates.ts` — pre-release suffixes are not handled. */
function isNewer(latest: string, current: string): boolean {
  const a = latest.split('.').map((n) => Number(n) || 0);
  const b = current.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

/** Run a background update check. Honours the on-disk cache so opening
 * the TUI repeatedly within 6 hours does not re-hit the npm registry.
 * Pass `force: true` (or omit the cache) to bypass the freshness check. */
export async function checkForUpdates(opts: { force?: boolean } = {}): Promise<UpdateCheckResult> {
  const cached = readCache();
  const now = Date.now();
  if (
    !opts.force &&
    cached !== null &&
    cached.current === VERSION &&
    now - cached.checkedAtMs < CACHE_TTL_MS
  ) {
    return {
      current: VERSION,
      latest: cached.latest,
      isNewer: cached.latest !== null && isNewer(cached.latest, VERSION),
    };
  }
  const info: UpdateInfo = await checkUpdates();
  // Validate the registry-returned `latest` against a strict semver regex
  // BEFORE we trust it for cache persistence or `isNewer` comparison.
  // Anything that crossed the network boundary is treated as untrusted;
  // a malformed value collapses to "no banner", which is the right
  // failure mode for a passive check.
  const safeLatest = info.latest !== null && isValidSemver(info.latest) ? info.latest : null;
  // Persist only successful, well-formed checks — a failed lookup or a
  // weird response must not poison the cache and silence a future
  // legitimate detection.
  if (safeLatest !== null) {
    writeCache({ current: VERSION, latest: safeLatest, checkedAtMs: now });
  }
  return {
    current: VERSION,
    latest: safeLatest,
    isNewer: safeLatest !== null && isNewer(safeLatest, VERSION),
  };
}
