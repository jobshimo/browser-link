function handleReset(
  deps: BrowserToolDeps,
):
  | { ok: true; dropped_tabs: number; released_claims: number; cleared_events: number }
  | { ok: false; reason: string } {
  if (!deps.resetBridge) {
    return { ok: false, reason: 'reset-not-supported' };
  }
  const result = deps.resetBridge();
  return { ok: true, ...result };
}

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
import type { BridgeEvent, BridgeEventListener, SubscribeOptions } from '../bridge/events.js';
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
  /** Optional push-based event subscription. When present, `wait_for_tab`
   * registers a listener via this hook instead of polling `recentEvents`.
   * `replayWithinMs` in the options lets the listener also receive the
   * last N ms of recent events, which solves the agent-races-its-own-action
   * case (the action fires the `tab-created` event before wait_for_tab
   * finishes registering). The returned function MUST be called to
   * unsubscribe — on match, on timeout, on error. */
  subscribeEvents?: (fn: BridgeEventListener, options?: SubscribeOptions) => () => void;
  /** Claim registry. Optional so existing test fixtures keep compiling — when
   * absent the dispatcher behaves as before (no enforcement, list_tabs
   * returns claimed_by:null for every tab). */
  tabClaims?: TabClaimRegistry;
  /** Soft-reset entry point for `browser.reset`. Drops every connected tab
   * session, releases every claim, clears the event log — without killing
   * the MCP server. Optional so unit tests can omit it. */
  resetBridge?(): { dropped_tabs: number; released_claims: number; cleared_events: number };
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
  'browser.find',
  'browser.state',
  'browser.canvas_screenshot',
  'browser.console',
  'browser.network',
  'browser.network_body',
  'browser.click',
  'browser.type',
  'browser.press',
  'browser.drag',
  'browser.flow',
  'browser.evaluate',
  'browser.events',
  'browser.reset',
  'browser.wait_for',
  'browser.wait_for_tab',
  'browser.dialog_respond',
  'browser.set_permission',
] as const;
type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];
const BROWSER_TOOL_NAME_SET: ReadonlySet<string> = new Set(BROWSER_TOOL_NAMES);

export function isBrowserTool(name: string): boolean {
  return BROWSER_TOOL_NAME_SET.has(name);
}

const NAVIGATE_TIMEOUT_MS = 30_000;

/** Same floor click/type/drag/wait_for already use. Action tools default
 * here when they have no other reason to run longer. */
const ACTION_TIMEOUT_FLOOR_MS = 15_000;
/** Hard ceiling on `settle_timeout_ms` — mirrors MAX_SETTLE_TIMEOUT_MS in
 * the extension's background.ts; kept in sync manually since the two
 * packages don't share a module for this one constant. */
const MAX_SETTLE_TIMEOUT_MS = 10_000;
/** Matches the extension's DEFAULT_SETTLE_TIMEOUT_MS. */
const DEFAULT_SETTLE_TIMEOUT_MS = 2_000;

const PRESS_MODIFIERS = new Set(['Alt', 'Control', 'Meta', 'Shift']);

/** Roles `browser.find` accepts — shared by the standalone find dispatcher
 * and `browser.flow`'s find-step validation so the two cannot drift. */
const FIND_ALLOWED_ROLES = new Set(['button', 'link', 'textbox', 'checkbox', 'tab', 'menuitem']);

/** Type-predicate narrowing for `browser.press`'s `modifiers` param.
 * `Array.isArray` alone narrows `unknown` to `any[]`, not `unknown[]` —
 * without a named predicate here, `.every(...)` after it does not narrow
 * the element type and the eventual assignment to `string[]` trips
 * `no-unsafe-assignment`. */
function isModifierArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((m) => typeof m === 'string' && PRESS_MODIFIERS.has(m))
  );
}

