/**
 * The cdp-direct tool-routing adapter: implements the same call surface the
 * WS-bridge path (`bridge/ws-bridge.ts`'s `sendToolRequest`) uses —
 * `callCdpTool(tabId, tool, params, timeoutMs?) => Promise<unknown>` — but
 * executes each wire-level tool directly over a raw CDP-over-WebSocket
 * connection (`./client.ts`) instead of routing through the extension.
 *
 * Mirrors `packages/extension/src/background.ts`'s `handleTool` switch and
 * its extracted `performFind` / `performClick` / `performType` /
 * `performPress` / `performWaitFor` helpers function-for-function, using
 * the SAME in-page builder strings (`./inpage/builders.ts`, a verbatim copy
 * — see its header comment) and the SAME `browser.flow` step engine
 * (`./flow.ts`, also a verbatim copy). The wire-level contract is
 * identical: a resolved promise is a wire `ok:true` result, a rejected
 * promise is a wire `ok:false` (the rejection's message is the error
 * string) — exactly what `sendToolRequest` produces for the extension path,
 * so `tools/browser-dispatch.ts` cannot tell the two transports apart by
 * shape.
 */
import { loadConfig, sanitizeCdpPort } from '../config.js';
import { checkCdpDirectGate } from './gate.js';
import { buildTargetWsUrl, cdpTargetIdFromTabId, isDrivablePageTarget } from './targets.js';
import { CdpClient } from './client.js';
import { cdpUnsupportedToolError } from './support.js';
import {
  buildClickResolveJs,
  buildFindJs,
  buildFocusJs,
  buildSnapshotJs,
  buildStateJs,
  buildTypeResolveJs,
  type ClickResolveOpts,
  type FindOpts,
  type SnapshotOpts,
  type TypeResolveOpts,
} from './inpage/builders.js';
import { resolveSettleParams, settleSafely, type SettleParams } from './settle.js';
import { buildKeyEventSequence, modifiersToBitmask, resolveKey } from './keymap.js';
import {
  runFlow,
  type ActionOutcome,
  type ClickStepResult,
  type FindStepResult,
  type FlowStep,
  type PressStepResult,
  type TypeStepResult,
  type WaitForStepResult,
} from './flow.js';

// The declarative v1 support table lives in `./support.ts` (zero
// dependencies, importable by `tools/browser-dispatch.ts` without pulling
// in this whole transport) — re-exported here so existing callers of
// `cdp/transport.ts` keep working.
export { CDP_TOOL_SUPPORT, isCdpToolSupported } from './support.js';
export { cdpUnsupportedToolError };

// === Connection cache =====================================================

interface CdpConnection {
  client: CdpClient;
  lastUsedAt: number;
}

/** Resolved connections currently believed live, keyed by CDP targetId.
 * Only ever holds SETTLED, successful dials — see `getConnection`. */
const connections = new Map<string, CdpConnection>();

/** In-flight dial attempts, keyed by CDP targetId. A call that misses
 * `connections` for a targetId already being dialed awaits THIS SAME
 * promise instead of starting a second WebSocket — without it, two
 * concurrent misses (routine under multi-agent mode, or one agent issuing
 * parallel tool calls to the same tab) would each open their own
 * connection and race to `connections.set`; the loser's socket would then
 * have no map entry at all, so the idle sweep below could never find it
 * and it would leak until process exit. Cleared the moment its attempt
 * settles, win or lose (see `getConnection`'s `finally`), so a failed dial
 * never poisons the cache for the next call. */
const inFlight = new Map<string, Promise<CdpConnection>>();

/** Idle connections are closed after this long unused — keeps a long-lived
 * server process from accumulating an unbounded number of open WebSockets
 * to targets an agent stopped touching hours ago. `let`, not `const`:
 * `setIdleCleanupConfigForTest` overrides both for tests, where waiting
 * out the real 5-minute window is not practical. */
const DEFAULT_IDLE_CLEANUP_MS = 5 * 60_000;
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60_000;
let idleCleanupMs = DEFAULT_IDLE_CLEANUP_MS;
let idleSweepIntervalMs = DEFAULT_IDLE_SWEEP_INTERVAL_MS;

let cleanupTimer: NodeJS.Timeout | null = null;

function ensureCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [targetId, conn] of connections) {
      if (now - conn.lastUsedAt > idleCleanupMs) {
        conn.client.close();
        connections.delete(targetId);
      }
    }
  }, idleSweepIntervalMs);
  cleanupTimer.unref();
}

/**
 * The actual dial: open the WebSocket, re-validate the target, enable
 * `Page`. Extracted out of `getConnection` so concurrent callers can share
 * ONE in-flight `Promise<CdpConnection>` (see `inFlight` above) instead of
 * each running this independently.
 */
async function dial(targetId: string): Promise<CdpConnection> {
  const cfg = loadConfig();
  // sanitizeCdpPort neutralizes an untrusted config.json port string before
  // it reaches the ws URL; the host-assert below is defense in depth.
  const port = sanitizeCdpPort(cfg.cdpDirectPort);
  const wsUrl = buildTargetWsUrl(port, targetId);
  let wsHost: string;
  try {
    wsHost = new URL(wsUrl).hostname;
  } catch {
    throw new Error(`cdp-direct: could not parse the ws url for target ${targetId}`);
  }
  if (wsHost !== '127.0.0.1') {
    throw new Error(`cdp-direct: refusing a non-loopback ws url for target ${targetId}`);
  }
  const client = new CdpClient(wsUrl);
  await client.connect();
  // Re-validate the target on connect, NOT just at discovery. `list_tabs`
  // filters devtools/extension targets for display, but the transport is
  // reached by a caller-supplied `cdp:<targetId>` whose provenance we do
  // not trust — the id need not have come from a `list_tabs` this process
  // produced. Ask the freshly-attached session what it actually is and
  // refuse anything that is not a real page (a DevTools UI surface, an
  // extension page, a worker/service_worker target), using the SAME
  // predicate discovery uses so the two can never drift. Do this BEFORE
  // Page.enable so we never even enable domains on a target we are about
  // to reject.
  const info = await client.send<TargetInfoResult>('Target.getTargetInfo');
  if (!isDrivablePageTarget(info.targetInfo.type, info.targetInfo.url)) {
    client.close();
    throw new Error(
      `cdp-direct: target ${targetId} is not a drivable page ` +
        `(type=${info.targetInfo.type ?? 'unknown'}) — refusing to connect.`,
    );
  }
  // Page.enable is the only domain cdp-direct's v1 tool set needs enabled
  // up front — it unlocks Page.loadEventFired, which navigate's
  // wait_for_load uses. Runtime.evaluate and Input.* commands work without
  // their own domain being explicitly enabled.
  await client.send('Page.enable');
  return { client, lastUsedAt: Date.now() };
}

async function getConnection(targetId: string): Promise<CdpClient> {
  const existing = connections.get(targetId);
  if (existing && existing.client.isOpen) {
    existing.lastUsedAt = Date.now();
    return existing.client;
  }
  if (existing) connections.delete(targetId);

  // Single-flight the dial: a concurrent call for the same target joins
  // whichever attempt is already in progress instead of starting its own
  // (see `inFlight`'s doc comment for the leak this closes).
  let attempt = inFlight.get(targetId);
  if (!attempt) {
    attempt = dial(targetId);
    inFlight.set(targetId, attempt);
  }

  let conn: CdpConnection;
  try {
    conn = await attempt;
  } finally {
    // Clear the marker as soon as the attempt settles, win or lose — but
    // only if it is still OURS. A later call may already have installed a
    // fresh attempt of its own by the time we get here (e.g. right after
    // this one failed); clearing that one instead would defeat its own
    // single-flighting.
    if (inFlight.get(targetId) === attempt) inFlight.delete(targetId);
  }
  // A rejected `attempt` propagates out of the `await` above before this
  // line runs — nothing is ever written to `connections` on failure, so
  // the very next call for this targetId dials fresh instead of replaying
  // the same rejection forever.
  connections.set(targetId, conn);
  ensureCleanupTimer();
  return conn.client;
}

/** Drop every cached connection immediately, closing each WebSocket, and
 * restore the idle-cleanup thresholds to their defaults. Exported for
 * tests; not on any agent-reachable path. */
export function resetConnectionsForTest(): void {
  for (const conn of connections.values()) conn.client.close();
  connections.clear();
  inFlight.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  idleCleanupMs = DEFAULT_IDLE_CLEANUP_MS;
  idleSweepIntervalMs = DEFAULT_IDLE_SWEEP_INTERVAL_MS;
}

