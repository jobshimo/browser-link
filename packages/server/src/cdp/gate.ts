import { loadConfig } from '../config.js';
import { isGrantLive, loadGrant } from './grant.js';

export type CdpDirectGate = { ok: true } | { ok: false; error: string };

/** Exact wording agents receive when cdp-direct is off entirely. Agents get
 * this string and NOTHING else — there is no bypass, no partial access, no
 * alternate path to a `cdp:` tab while this check fails. */
export const CDP_DIRECT_DISABLED_ERROR =
  'cdp-direct is disabled. The user can enable it with: browser-link config set cdp-direct.enabled true';

/** Exact wording agents receive when cdp-direct is enabled but no live
 * grant exists (never granted, revoked, or expired). */
export const CDP_DIRECT_NO_GRANT_ERROR =
  'cdp-direct requires an active grant. Ask the user to run: browser-link cdp allow';

/**
 * The ONE gate every cdp-direct code path runs through, in the exact order
 * the feature's permission model requires: (1) is cdp-direct enabled at
 * all, (2) is there a live, unexpired grant. Re-evaluated on every call —
 * never cached — because either condition can flip mid-session (the user
 * disables the setting, or a time-boxed grant simply expires) and the very
 * next tool call must see that.
 *
 * Called from two places by design: `tools/browser-dispatch.ts`'s routing
 * layer (so an agent gets the exact error text above before any cdp-direct
 * code runs at all) AND `cdp/transport.ts` itself (defense in depth, so the
 * transport module is never safe to call without this check even if a
 * future caller reaches it directly). `cdp/targets.ts`'s `browser.list_tabs`
 * discovery also gates on this, but treats a failing gate as "show nothing"
 * rather than an error — an agent that has never heard of cdp-direct should
 * not see it mentioned in a routine list_tabs call.
 */
export function checkCdpDirectGate(now: number = Date.now()): CdpDirectGate {
  const cfg = loadConfig();
  if (cfg.cdpDirectEnabled !== true) return { ok: false, error: CDP_DIRECT_DISABLED_ERROR };
  if (!isGrantLive(loadGrant(), now)) return { ok: false, error: CDP_DIRECT_NO_GRANT_ERROR };
  return { ok: true };
}