/**
 * Timeout budget for click / type / press: the bridge has to wait out the
 * action itself PLUS however long the optional settle wait can run for.
 * Mirrors how `browser.drag` computes its budget from `duration_ms` and
 * `browser.wait_for` computes its budget from `timeout_ms` — same
 * `Math.max(floor, requested + overhead)` shape, this time keyed off
 * `settle_timeout_ms`. Unset/invalid input falls back to the default settle
 * timeout, so the returned value is always >= ACTION_TIMEOUT_FLOOR_MS
 * regardless of what the caller passed.
 *
 * INVARIANT WORTH STATING PLAINLY: with today's constants this function
 * always returns exactly ACTION_TIMEOUT_FLOOR_MS (15s), because the worst
 * legal case is MAX_SETTLE_TIMEOUT_MS + 5s overhead = 10s + 5s = the floor.
 * It does not currently "widen" anything — it EXISTS so the budget stays
 * correct by construction if either constant moves. If you change
 * MAX_SETTLE_TIMEOUT_MS or the floor, either keep
 * `ACTION_TIMEOUT_FLOOR_MS >= MAX_SETTLE_TIMEOUT_MS + 5_000` or accept
 * that this function starts returning larger budgets — both are fine,
 * a settle wait silently outliving the bridge timeout is not.
 */
function actionTimeoutWithSettle(settleTimeoutMs: unknown): number {
  const requested =
    typeof settleTimeoutMs === 'number' && Number.isFinite(settleTimeoutMs) && settleTimeoutMs >= 0
      ? settleTimeoutMs
      : DEFAULT_SETTLE_TIMEOUT_MS;
  const clamped = Math.min(requested, MAX_SETTLE_TIMEOUT_MS);
  return Math.max(ACTION_TIMEOUT_FLOOR_MS, clamped + 5_000);
}

// === browser.flow ========================================================

/** Hard cap on steps per flow — mirrors `maxItems: 20` on the MCP schema
 * (`browser-definitions.ts`) and the extension's own defense-in-depth
 * check in `flow.ts`'s `runFlow`. Enforced here too so an oversized flow
 * is rejected before it ever reaches the extension. */
const MAX_FLOW_STEPS = 20;
/** Same ceiling `browser.wait_for_tab` uses for its own timeout budget —
 * the bridge does not park any single tool call longer than this. A flow
 * whose TRUTHFUL worst-case budget exceeds this ceiling is REJECTED up
 * front (see `validateFlowSteps`), never silently capped: the bridge has
 * no cancel path to the extension, so a bridge timeout below the real
 * worst case would drop the response of a flow that is still executing —
 * and an agent retry could then duplicate the actions. */
const MAX_FLOW_TIMEOUT_MS = 60_000;
/** Once-per-flow overhead: the WS round trip to the extension plus the
 * recovery snapshot evaluated on the failure path. */
const FLOW_BASE_OVERHEAD_MS = 2_000;
/** Per-step overhead: the step's own in-page evaluate round trip(s) and
 * CDP input dispatches. Those are local calls that typically take tens of
 * milliseconds — 500ms per step is generous without inflating the budget
 * so much that legitimate 20-step flows stop fitting under the ceiling. */
const FLOW_STEP_SLACK_MS = 500;
/** Worst-case settle wait for one settle-enabled click/type/press step
 * inside a flow. Flow steps only expose `settle_ms` (the quiet-PERIOD
 * length), never `settle_timeout_ms` (the overall CAP) — so every
 * settle-enabled action step's true upper bound is the extension's
 * `DEFAULT_SETTLE_TIMEOUT_MS`. A step that explicitly disables settle
 * (`settle_ms: 0`) skips the wait entirely and costs only the slack.
 *
 * Sanity check the constants keep the documented promise: a full 20-step
 * flow of action steps with DEFAULT settle budgets at
 * 2_000 + 20 * (2_000 + 500) = 52_000ms — comfortably under the 60s
 * ceiling. Only genuinely long wait_for-heavy flows hit the rejection. */
const FLOW_ACTION_SETTLE_WORST_MS = DEFAULT_SETTLE_TIMEOUT_MS;
/** Mirror the standalone wait_for contract: default 5s, extension clamps
 * at 30s. The budget uses the same numbers so it never under-models a
 * step the extension would happily run longer. */
const FLOW_WAIT_FOR_DEFAULT_TIMEOUT_MS = 5_000;
const FLOW_WAIT_FOR_MAX_TIMEOUT_MS = 30_000;

const FLOW_STEP_KINDS = ['find', 'click', 'type', 'press', 'wait_for'] as const;
type FlowStepKind = (typeof FLOW_STEP_KINDS)[number];

const FLOW_WAIT_CONDITIONS = new Set(['visible', 'hidden', 'attached', 'detached']);

/** Identify the step kind. A step must have EXACTLY ONE key and that key
 * must be a recognized kind — extra keys (`{find: {...}, mystery: 1}`)
 * reject, matching the schema's `additionalProperties: false`. */