/** Test-only override for the idle-cleanup thresholds — the real values
 * (5 min idle / 60s sweep) are far too slow to wait out for real in a
 * test. Same footing as `resetConnectionsForTest`, which restores the
 * defaults; not on any agent-reachable path. */
export function setIdleCleanupConfigForTest(idleMs: number, sweepIntervalMs: number): void {
  idleCleanupMs = idleMs;
  idleSweepIntervalMs = sweepIntervalMs;
}

// === CDP primitives ========================================================

interface CdpEvaluateResult<T> {
  result: { value: T };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

async function evaluateInTab<T = unknown>(
  client: CdpClient,
  expression: string,
  timeoutMs?: number,
): Promise<T> {
  const res = await client.send<CdpEvaluateResult<T>>(
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    },
    timeoutMs,
  );
  if (res.exceptionDetails) {
    const ex = res.exceptionDetails;
    throw new Error(ex.exception?.description ?? ex.text ?? 'Evaluation failed');
  }
  return res.result.value;
}

function waitForLoad(client: CdpClient, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const off = client.on('Page.loadEventFired', () => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      resolve();
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      reject(new Error('navigation timed out'));
    }, timeoutMs);
  });
}

function runSettle(
  client: CdpClient,
  settle: SettleParams | null,
): Promise<Record<string, unknown> | undefined> {
  return settleSafely((expression) => evaluateInTab(client, expression), settle);
}

async function dispatchKeyEventSequence(
  client: CdpClient,
  def: ReturnType<typeof resolveKey>,
  modifiers: number,
): Promise<void> {
  if (!def) return;
  for (const event of buildKeyEventSequence(def, modifiers)) {
    await client.send('Input.dispatchKeyEvent', event);
  }
}

// === perform* action helpers ==============================================
// Mirror background.ts's performFind/performClick/performType/performPress/
// performWaitFor function-for-function — see this module's header comment.

type ClickResolveResult =
  | { ok: true; x: number; y: number; tag: string; hit_element?: string }
  | { ok: false; reason: 'invalid-selector'; error: string }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'occluded'; blocker: string };

type TypeResolveResult =
  | { ok: true }
  | { ok: false; reason: 'invalid-selector'; error: string }
  | { ok: false; reason: 'not-found' };

