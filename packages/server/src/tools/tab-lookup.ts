/**
 * The one answer to "what do I know about this tab" (url, title, build), for
 * both transports.
 *
 * Extension tabs live in the bridge's tab table (`listTabs`); cdp-direct tabs
 * are known to the cdp transport's target discovery (`listCdpTabs`, gated on
 * cdp-direct being enabled and granted, `[]` otherwise). Every consumer that
 * needs a tab's details (read and flow by name, map hints, the trail, the
 * learner, the session origins) asks here, so a `cdp:` tab behaves like an
 * extension tab (owner decision D7) instead of silently missing from a table
 * that only holds extension tabs.
 *
 * Takes the two existing injected ports, never the transports themselves, so
 * the dispatcher keeps depending on its deps only.
 */

import { isCdpTabId } from '../cdp/targets.js';
import type { BrowserToolDeps, TabSnapshot } from './browser-dispatch.js';

/** The ports a lookup reads: the extension tab table and cdp discovery. */
export type TabSource = Pick<BrowserToolDeps, 'listTabs' | 'listCdpTabs'>;

/** Tools whose transport calls cannot change the page, so a tab lookup made
 * before them is still true after them. `read` runs a kept reader, and
 * mutations are never readers (curation rule 3). */
const PAGE_PRESERVING_TOOLS: ReadonlySet<string> = new Set([
  'browser.read',
  'browser.snapshot',
  'browser.find',
  'browser.state',
  'browser.screenshot',
  'browser.wait_for',
  'browser.ping',
  'browser.flow_status',
]);

const CALL_MEMO = Symbol('tab-lookup.call-memo');

/**
 * The deps of ONE tool call, with cdp discovery memoized for that call: every
 * consumer of the call (read and flow by name before it runs; the known hint,
 * navigate's fallback, the trail, the learner and the session origin after)
 * shares one discovery instead of running its own. The memo is dropped when
 * the tool's own cdp transport call settles, unless `tool` cannot change the
 * page, so a lookup after a navigating call sees where it left the tab: at
 * most two discoveries per call, one only when nothing is looked up before
 * the call. Not a time cache: it dies with the call. A failed discovery is
 * memoized too, so the call pays for one bounded attempt per phase.
 * Idempotent: deps already wrapped for a call are returned as they are.
 */
export function withCallTabMemo<D extends TabSource & Pick<BrowserToolDeps, 'callCdpTool'>>(
  deps: D,
  tool: string,
): D {
  const discover = deps.listCdpTabs;
  if (!discover || CALL_MEMO in deps) return deps;
  let memo: Promise<TabSnapshot[]> | null = null;
  const listCdpTabs = (): Promise<TabSnapshot[]> => (memo ??= discover.call(deps));
  const call = deps.callCdpTool;
  const callCdpTool =
    call && !PAGE_PRESERVING_TOOLS.has(tool)
      ? async (...args: Parameters<typeof call>): Promise<unknown> => {
          try {
            return await call.apply(deps, args);
          } finally {
            memo = null;
          }
        }
      : call;
  return { ...deps, [CALL_MEMO]: true, listCdpTabs, ...(callCdpTool ? { callCdpTool } : {}) };
}

/** Every tab the agent can see: extension tabs first, then cdp-direct tabs. */
export async function listKnownTabs(source: TabSource): Promise<TabSnapshot[]> {
  const extensionTabs = source.listTabs();
  const cdpTabs = source.listCdpTabs ? await source.listCdpTabs() : [];
  return [...extensionTabs, ...cdpTabs];
}

function originOfUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The tabs a wrap-up looks at: every extension tab, plus cdp-direct tabs only
 * when the session may have used one. cdp discovery is two loopback HTTP
 * requests, so it runs only for an origin the session recorded that no
 * extension tab explains (the session records origins, not tab ids). A
 * discovery that rejects is not an error here: the wrap-up proceeds with the
 * extension tabs and the origins the session already recorded.
 */
export async function listTabsForSession(
  source: TabSource,
  sessionOrigins: ReadonlySet<string>,
): Promise<TabSnapshot[]> {
  const extensionTabs = source.listTabs();
  if (!source.listCdpTabs || sessionOrigins.size === 0) return extensionTabs;
  const explained = new Set(extensionTabs.map((t) => originOfUrl(t.url)));
  if ([...sessionOrigins].every((origin) => explained.has(origin))) return extensionTabs;
  try {
    return [...extensionTabs, ...(await source.listCdpTabs())];
  } catch {
    return extensionTabs;
  }
}

/**
 * The tab `tabId` names, from the transport it belongs to, or undefined when
 * that transport does not know it (closed, disconnected, cdp-direct off).
 * An extension id never reaches cdp discovery, so the extension path costs
 * what it always did.
 */
export async function findTab(source: TabSource, tabId: string): Promise<TabSnapshot | undefined> {
  if (!isCdpTabId(tabId)) return source.listTabs().find((t) => t.tab_id === tabId);
  if (!source.listCdpTabs) return undefined;
  return (await source.listCdpTabs()).find((t) => t.tab_id === tabId);
}
