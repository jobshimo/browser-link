/**
 * Dispatcher for browser.* tools. Mirrors the shape of the map dispatcher
 * (`handleMapTool` / `isMapTool`) so both families look the same from
 * runServer().
 *
 * The handlers do not own state: they receive a `BrowserToolDeps` object
 * with the live tab map, the call function, and the claim registry. This
 * makes the dispatcher unit-testable with a fake `callBrowserTool` and a
 * fresh `TabClaimRegistry`.
 *
 * Each invocation also receives an `AgentCaller` so claim/ownership
 * decisions can be made per request. The bridge layers (primary's stdio
 * handler + IPC server) are responsible for supplying it.
 */

import { requireTabId } from './responses.js';
import type { BridgeEvent } from '../bridge/events.js';
import {
  formatClaimConflict,
  type AgentCaller,
  type TabClaim,
  type TabClaimRegistry,
} from './tab-claims.js';

export interface TabSnapshot {
  tab_id: string;
  url: string;
  title: string;
}

/** Public view of a TabClaim — what other agents and the user are allowed to see.
 * Keeps the wire payload stable even if the internal `TabClaim` grows fields. */
export interface PublicClaim {
  tab_id: string;
  agent_id: string;
  pid: number;
  binary: string;
  label?: string;
  claimed_at: number;
  last_activity_at: number;
  ttl_ms: number;
}

export interface EnrichedTabSnapshot extends TabSnapshot {
  claimed_by: PublicClaim | null;
  claimed_by_me: boolean;
}

export interface BrowserToolDeps {
  listTabs(): TabSnapshot[];
  callBrowserTool(
    tabId: string,
    tool: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown>;
  /** Optional event-log accessor — when present, `browser.events` returns
   * its slice. When absent (e.g. in unit tests), the tool returns []. */
  recentEvents?(opts: { sinceId?: number; limit?: number }): BridgeEvent[];
  /** Claim registry. Optional so existing test fixtures keep compiling — when
   * absent the dispatcher behaves as before (no enforcement, list_tabs
   * returns claimed_by:null for every tab). */
  tabClaims?: TabClaimRegistry;
}

/** Closed set of browser tool names. Used both as the discriminant in
 * `handleBrowserTool`'s switch and as the allowlist behind `isBrowserTool`,
 * so adding a tool requires touching one place. The literal-union type lets
 * TypeScript prove the switch is exhaustive at compile time. */
const BROWSER_TOOL_NAMES = [
  'browser.list_tabs',
  'browser.claim_tab',
  'browser.release_tab',
  'browser.my_tabs',
  'browser.ping',
  'browser.navigate',
  'browser.snapshot',
  'browser.console',
  'browser.network',
  'browser.network_body',
  'browser.click',
  'browser.type',
  'browser.evaluate',
  'browser.events',
] as const;
type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];
const BROWSER_TOOL_NAME_SET: ReadonlySet<string> = new Set(BROWSER_TOOL_NAMES);

export function isBrowserTool(name: string): boolean {
  return BROWSER_TOOL_NAME_SET.has(name);
}

const NAVIGATE_TIMEOUT_MS = 30_000;

/** Convert an internal TabClaim into the wire-safe `PublicClaim`. */
function toPublicClaim(claim: TabClaim): PublicClaim {
  const publicClaim: PublicClaim = {
    tab_id: claim.tab_id,
    agent_id: claim.agent_id,
    pid: claim.pid,
    binary: claim.binary,
    claimed_at: claim.claimed_at,
    last_activity_at: claim.last_activity_at,
    ttl_ms: claim.ttl_ms,
  };
  if (claim.label !== undefined) publicClaim.label = claim.label;
  return publicClaim;
}

/** Run an action through the claim registry. Returns the response payload of
 * the action when the agent is allowed, or throws a descriptive Error otherwise.
 * When no registry is wired (test fixtures, or future configs that disable
 * coordination), behaves like the pre-claim dispatcher. */
async function runAction(
  tool: string,
  tabId: string,
  params: unknown,
  deps: BrowserToolDeps,
  caller: AgentCaller,
  timeoutMs?: number,
): Promise<unknown> {
  if (deps.tabClaims) {
    const outcome = deps.tabClaims.ensureActionAllowed(tabId, caller);
    if (!outcome.ok) {
      throw new Error(formatClaimConflict(caller, outcome.existing));
    }
  }
  // Preserve the pre-claim call shape — only forward timeoutMs when set so
  // existing assertions and the bridge's default behaviour stay unchanged.
  return timeoutMs !== undefined
    ? deps.callBrowserTool(tabId, tool, params, timeoutMs)
    : deps.callBrowserTool(tabId, tool, params);
}

function handleListTabs(deps: BrowserToolDeps, caller: AgentCaller): EnrichedTabSnapshot[] {
  return deps.listTabs().map((t) => {
    const claim = deps.tabClaims?.getClaim(t.tab_id) ?? null;
    return {
      ...t,
      claimed_by: claim ? toPublicClaim(claim) : null,
      claimed_by_me: claim ? claim.agent_id === caller.agent_id : false,
    } satisfies EnrichedTabSnapshot;
  });
}

