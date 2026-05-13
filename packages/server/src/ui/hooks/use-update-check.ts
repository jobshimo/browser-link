import { useEffect, useState } from 'react';
import { checkForUpdates } from '../../commands/update-check.js';

/**
 * React hook that runs a background update check on mount and again every
 * six hours while the TUI is open. The lookup is silent on failure — when
 * the npm registry is unreachable the hook simply returns null, which the
 * banner consumer interprets as "no banner".
 *
 * The 6h cadence matches the on-disk cache TTL in `commands/update-check`
 * so the cheap path (cache hit) is the one that actually fires within a
 * single TUI session.
 *
 * A test seam (`runCheck`) lets the unit suite inject a synthetic check
 * function — see `use-update-check.test.tsx`. Production callers should
 * leave it undefined.
 */

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export interface UpdateCheckState {
  /** Latest version on the npm registry, or null when we have not been
   * able to fetch it (offline, registry down, first-call still in flight). */
  latest: string | null;
  /** True only when latest > current. The banner consumer renders only
   * when this is true, so failures collapse to "no banner". */
  isNewer: boolean;
}

interface HookOptions {
  /** Override the underlying check call. Tests inject a stub here. */
  runCheck?: () => Promise<UpdateCheckState>;
  /** Override the interval. Tests pass a tiny value to fast-forward. */
  intervalMs?: number;
}

export function useBackgroundUpdateCheck(opts: HookOptions = {}): UpdateCheckState {
  const { runCheck, intervalMs = SIX_HOURS_MS } = opts;
  const [state, setState] = useState<UpdateCheckState>({ latest: null, isNewer: false });

  useEffect(() => {
    let cancelled = false;
    const doCheck = async (): Promise<void> => {
      try {
        const next = runCheck
          ? await runCheck()
          : await checkForUpdates().then((r) => ({ latest: r.latest, isNewer: r.isNewer }));
        if (!cancelled) setState(next);
      } catch {
        // Passive banner — failure is silent. Leave the previous state in
        // place (so a stale-but-still-useful "update available" survives
        // a transient network hiccup).
      }
    };
    void doCheck();
    const timer = setInterval(() => {
      void doCheck();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runCheck, intervalMs]);

  return state;
}
