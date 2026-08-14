import { loadConfig, sanitizeCdpPort } from '../config.js';
import { checkCdpDirectGate } from './gate.js';

/** The only host cdp-direct ever talks to. Never configurable. */
const LOOPBACK_HOST = '127.0.0.1';

/**
 * Build a loopback discovery URL for `rawPort` + `path`, or `null` when the
 * result would not be a loopback HTTP URL. Two barriers, both in the data
 * flow before any `fetch`: (1) `sanitizeCdpPort` reduces the untrusted port
 * to a validated integer, so a config.json string like `"9222@attacker.com"`
 * can never survive into the URL; (2) the constructed URL's host is asserted
 * `=== 127.0.0.1` — defense in depth, so even a port value that somehow
 * slipped validation cannot produce an off-host request. A non-loopback (or
 * unparseable) result is treated as "no endpoint" by the callers. */
function loopbackHttpUrl(rawPort: unknown, path: string): string | null {
  const port = sanitizeCdpPort(rawPort);
  let url: URL;
  try {
    url = new URL(`http://${LOOPBACK_HOST}:${port}${path}`);
  } catch {
    return null;
  }
  if (url.hostname !== LOOPBACK_HOST) return null;
  return url.href;
}

export interface CdpTargetTab {
  tab_id: string;
  url: string;
  title: string;
  transport: 'cdp';
}

/** Shape of one entry from Chrome's `/json/list` — untrusted external JSON
 * cast at the HTTP boundary, so every field is optional here even though a
 * well-behaved Chrome always sends all of them. `isRealPageTarget` and the
 * `title ?? ''` fallback below are what actually guard against a missing
 * field at runtime. */
interface RawCdpTarget {
  id?: string;
  type?: string;
  url?: string;
  title?: string;
}

interface CdpVersionInfo {
  Browser?: string;
}

/** Short timeout on every discovery HTTP call — this runs on the hot
 * `browser.list_tabs` path, so a Chrome that is not actually listening on
 * the configured port must fail fast, not stall the tool call. */
const DISCOVERY_TIMEOUT_MS = 1_000;

function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * Verify the endpoint at `port` is really a Chrome/Chromium-family
 * DevTools endpoint before trusting anything else it returns — a random
 * local service that happens to be listening on the configured port must
 * never be treated as a browser target list. Mirrors the WS bridge's own
 * "verify the peer before trusting it" posture (`auth/allowlist.ts`), just
 * over HTTP instead of a kernel-level PID lookup.
 */
export async function isChromeDevtoolsEndpoint(port: number): Promise<boolean> {
  const url = loopbackHttpUrl(port, '/json/version');
  if (!url) return false;
  const { signal, cancel } = withTimeout(DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return false;
    const info = (await res.json()) as CdpVersionInfo;
    // "Chrome/123.0.0.0", "HeadlessChrome/...", "Edg/122...", etc. — every
    // Chromium-family browser's Browser string contains "Chrome".
    return typeof info.Browser === 'string' && info.Browser.includes('Chrome');
  } catch {
    return false;
  } finally {
    cancel();
  }
}

/**
 * The core "is this a real, drivable page target" predicate, shared by
 * discovery (`isRealPageTarget` below, feeding `list_tabs`) AND by
 * `cdp/transport.ts`'s connect-time re-validation. Keeping ONE
 * implementation matters: discovery filters devtools/extension targets for
 * DISPLAY, but the transport connects by a caller-supplied `cdp:<targetId>`
 * that need not have come from a `list_tabs` this process produced — so the
 * transport must re-run the same check against `Target.getTargetInfo` on
 * connect, never trusting the id's provenance. A drift between the two
 * checks would let a devtools/extension surface be driven through the
 * connect path while hidden from the list.
 */
export function isDrivablePageTarget(type: string | undefined, url: string | undefined): boolean {
  if (type !== 'page') return false;
  if (typeof url !== 'string') return false;
  if (url.startsWith('devtools://')) return false;
  if (url.startsWith('chrome-extension://')) return false;
  return true;
}

/** A "page" target that is not Chrome's own DevTools UI or an extension
 * page. Agents have no legitimate reason to drive those, and they are not
 * "a Chrome tab" in the sense the rest of browser-link means. A type
 * predicate (not a plain boolean) so the `.filter()` call site below
 * narrows `id`/`url` to `string` for the following `.map()` — the fields
 * this function actually validated, not a blind cast. */
function isRealPageTarget(t: RawCdpTarget): t is RawCdpTarget & { id: string; url: string } {
  if (typeof t.id !== 'string' || t.id.length === 0) return false;
  return isDrivablePageTarget(t.type, t.url);
}

async function fetchTargets(port: number): Promise<RawCdpTarget[]> {
  const url = loopbackHttpUrl(port, '/json/list');
  if (!url) return [];
  const { signal, cancel } = withTimeout(DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return [];
    const list = (await res.json()) as unknown;
    return Array.isArray(list) ? (list as RawCdpTarget[]) : [];
  } catch {
    return [];
  } finally {
    cancel();
  }
}

/**
 * Discover cdp-direct page targets for `browser.list_tabs`. Gated on
 * `checkCdpDirectGate()` FIRST — when cdp-direct is disabled or has no live
 * grant, this returns `[]` immediately without ever touching the network,
 * exactly like an extension-only install that has never heard of
 * cdp-direct. Every other failure (Chrome not running on the configured
 * port, a non-Chrome service, a network hiccup) also degrades to `[]` —
 * list_tabs must never fail or slow down because of cdp-direct trouble.
 */
export async function listCdpTargets(): Promise<CdpTargetTab[]> {
  const gate = checkCdpDirectGate();
  if (!gate.ok) return [];
  const cfg = loadConfig();
  const port = sanitizeCdpPort(cfg.cdpDirectPort);
  const isChrome = await isChromeDevtoolsEndpoint(port);
  if (!isChrome) return [];
  const targets = await fetchTargets(port);
  return targets.filter(isRealPageTarget).map((t) => ({
    tab_id: `cdp:${t.id}`,
    url: t.url,
    title: t.title ?? '',
    transport: 'cdp' as const,
  }));
}

/** Prefix every cdp-direct tab_id carries, so the rest of the server can
 * route by a single string check. */
export const CDP_TAB_ID_PREFIX = 'cdp:';

export function isCdpTabId(tabId: string): boolean {
  return tabId.startsWith(CDP_TAB_ID_PREFIX);
}

/** Recover the raw CDP target id from a `cdp:<targetId>` tab_id, or `null`
 * when `tabId` is not a cdp-direct id, or is one with an empty target id
 * (`"cdp:"`, malformed). */
export function cdpTargetIdFromTabId(tabId: string): string | null {
  if (!isCdpTabId(tabId)) return null;
  const id = tabId.slice(CDP_TAB_ID_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** Chrome's standard per-target DevTools WebSocket URL shape — the exact
 * same URL `/json/list`'s `webSocketDebuggerUrl` field carries, derived
 * directly from the port + target id instead of a second HTTP round trip.
 * The port is re-sanitized here too (defense in depth) so this exported
 * helper is safe regardless of caller; `targetId` sits in the URL PATH,
 * after the host, so it cannot alter the host. `transport.ts` additionally
 * asserts the built URL's host is loopback before connecting. */
export function buildTargetWsUrl(port: number, targetId: string): string {
  return `ws://${LOOPBACK_HOST}:${sanitizeCdpPort(port)}/devtools/page/${targetId}`;
}
