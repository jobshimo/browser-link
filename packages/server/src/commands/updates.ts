import { PACKAGE_NAME, VERSION } from '../version.js';

export interface UpdateInfo {
  current: string;
  latest: string | null;
  /** `null` means we could not reach the registry; check `error` for why. */
  newer: boolean | null;
  error?: string;
}

/**
 * Ask the npm registry for the `latest` dist-tag and compare it to the
 * version baked into this package. Network round-trip is one tiny GET.
 *
 * Compares plain MAJOR.MINOR.PATCH numerically. Pre-release suffixes
 * (`0.3.0-beta.1`) are not handled — current and latest are both expected
 * to be plain semver. If they are not, the comparison still produces a
 * consistent ordering, just not the semver-correct one.
 */
export async function checkUpdates(timeoutMs = 4000): Promise<UpdateInfo> {
  const url = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        current: VERSION,
        latest: null,
        newer: null,
        error: `npm registry returned HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { latest?: string };
    const latest = body.latest ?? null;
    if (!latest) {
      return {
        current: VERSION,
        latest: null,
        newer: null,
        error: 'registry response had no "latest" dist-tag',
      };
    }
    return { current: VERSION, latest, newer: isNewer(latest, VERSION) };
  } catch (err) {
    const reason =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `timed out after ${timeoutMs}ms`
          : err.message
        : String(err);
    return { current: VERSION, latest: null, newer: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

function isNewer(latest: string, current: string): boolean {
  const a = latest.split('.').map((s) => parseInt(s, 10) || 0);
  const b = current.split('.').map((s) => parseInt(s, 10) || 0);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

/** Plain-text formatter for the non-interactive `browser-link updates`. */
export function formatUpdate(info: UpdateInfo): string {
  if (info.error || info.latest === null) {
    return [
      `Current: ${info.current}`,
      `Could not check the registry: ${info.error ?? 'unknown error'}`,
    ].join('\n');
  }
  if (info.newer) {
    return [
      `Current: ${info.current}`,
      `Latest:  ${info.latest}`,
      `Update available. Run: npm install -g ${PACKAGE_NAME}@latest`,
    ].join('\n');
  }
  return [`Current: ${info.current}`, `Latest:  ${info.latest}`, `You are up to date.`].join('\n');
}