async function performFind(
  client: CdpClient,
  params: { text: string; role?: string; exact?: boolean },
): Promise<ActionOutcome<FindStepResult>> {
  try {
    if (!params.text) return { ok: false, error: 'find: text required' };
    const opts: FindOpts = { text: params.text, role: params.role, exact: params.exact === true };
    const value = await evaluateInTab<FindStepResult>(client, buildFindJs(opts));
    return { ok: true, result: value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function performClick(
  client: CdpClient,
  params: { selector: string; force?: boolean; settle_ms?: number; settle_timeout_ms?: number },
): Promise<ActionOutcome<ClickStepResult>> {
  try {
    const { selector, force = false } = params;
    const settle = resolveSettleParams({
      settle_ms: params.settle_ms,
      settle_timeout_ms: params.settle_timeout_ms,
    });
    const resolveOpts: ClickResolveOpts = { selector, force };
    const resolved = await evaluateInTab<ClickResolveResult>(
      client,
      buildClickResolveJs(resolveOpts),
    );
    if (!resolved.ok) {
      if (resolved.reason === 'occluded') {
        return {
          ok: false,
          error: `Element covered by ${resolved.blocker} — click the covering element or dismiss it first`,
        };
      }
      if (resolved.reason === 'invalid-selector') {
        return { ok: false, error: `Invalid selector "${selector}": ${resolved.error}` };
      }
      return { ok: false, error: `Element not found: ${selector}` };
    }
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: resolved.x,
      y: resolved.y,
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: resolved.x,
      y: resolved.y,
      button: 'left',
      clickCount: 1,
    });
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: resolved.x,
      y: resolved.y,
      button: 'left',
      clickCount: 1,
    });
    const settleResult = await runSettle(client, settle);
    const result: ClickStepResult = { clicked: selector, tag: resolved.tag };
    if (resolved.hit_element) result.hit_element = resolved.hit_element;
    if (settleResult) result.settle = settleResult;
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function performType(
  client: CdpClient,
  params: {
    selector?: string;
    text: string;
    clear?: boolean;
    settle_ms?: number;
    settle_timeout_ms?: number;
  },
): Promise<ActionOutcome<TypeStepResult>> {
  try {
    const { selector, text, clear = false } = params;
    const settle = resolveSettleParams({
      settle_ms: params.settle_ms,
      settle_timeout_ms: params.settle_timeout_ms,
    });
    if (selector !== undefined) {
      const opts: TypeResolveOpts = { selector, clear };
      const resolved = await evaluateInTab<TypeResolveResult>(client, buildTypeResolveJs(opts));
      if (!resolved.ok) {
        if (resolved.reason === 'invalid-selector') {
          return { ok: false, error: `Invalid selector "${selector}": ${resolved.error}` };
        }
        return { ok: false, error: `Element not found: ${selector}` };
      }
    }
    await client.send('Input.insertText', { text });
    const settleResult = await runSettle(client, settle);
    const result: TypeStepResult = { typed: text.length };
    if (selector !== undefined) result.selector = selector;
    if (settleResult) result.settle = settleResult;
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function performPress(
  client: CdpClient,
  params: {
    key?: string;
    modifiers?: string[];
    selector?: string;
    settle_ms?: number;
    settle_timeout_ms?: number;
  },
): Promise<ActionOutcome<PressStepResult>> {
  try {
    const key = params.key;
    if (!key) return { ok: false, error: 'press: key required' };
    const def = resolveKey(key);
    if (!def) return { ok: false, error: `press: unrecognized key "${key}"` };
    const modifierNames = params.modifiers ?? [];
    const modifiers = modifiersToBitmask(modifierNames) | (def.needsShift ? 8 : 0);
    const settle = resolveSettleParams({
      settle_ms: params.settle_ms,
      settle_timeout_ms: params.settle_timeout_ms,
    });
    if (params.selector) {
      const focused = await evaluateInTab<boolean>(
        client,
        buildFocusJs({ selector: params.selector }),
      );
      if (!focused) {
        return { ok: false, error: `Element not found: ${params.selector}` };
      }
    }
    await dispatchKeyEventSequence(client, def, modifiers);
    const settleResult = await runSettle(client, settle);
    const result: PressStepResult = { key, modifiers: modifierNames };
    if (settleResult) result.settle = settleResult;
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function buildWaitSelectorExpr(selector: string, condition: string): string {
  const sel = JSON.stringify(selector);
  if (condition === 'attached') {
    return `Boolean(document.querySelector(${sel}))`;
  }
  if (condition === 'detached') {
    return `!document.querySelector(${sel})`;
  }
  const want = condition === 'hidden' ? '!' : '';
  return `(() => {
    const el = document.querySelector(${sel});
    if (!el) return ${condition === 'hidden' ? 'true' : 'false'};
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return ${condition === 'hidden' ? 'true' : 'false'};
    const r = el.getBoundingClientRect();
    return ${want}(r.width > 0 && r.height > 0);
  })()`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof ms === 'number' && ms > 0 && ms < 60_000) {
      setTimeout(resolve, ms);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function performWaitFor(
  client: CdpClient,
  params: {
    selector?: string;
    expression?: string;
    network_url?: string;
    condition?: string;
    timeout_ms?: number;
    poll_interval_ms?: number;
  },
): Promise<ActionOutcome<WaitForStepResult>> {
  // cdp-direct never enables the Network domain (console/network are out of
  // v1 scope — see CDP_TOOL_SUPPORT), so a network_url wait has nothing to
  // poll against. This is a narrow, explicitly-commented exception to the
  // tool-level support table, not a scattered gate: every OTHER wait_for
  // mode (selector, expression) is fully supported.
  if (params.network_url !== undefined) {
    return {
      ok: false,
      error:
        'wait_for: network_url mode is not supported over cdp-direct in v1 (no network buffering) — use a tab connected through the Chrome extension instead.',
    };
  }
  try {
    const waitSelector = params.selector;
    const waitExpression = params.expression;
    const waitCondition = params.condition ?? 'visible';
    const MAX_WAIT_TIMEOUT_MS = 30_000;
    const MIN_POLL_MS = 50;
    const MAX_POLL_MS = 1_000;
    const requestedTimeout = params.timeout_ms ?? 5_000;
    const timeoutMs =
      requestedTimeout < MAX_WAIT_TIMEOUT_MS ? requestedTimeout : MAX_WAIT_TIMEOUT_MS;
    const requestedPoll = params.poll_interval_ms ?? 100;
    const pollIntervalMs =
      requestedPoll < MIN_POLL_MS
        ? MIN_POLL_MS
        : requestedPoll > MAX_POLL_MS
          ? MAX_POLL_MS
          : requestedPoll;

    let check: (() => Promise<boolean>) | null = null;
    if (waitSelector !== undefined) {
      const expr = buildWaitSelectorExpr(waitSelector, waitCondition);
      check = async (): Promise<boolean> => {
        try {
          const value = await evaluateInTab(client, expr);
          return Boolean(value);
        } catch {
          return false;
        }
      };
    } else if (waitExpression !== undefined) {
      const wrapped = `Boolean(${waitExpression})`;
      check = async (): Promise<boolean> => {
        try {
          const value = await evaluateInTab(client, wrapped);
          return Boolean(value);
        } catch {
          return false;
        }
      };
    }

    const startedAt = Date.now();
    let checks = 0;
    let matched = false;
    while (check) {
      checks++;
      if (await check()) {
        matched = true;
        break;
      }
      if (Date.now() - startedAt >= timeoutMs) break;
      await sleep(pollIntervalMs);
    }
    const elapsedMs = Date.now() - startedAt;
    const result: WaitForStepResult = matched
      ? { matched: true, elapsed_ms: elapsedMs, checks }
      : { matched: false, elapsed_ms: elapsedMs, checks, reason: 'timeout' };
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// === Tool dispatch ==========================================================

interface TargetInfoResult {
  targetInfo: { title?: string; url?: string; type?: string };
}

async function getTargetInfo(client: CdpClient): Promise<{ title: string; url: string }> {
  const info = await client.send<TargetInfoResult>('Target.getTargetInfo');
  return { title: info.targetInfo.title ?? '', url: info.targetInfo.url ?? '' };
}

/**
 * Entry point matching `BrowserToolDeps['callBrowserTool']`'s signature —
 * `tools/browser-dispatch.ts` calls this for any tool addressing a `cdp:`
 * tab, after confirming (via `CDP_TOOL_SUPPORT`) that the tool is in v1
 * scope. `tool` is the WIRE-level name ('click', not 'browser.click').
 *
 * Re-checks `checkCdpDirectGate()` itself (defense in depth — this module
 * must never be safe to call without the gate passing, even if a future
 * caller reaches it directly instead of through the dispatcher).
 *
 * `timeoutMs` (the dispatcher's per-tool budget) is DELIBERATELY not applied
 * as an outer race here, unlike the WS-bridge path where it bounds a single
 * opaque round trip to the extension. Over cdp-direct every underlying step
 * already carries its OWN hard bound, so there is no unbounded wait for an
 * outer timeout to guard: each `CdpClient.send` has a 15s default per-command
 * timeout (see client.ts), `waitForLoad` caps navigation's load wait at 20s,
 * `performWaitFor` clamps its own poll loop to <=30s, and `runFlow`'s budget
 * was already validated <=60s upstream. Wrapping the whole call in a second
 * timer would only add a redundant, harder-to-reason-about failure mode (an
 * outer reject while an inner CDP command is still in flight and will settle
 * on its own bound). The one consumer is `evaluate`, whose single
 * `Runtime.evaluate` command runs caller-supplied JS for a caller-controlled
 * duration — there the budget IS that command's own per-command timeout
 * (replacing the 15s default, still no outer race), so `browser.evaluate`'s
 * `timeout_ms` reaches cdp-direct tabs too. Kept in the signature for
 * shape-parity with `callBrowserTool` for every other tool.
 */
export async function callCdpTool(
  tabId: string,
  tool: string,
  params: unknown,
  timeoutMs?: number,
): Promise<unknown> {
  const gate = checkCdpDirectGate();
  if (!gate.ok) throw new Error(gate.error);

  const targetId = cdpTargetIdFromTabId(tabId);
  if (!targetId) throw new Error(`cdp-direct: malformed cdp tab id "${tabId}"`);

  const client = await getConnection(targetId);
  const p = (params ?? {}) as Record<string, unknown>;

  switch (tool) {
    case 'ping':
      return getTargetInfo(client);

    case 'navigate': {
      const url = typeof p.url === 'string' ? p.url : '';
      const waitForLoadFlag = p.wait_for_load !== false;
      await client.send('Page.navigate', { url });
      if (waitForLoadFlag) await waitForLoad(client);
      return getTargetInfo(client);
    }

    case 'snapshot': {
      const opts: SnapshotOpts = {
        within_selector: typeof p.within_selector === 'string' ? p.within_selector : undefined,
        only_interactive: p.only_interactive === true,
        exclude: Array.isArray(p.exclude)
          ? p.exclude.filter((x): x is string => typeof x === 'string')
          : undefined,
        max_interactive: typeof p.max_interactive === 'number' ? p.max_interactive : undefined,
      };
      return evaluateInTab(client, buildSnapshotJs(opts));
    }

    case 'state':
      return evaluateInTab(client, buildStateJs());

    case 'find': {
      const outcome = await performFind(client, {
        text: typeof p.text === 'string' ? p.text : '',
        role: typeof p.role === 'string' ? p.role : undefined,
        exact: p.exact === true,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome.result;
    }

    case 'click': {
      const outcome = await performClick(client, {
        selector: typeof p.selector === 'string' ? p.selector : '',
        force: p.force === true,
        settle_ms: typeof p.settle_ms === 'number' ? p.settle_ms : undefined,
        settle_timeout_ms:
          typeof p.settle_timeout_ms === 'number' ? p.settle_timeout_ms : undefined,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome.result;
    }

    case 'type': {
      const outcome = await performType(client, {
        selector: typeof p.selector === 'string' ? p.selector : undefined,
        text: typeof p.text === 'string' ? p.text : '',
        clear: p.clear === true,
        settle_ms: typeof p.settle_ms === 'number' ? p.settle_ms : undefined,
        settle_timeout_ms:
          typeof p.settle_timeout_ms === 'number' ? p.settle_timeout_ms : undefined,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome.result;
    }

    case 'press': {
      const modifierNames = Array.isArray(p.modifiers)
        ? p.modifiers.filter((m): m is string => typeof m === 'string')
        : [];
      const outcome = await performPress(client, {
        key: typeof p.key === 'string' ? p.key : undefined,
        modifiers: modifierNames,
        selector: typeof p.selector === 'string' ? p.selector : undefined,
        settle_ms: typeof p.settle_ms === 'number' ? p.settle_ms : undefined,
        settle_timeout_ms:
          typeof p.settle_timeout_ms === 'number' ? p.settle_timeout_ms : undefined,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome.result;
    }

    case 'evaluate': {
      const expression = typeof p.expression === 'string' ? p.expression : '';
      return evaluateInTab(client, expression, timeoutMs);
    }

    case 'wait_for': {
      const outcome = await performWaitFor(client, {
        selector: typeof p.selector === 'string' ? p.selector : undefined,
        expression: typeof p.expression === 'string' ? p.expression : undefined,
        network_url: typeof p.network_url === 'string' ? p.network_url : undefined,
        condition: typeof p.condition === 'string' ? p.condition : undefined,
        timeout_ms: typeof p.timeout_ms === 'number' ? p.timeout_ms : undefined,
        poll_interval_ms: typeof p.poll_interval_ms === 'number' ? p.poll_interval_ms : undefined,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome.result;
    }

    case 'flow': {
      const rawSteps = Array.isArray(p.steps)
        ? p.steps.filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
        : [];
      return runFlow(rawSteps as FlowStep[], {
        performFind: (fp) => performFind(client, fp),
        performClick: (cp) => performClick(client, cp),
        performType: (tp) => performType(client, tp),
        performPress: (pp) => performPress(client, pp),
        performWaitFor: (wp) => performWaitFor(client, wp),
        buildRecoverySnapshot: () =>
          evaluateInTab(client, buildSnapshotJs({ only_interactive: true, max_interactive: 40 })),
      });
    }

    default:
      // Reached only if a caller bypasses CDP_TOOL_SUPPORT's gate — defense
      // in depth, not a path browser-dispatch.ts's routing exercises.
      throw cdpUnsupportedToolError(tool);
  }
}