function handleClaimTab(args: unknown, deps: BrowserToolDeps, caller: AgentCaller): unknown {
  const { tab_id, ttl_minutes, label } = (args ?? {}) as {
    tab_id?: string;
    ttl_minutes?: number;
    label?: string;
  };
  if (!tab_id) throw new Error('tab_id required');
  if (!deps.tabClaims) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Tab coordination is disabled in this build of browser-link.',
    };
  }
  const outcome = deps.tabClaims.claim(tab_id, caller, { ttlMinutes: ttl_minutes, label });
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason, existing: toPublicClaim(outcome.existing) };
  }
  return { ok: true, created: outcome.created, claim: toPublicClaim(outcome.claim) };
}

function handleReleaseTab(args: unknown, deps: BrowserToolDeps, caller: AgentCaller): unknown {
  const tab_id = requireTabId(args);
  if (!deps.tabClaims) return { ok: true };
  const result = deps.tabClaims.release(tab_id, caller);
  if (result.ok) return { ok: true };
  const payload: {
    ok: false;
    reason: 'not-owner' | 'not-claimed';
    existing?: PublicClaim;
  } = { ok: false, reason: result.reason };
  if (result.existing) payload.existing = toPublicClaim(result.existing);
  return payload;
}

function handleMyTabs(deps: BrowserToolDeps, caller: AgentCaller): { claims: PublicClaim[] } {
  if (!deps.tabClaims) return { claims: [] };
  return { claims: deps.tabClaims.myTabs(caller).map(toPublicClaim) };
}

function handleEvents(
  args: unknown,
  deps: BrowserToolDeps,
): { events: BridgeEvent[]; latest_id: number } {
  const { since_id, limit } = (args as { since_id?: number; limit?: number }) ?? {};
  if (!deps.recentEvents) return { events: [], latest_id: 0 };
  const events = deps.recentEvents({ sinceId: since_id, limit });
  const latest_id = events.length > 0 ? events[events.length - 1]!.id : (since_id ?? 0);
  return { events, latest_id };
}

/**
 * Dispatch a browser tool call.
 *
 * The switch is intentional: every reachable arm is matched against the
 * closed `BrowserToolName` literal union, so the `name` string can only
 * reach a known handler (or fall through to the `default` throw). This
 * pattern is what CodeQL's `js/unvalidated-dynamic-method-call` accepts as
 * a fixed allowlist — a Map-of-handlers lookup looks identical at runtime
 * but is flagged because the static analyser can't prove the bound.
 */
export async function handleBrowserTool(
  name: string,
  args: unknown,
  deps: BrowserToolDeps,
  caller: AgentCaller,
): Promise<unknown> {
  if (!isBrowserTool(name)) throw new Error(`Unknown browser tool: ${name}`);
  const toolName = name as BrowserToolName;
  switch (toolName) {
    case 'browser.list_tabs':
      return handleListTabs(deps, caller);
    case 'browser.claim_tab':
      return handleClaimTab(args, deps, caller);
    case 'browser.release_tab':
      return handleReleaseTab(args, deps, caller);
    case 'browser.my_tabs':
      return handleMyTabs(deps, caller);
    case 'browser.ping':
      return deps.callBrowserTool(requireTabId(args), 'ping', {});
    case 'browser.navigate': {
      const { url, wait_for_load = true } = args as { url: string; wait_for_load?: boolean };
      return runAction(
        'navigate',
        requireTabId(args),
        { url, wait_for_load },
        deps,
        caller,
        NAVIGATE_TIMEOUT_MS,
      );
    }
    case 'browser.snapshot':
      return deps.callBrowserTool(requireTabId(args), 'snapshot', {});
    case 'browser.console': {
      const { level } = (args as { level?: string }) ?? {};
      return deps.callBrowserTool(requireTabId(args), 'console', { level });
    }
    case 'browser.network': {
      const { url_filter } = (args as { url_filter?: string }) ?? {};
      return deps.callBrowserTool(requireTabId(args), 'network', { url_filter });
    }
    case 'browser.network_body': {
      const { request_id } = args as { request_id: string };
      return deps.callBrowserTool(requireTabId(args), 'network_body', { request_id });
    }
    case 'browser.click': {
      const { selector } = args as { selector: string };
      return runAction('click', requireTabId(args), { selector }, deps, caller);
    }
    case 'browser.type': {
      const {
        selector,
        text,
        clear = false,
      } = args as { selector: string; text: string; clear?: boolean };
      return runAction('type', requireTabId(args), { selector, text, clear }, deps, caller);
    }
    case 'browser.evaluate': {
      const { expression } = args as { expression: string };
      return runAction('evaluate', requireTabId(args), { expression }, deps, caller);
    }
    case 'browser.events':
      return handleEvents(args, deps);
    default: {
      // The earlier `isBrowserTool(name)` check makes this branch unreachable
      // for any value within `BrowserToolName`. The exhaustive cast surfaces a
      // compile error if a future tool name is added to the union but missed
      // here.
      const _exhaustive: never = toolName;
      throw new Error(`Unhandled browser tool: ${String(_exhaustive)}`);
    }
  }
}