function flowStepKind(step: Record<string, unknown>): FlowStepKind | null {
  const keys = Object.keys(step);
  if (keys.length !== 1) return null;
  const key = keys[0];
  return (FLOW_STEP_KINDS as readonly string[]).includes(key) ? (key as FlowStepKind) : null;
}

export type FlowValidationResult =
  | { ok: true; steps: Record<string, unknown>[]; budgetMs: number }
  | { ok: false; error: string };

/**
 * Server-side validation for `browser.flow`'s `steps` array — defense in
 * depth beyond the MCP JSON schema, since the IPC/proxy path in
 * multi-agent mode can reach `handleBrowserTool` without ever going
 * through schema validation. Mirrors how `browser.find`/`browser.press`
 * re-validate their own required fields here rather than trusting the
 * schema alone.
 *
 * Also computes the flow's TRUTHFUL worst-case time budget (`budgetMs`)
 * in the same pass: base overhead + per-step slack + each wait_for's
 * clamped `timeout_ms` + each settle-enabled action step's settle
 * ceiling. A flow whose budget exceeds `MAX_FLOW_TIMEOUT_MS` is rejected
 * with an actionable error instead of silently capping the enforced
 * bridge timeout below the modeled need — see the ceiling constant's doc
 * for why a mid-flow bridge timeout is worse than an up-front rejection.
 *
 * Deliberately loose on the "implicit target" check: it only confirms a
 * `find` step exists SOMEWHERE earlier in the array before a selector-less
 * `click` — it does not simulate the single-step-lookahead consumption
 * rule `runFlow` enforces at runtime. A flow that passes this check can
 * still fail at runtime with a clear per-step error; this check only
 * catches the flows that could never possibly work.
 *
 * Exported so `map/tools.ts` can validate `browser.map.save`'s optional
 * `flows` recipes with the EXACT same rules `browser.flow` itself enforces
 * — a steps array `browser.flow` would reject must be rejected here too,
 * never a second, slightly-different copy of this logic.
 */
export function validateFlowSteps(input: unknown): FlowValidationResult {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: 'steps must be a non-empty array' };
  }
  if (input.length > MAX_FLOW_STEPS) {
    return { ok: false, error: `at most ${MAX_FLOW_STEPS} steps allowed, got ${input.length}` };
  }
  const steps: Record<string, unknown>[] = [];
  let hasTarget = false;
  let budgetMs = FLOW_BASE_OVERHEAD_MS;
  for (let i = 0; i < input.length; i++) {
    const raw: unknown = input[i];
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: `step ${i}: must be an object` };
    }
    const step = raw as Record<string, unknown>;
    const kind = flowStepKind(step);
    if (!kind) {
      return {
        ok: false,
        error: `step ${i}: must have exactly one of find | click | type | press | wait_for`,
      };
    }
    const body = step[kind];
    if (typeof body !== 'object' || body === null) {
      return { ok: false, error: `step ${i}: "${kind}" must be an object` };
    }
    const bodyRecord = body as Record<string, unknown>;
    if (kind === 'find') {
      if (typeof bodyRecord.text !== 'string' || bodyRecord.text.length === 0) {
        return { ok: false, error: `step ${i}: find.text is required` };
      }
      if (
        bodyRecord.role !== undefined &&
        (typeof bodyRecord.role !== 'string' || !FIND_ALLOWED_ROLES.has(bodyRecord.role))
      ) {
        return {
          ok: false,
          error: `step ${i}: find.role must be one of button | link | textbox | checkbox | tab | menuitem`,
        };
      }
      hasTarget = true;
      budgetMs += FLOW_STEP_SLACK_MS;
    } else if (kind === 'type') {
      if (typeof bodyRecord.text !== 'string') {
        return { ok: false, error: `step ${i}: type.text is required` };
      }
      budgetMs += flowActionBudgetMs(bodyRecord);
    } else if (kind === 'press') {
      if (typeof bodyRecord.key !== 'string' || bodyRecord.key.length === 0) {
        return { ok: false, error: `step ${i}: press.key is required` };
      }
      budgetMs += flowActionBudgetMs(bodyRecord);
    } else if (kind === 'click') {
      if (bodyRecord.selector === undefined && !hasTarget) {
        return {
          ok: false,
          error: `step ${i}: click has no selector and no preceding find to supply an implicit target`,
        };
      }
      budgetMs += flowActionBudgetMs(bodyRecord);
    } else {
      // wait_for — mirror the standalone dispatcher's contract checks so a
      // bad step fails HERE with a clear message instead of in-page with a
      // misleading "condition not met within timeout (0ms, 0 checks)".
      const modes = [bodyRecord.selector, bodyRecord.expression, bodyRecord.network_url].filter(
        (v) => v !== undefined,
      );
      if (modes.length !== 1) {
        return {
          ok: false,
          error: `step ${i}: wait_for requires exactly one of selector | expression | network_url`,
        };
      }
      for (const key of ['selector', 'expression', 'network_url'] as const) {
        if (bodyRecord[key] !== undefined && typeof bodyRecord[key] !== 'string') {
          return { ok: false, error: `step ${i}: wait_for.${key} must be a string` };
        }
      }
      if (
        bodyRecord.condition !== undefined &&
        (typeof bodyRecord.condition !== 'string' ||
          !FLOW_WAIT_CONDITIONS.has(bodyRecord.condition))
      ) {
        return {
          ok: false,
          error: `step ${i}: wait_for.condition must be one of visible | hidden | attached | detached`,
        };
      }
      for (const key of ['timeout_ms', 'poll_interval_ms'] as const) {
        if (
          bodyRecord[key] !== undefined &&
          (typeof bodyRecord[key] !== 'number' || !Number.isFinite(bodyRecord[key]))
        ) {
          return { ok: false, error: `step ${i}: wait_for.${key} must be a finite number` };
        }
      }
      budgetMs += flowWaitForBudgetMs(bodyRecord);
    }
    steps.push(step);
  }
  if (budgetMs > MAX_FLOW_TIMEOUT_MS) {
    return {
      ok: false,
      error:
        `flow worst-case budget ${Math.ceil(budgetMs / 1000)}s exceeds the ` +
        `${MAX_FLOW_TIMEOUT_MS / 1000}s ceiling — reduce wait_for timeout_ms values or split the flow`,
    };
  }
  return { ok: true, steps, budgetMs };
}

/** Worst case for one click/type/press step: its settle ceiling (unless
 * the step explicitly disables settle with `settle_ms: 0`) plus the
 * per-step slack. */
function flowActionBudgetMs(body: Record<string, unknown>): number {
  const settleDisabled = body.settle_ms === 0;
  return (settleDisabled ? 0 : FLOW_ACTION_SETTLE_WORST_MS) + FLOW_STEP_SLACK_MS;
}

/** Worst case for one wait_for step: its clamped `timeout_ms` (the
 * extension enforces the same 30s cap) plus the per-step slack. */
function flowWaitForBudgetMs(body: Record<string, unknown>): number {
  const requested =
    typeof body.timeout_ms === 'number' && Number.isFinite(body.timeout_ms) && body.timeout_ms >= 0
      ? body.timeout_ms
      : FLOW_WAIT_FOR_DEFAULT_TIMEOUT_MS;
  return Math.min(requested, FLOW_WAIT_FOR_MAX_TIMEOUT_MS) + FLOW_STEP_SLACK_MS;
}

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
  const { since_id, limit } = (args ?? {}) as { since_id?: number; limit?: number };
  if (!deps.recentEvents) return { events: [], latest_id: 0 };
  const events = deps.recentEvents({ sinceId: since_id, limit });
  const latest_id = events.length > 0 ? events[events.length - 1].id : (since_id ?? 0);
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
    case 'browser.snapshot': {
      const { within_selector, only_interactive, exclude, max_interactive } = (args ?? {}) as {
        within_selector?: string;
        only_interactive?: boolean;
        exclude?: unknown;
        max_interactive?: number;
      };
      const filterExclude = Array.isArray(exclude)
        ? exclude.filter((v): v is string => typeof v === 'string')
        : undefined;
      return deps.callBrowserTool(requireTabId(args), 'snapshot', {
        within_selector,
        only_interactive,
        exclude: filterExclude,
        max_interactive,
      });
    }
    case 'browser.find': {
      const { text, role, exact } = (args ?? {}) as {
        text?: unknown;
        role?: unknown;
        exact?: unknown;
      };
      if (typeof text !== 'string' || text.length === 0) {
        throw new Error('browser.find: text required');
      }
      if (role !== undefined && (typeof role !== 'string' || !FIND_ALLOWED_ROLES.has(role))) {
        throw new Error(
          'browser.find: role must be one of button | link | textbox | checkbox | tab | menuitem',
        );
      }
      // find is a read tool: no claim enforcement, no userGesture concerns.
      return deps.callBrowserTool(requireTabId(args), 'find', {
        text,
        role,
        exact: exact === true,
      });
    }
    case 'browser.state':
      // state is a read tool, same bucket as find/snapshot: no claim
      // enforcement, no params beyond tab_id.
      return deps.callBrowserTool(requireTabId(args), 'state', {});
    case 'browser.canvas_screenshot': {
      const { selector, region, format } = (args ?? {}) as {
        selector?: unknown;
        region?: unknown;
        format?: unknown;
      };
      if (selector !== undefined && typeof selector !== 'string') {
        throw new Error('browser.canvas_screenshot: selector must be a string when provided');
      }
      let normalizedRegion: { x: number; y: number; w: number; h: number } | undefined;
      if (region !== undefined) {
        if (typeof region !== 'object' || region === null) {
          throw new Error('browser.canvas_screenshot: region must be an object {x,y,w,h}');
        }
        const r = region as Record<string, unknown>;
        for (const key of ['x', 'y', 'w', 'h']) {
          if (typeof r[key] !== 'number' || !Number.isFinite(r[key])) {
            throw new Error(`browser.canvas_screenshot: region.${key} must be a finite number`);
          }
        }
        if ((r.w as number) <= 0 || (r.h as number) <= 0) {
          throw new Error('browser.canvas_screenshot: region.w and region.h must be > 0');
        }
        normalizedRegion = {
          x: r.x as number,
          y: r.y as number,
          w: r.w as number,
          h: r.h as number,
        };
      }
      if (format !== undefined && format !== 'png' && format !== 'jpeg') {
        throw new Error('browser.canvas_screenshot: format must be "png" or "jpeg"');
      }
      // canvas_screenshot is a read tool — multiple agents can inspect the
      // same canvas in parallel. No claim enforcement.
      return deps.callBrowserTool(requireTabId(args), 'canvas_screenshot', {
        selector,
        region: normalizedRegion,
        format,
      });
    }
    case 'browser.console': {
      const { level } = (args ?? {}) as { level?: string };
      return deps.callBrowserTool(requireTabId(args), 'console', { level });
    }
    case 'browser.network': {
      const { url_filter } = (args ?? {}) as { url_filter?: string };
      return deps.callBrowserTool(requireTabId(args), 'network', { url_filter });
    }
    case 'browser.network_body': {
      const { request_id } = args as { request_id: string };
      return deps.callBrowserTool(requireTabId(args), 'network_body', { request_id });
    }
    case 'browser.click': {
      const {
        selector,
        force = false,
        settle_ms,
        settle_timeout_ms,
      } = args as {
        selector: string;
        force?: boolean;
        settle_ms?: number;
        settle_timeout_ms?: number;
      };
      return runAction(
        'click',
        requireTabId(args),
        { selector, force, settle_ms, settle_timeout_ms },
        deps,
        caller,
        actionTimeoutWithSettle(settle_timeout_ms),
      );
    }
    case 'browser.type': {
      const {
        selector,
        text,
        clear = false,
        settle_ms,
        settle_timeout_ms,
      } = args as {
        selector: string;
        text: string;
        clear?: boolean;
        settle_ms?: number;
        settle_timeout_ms?: number;
      };
      return runAction(
        'type',
        requireTabId(args),
        { selector, text, clear, settle_ms, settle_timeout_ms },
        deps,
        caller,
        actionTimeoutWithSettle(settle_timeout_ms),
      );
    }
    case 'browser.press': {
      const { key, modifiers, selector, settle_ms, settle_timeout_ms } = (args ?? {}) as {
        key?: unknown;
        modifiers?: unknown;
        selector?: unknown;
        settle_ms?: number;
        settle_timeout_ms?: number;
      };
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('browser.press: key required');
      }
      let normalizedModifiers: string[] = [];
      if (modifiers !== undefined) {
        if (!isModifierArray(modifiers)) {
          throw new Error(
            'browser.press: modifiers must be an array of Alt | Control | Meta | Shift',
          );
        }
        normalizedModifiers = modifiers;
      }
      if (selector !== undefined && typeof selector !== 'string') {
        throw new Error('browser.press: selector must be a string when provided');
      }
      return runAction(
        'press',
        requireTabId(args),
        { key, modifiers: normalizedModifiers, selector, settle_ms, settle_timeout_ms },
        deps,
        caller,
        actionTimeoutWithSettle(settle_timeout_ms),
      );
    }
    case 'browser.drag': {
      const {
        from_selector,
        from_x,
        from_y,
        to_selector,
        to_x,
        to_y,
        duration_ms,
        hold_before_move_ms,
        hold_before_release_ms,
      } = (args ?? {}) as {
        from_selector?: string;
        from_x?: number;
        from_y?: number;
        to_selector?: string;
        to_x?: number;
        to_y?: number;
        duration_ms?: number;
        hold_before_move_ms?: number;
        hold_before_release_ms?: number;
      };
      const fromOk = from_selector || (typeof from_x === 'number' && typeof from_y === 'number');
      const toOk = to_selector || (typeof to_x === 'number' && typeof to_y === 'number');
      if (!fromOk) throw new Error('browser.drag: provide from_selector or both from_x and from_y');
      if (!toOk) throw new Error('browser.drag: provide to_selector or both to_x and to_y');
      // Drag can run for `duration_ms` + holds. Give the bridge enough
      // headroom over the configured movement before timing out — but
      // never less than 15s so trivial drags use the same floor as click/type.
      const timeoutMs = Math.max(
        15_000,
        (duration_ms ?? 1500) + (hold_before_move_ms ?? 0) + (hold_before_release_ms ?? 0) + 10_000,
      );
      return runAction(
        'drag',
        requireTabId(args),
        {
          from_selector,
          from_x,
          from_y,
          to_selector,
          to_x,
          to_y,
          duration_ms,
          hold_before_move_ms,
          hold_before_release_ms,
        },
        deps,
        caller,
        timeoutMs,
      );
    }
    case 'browser.flow': {
      const { steps } = (args ?? {}) as { steps?: unknown };
      const validated = validateFlowSteps(steps);
      if (!validated.ok) throw new Error(`browser.flow: ${validated.error}`);
      // budgetMs is the flow's truthful worst case and validateFlowSteps
      // already rejected anything above MAX_FLOW_TIMEOUT_MS, so the
      // enforced timeout is never below the modeled need — only the shared
      // action floor can raise it.
      return runAction(
        'flow',
        requireTabId(args),
        { steps: validated.steps },
        deps,
        caller,
        Math.max(ACTION_TIMEOUT_FLOOR_MS, validated.budgetMs),
      );
    }
    case 'browser.evaluate': {
      const { expression } = args as { expression: string };
      return runAction('evaluate', requireTabId(args), { expression }, deps, caller);
    }
    case 'browser.events':
      return handleEvents(args, deps);
    case 'browser.reset':
      return handleReset(deps);
    case 'browser.wait_for_tab': {
      const { opened_from, url_substring, timeout_ms } = (args ?? {}) as {
        opened_from?: string;
        url_substring?: string;
        timeout_ms?: number;
      };
      if (typeof opened_from !== 'string' || opened_from.length === 0) {
        throw new Error('browser.wait_for_tab: opened_from required');
      }
      if (!deps.subscribeEvents) {
        return {
          matched: false,
          elapsed_ms: 0,
          reason: 'events-unavailable',
        };
      }
      const MAX_TIMEOUT_MS = 60_000;
      const requestedTimeout =
        typeof timeout_ms === 'number' && timeout_ms > 0 ? timeout_ms : 10_000;
      const timeoutMs = requestedTimeout < MAX_TIMEOUT_MS ? requestedTimeout : MAX_TIMEOUT_MS;
      const needle = typeof url_substring === 'string' ? url_substring.toLowerCase() : null;
      const startedAt = Date.now();
      // Push-based wait. The listener is registered FIRST (synchronously);
      // a `replayWithinMs` of 1500 covers the parallel-dispatch race where
      // the source event landed in the buffer milliseconds before this
      // handler was reached. Older events are not replayed — they belong
      // to a previous flow.
      const REPLAY_WITHIN_MS = 1500;
      const subscribe = deps.subscribeEvents;
      const tabClaims = deps.tabClaims;
      return new Promise<unknown>((resolve) => {
        let settled = false;
        let unsubscribe: () => void = () => {
          /* placeholder */
        };
        const settleWith = (payload: unknown): void => {
          if (settled) return;
          settled = true;
          unsubscribe();
          clearTimeout(timer);
          resolve(payload);
        };
        const listener: BridgeEventListener = (e) => {
          if (settled) return;
          if (e.kind !== 'tab-created') return;
          if (e.data.opened_from !== opened_from) return;
          const eUrl = typeof e.data.url === 'string' ? e.data.url : '';
          if (needle !== null && !eUrl.toLowerCase().includes(needle)) return;
          const eTabId = typeof e.data.tab_id === 'string' ? e.data.tab_id : null;
          if (eTabId === null) return;
          // Match — auto-claim. The wait IS the explicit intent. If a race
          // lost us the claim, the caller still gets matched:true with a
          // conflict description so it can decide whether to retry or surface.
          let claimed = false;
          let claim_conflict: string | undefined;
          if (tabClaims) {
            const outcome = tabClaims.claim(eTabId, caller);
            if (outcome.ok) {
              claimed = true;
            } else {
              claim_conflict = `existing claim by ${outcome.existing.agent_id} (${outcome.existing.label ?? outcome.existing.binary})`;
            }
          } else {
            claimed = true;
          }
          settleWith({
            matched: true,
            tab_id: eTabId,
            url: eUrl,
            elapsed_ms: Date.now() - startedAt,
            claimed,
            ...(claim_conflict !== undefined ? { claim_conflict } : {}),
          });
        };
        const timer = setTimeout(() => {
          settleWith({
            matched: false,
            elapsed_ms: Date.now() - startedAt,
            reason: 'timeout',
          });
        }, timeoutMs);
        unsubscribe = subscribe(listener, { replayWithinMs: REPLAY_WITHIN_MS });
      });
    }
    case 'browser.dialog_respond': {
      const { accept, prompt_text } = (args ?? {}) as {
        accept?: boolean;
        prompt_text?: string;
      };
      if (typeof accept !== 'boolean') {
        throw new Error('browser.dialog_respond: accept must be a boolean');
      }
      // dialog_respond is an action because it changes page state, but it
      // does NOT need the claim guard: the agent only knows there is a
      // dialog because it read browser.events, and unblocking a frozen
      // tab should not require holding the claim. Other agents may also
      // be observing — first responder wins.
      return deps.callBrowserTool(requireTabId(args), 'dialog_respond', {
        accept,
        prompt_text,
      });
    }
    case 'browser.set_permission': {
      const { origin, name, state } = (args ?? {}) as {
        origin?: string;
        name?: string;
        state?: string;
      };
      if (typeof origin !== 'string' || origin.length === 0) {
        throw new Error('browser.set_permission: origin required');
      }
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('browser.set_permission: name required');
      }
      if (state !== 'granted' && state !== 'denied' && state !== 'prompt') {
        throw new Error('browser.set_permission: state must be one of granted | denied | prompt');
      }
      return runAction('set_permission', requireTabId(args), { origin, name, state }, deps, caller);
    }
    case 'browser.wait_for': {
      const { selector, expression, network_url, condition, timeout_ms, poll_interval_ms } =
        (args ?? {}) as {
          selector?: string;
          expression?: string;
          network_url?: string;
          condition?: string;
          timeout_ms?: number;
          poll_interval_ms?: number;
        };
      const modes = [selector, expression, network_url].filter((v) => v !== undefined);
      if (modes.length !== 1) {
        throw new Error(
          'browser.wait_for: provide exactly one of selector, expression, network_url',
        );
      }
      if (selector !== undefined && condition !== undefined) {
        const ok = ['visible', 'hidden', 'attached', 'detached'].includes(condition);
        if (!ok) {
          throw new Error(
            'browser.wait_for: condition must be one of visible | hidden | attached | detached',
          );
        }
      }
      // wait_for is a read tool: no claim enforcement. Per-request timeout
      // has to cover the worst case the caller asked for, plus a small
      // overhead for the final round-trip when the condition fires.
      const requestTimeoutMs = Math.max(15_000, (timeout_ms ?? 5000) + 5_000);
      return deps.callBrowserTool(
        requireTabId(args),
        'wait_for',
        {
          selector,
          expression,
          network_url,
          condition,
          timeout_ms,
          poll_interval_ms,
        },
        requestTimeoutMs,
      );
    }
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
