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
  buildElementRectJs,
  buildFocusJs,
  buildSnapshotJs,
  buildStateJs,
  buildTypeResolveJs,
  buildWaitForSelectorJs,
  type FindKey,
  type SnapshotOpts,
  type WaitForSelectorCondition,
} from './inpage/builders.js';
import {
  OBSERVER_BINDING,
  buildObserverChangesJs,
  buildObserverInstallJs,
  buildObserverMarkJs,
  buildObserverTeardownJs,
} from './inpage/observer.js';
import {
  TOP_DOCUMENT_PROBE_JS,
  applyObserverMessage,
  createObserverMirror,
  isTopDocumentMessage,
  mergeSettleChanges,
  parseObserverMessage,
  readObserverMark,
  type ObserverMirror,
} from './observer-host.js';
import { runScreenshot, type ElementRectOutcome, type ScreenshotMode } from './screenshot.js';
import { resolveSettleParams, settleSafely, type SettleParams } from './settle.js';
import { beginExpect, resolveExpectParams, verifyExpect, type ExpectParams } from './expect.js';
import { buildKeyEventSequence, MODIFIER_BITS, modifiersToBitmask, resolveKey } from './keymap.js';
import {
  cancelDetachedFlow,
  detachedFlowForTab,
  detachedFlowStatus,
  finishDetachedFlow,
  registerDetachedFlow,
  reportDetachedProgress,
  shouldStopDetachedFlow,
} from './detached-flows.js';
import {
  refFailureMessage,
  retargetedClickMessage,
  runFlow,
  type ActionOutcome,
  type ClickStepResult,
  type FindStepResult,
  type FlowDeps,
  type FlowResult,
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

/** Page-observer state of one connection (see `observer-host.ts`): the host
 * mirror, and the `Page.addScriptToEvaluateOnNewDocument` identifier to
 * remove on close. Keyed by client so the perform* helpers, which only get
 * the client, can reach it. */
interface CdpObserverState {
  mirror: ObserverMirror;
  scriptId?: string;
}

const observers = new WeakMap<CdpClient, CdpObserverState>();

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
        connections.delete(targetId);
        void closeConnection(conn.client, targetId);
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
  // their own domain being explicitly enabled. The page observer enables
  // Runtime itself, for `Runtime.bindingCalled` (see `installObserver`).
  await client.send('Page.enable');
  await installObserver(client);
  return { client, lastUsedAt: Date.now() };
}

/**
 * Install the page observer on a freshly dialled connection, as the
 * extension does in `connectTab`: Runtime (for `Runtime.bindingCalled`),
 * the push binding, then the observer as a new-document script that also
 * runs immediately in the current document. Non-fatal — on failure the
 * connection is used as before and actions report `settle.changes: null`
 * with `observer-unavailable`.
 */
async function installObserver(client: CdpClient): Promise<void> {
  const state: CdpObserverState = { mirror: createObserverMirror() };
  observers.set(client, state);
  client.on('Runtime.bindingCalled', (params) => {
    const p = (params ?? {}) as { name?: unknown; payload?: unknown };
    if (p.name !== OBSERVER_BINDING) return;
    void handleObserverMessage(client, state, typeof p.payload === 'string' ? p.payload : '');
  });
  try {
    await client.send('Runtime.enable');
    await client.send('Runtime.addBinding', { name: OBSERVER_BINDING });
    const added = await client.send<{ identifier?: unknown }>(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: buildObserverInstallJs(), runImmediately: true },
    );
    if (typeof added.identifier === 'string') state.scriptId = added.identifier;
    state.mirror.installed = true;
  } catch (err) {
    console.warn(
      'browser-link: cdp-direct page observer not installed',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Fold one binding message into the connection's mirror. `doc_start` / `nav`
 * are first checked against the top document (the install script also runs
 * in same-process child frames, and the binding is page-visible). cdp-direct
 * has no bridge events and `list_tabs` reads target info live, so the mirror
 * is the only thing updated here.
 */
async function handleObserverMessage(
  client: CdpClient,
  state: CdpObserverState,
  payload: string,
): Promise<void> {
  const message = parseObserverMessage(payload);
  if (!message) return;
  if (message.type === 'summary') {
    applyObserverMessage(state.mirror, message);
    return;
  }
  let probe: unknown;
  try {
    probe = await evaluateObserverJs(client, TOP_DOCUMENT_PROBE_JS);
  } catch {
    return;
  }
  if (!isTopDocumentMessage(probe, message.doc_id)) return;
  applyObserverMessage(state.mirror, message);
}

/**
 * Best-effort observer removal, then close the socket. Never throws. The
 * in-page teardown is skipped when a newer connection to the same target
 * already exists: the page holds one observer instance, which that
 * connection's install left in place (equal version), so tearing it down
 * here would leave the newer connection without an observer.
 */
async function closeConnection(client: CdpClient, targetId: string): Promise<void> {
  const state = observers.get(client);
  if (state?.mirror.installed === true && client.isOpen) {
    state.mirror.installed = false;
    if (state.scriptId !== undefined) {
      try {
        await client.send(
          'Page.removeScriptToEvaluateOnNewDocument',
          { identifier: state.scriptId },
          OBSERVER_EVAL_TIMEOUT_MS,
        );
      } catch {
        // Best effort — the target may already be gone.
      }
      state.scriptId = undefined;
    }
    if (!connections.has(targetId) && !inFlight.has(targetId)) {
      try {
        await evaluateObserverJs(client, buildObserverTeardownJs());
      } catch {
        // Best effort — the target may already be gone.
      }
    }
  }
  client.close();
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

/** Ceiling for one observer plumbing evaluation, as in the extension: a
 * page frozen by a native dialog never answers `Runtime.evaluate`. */
const OBSERVER_EVAL_TIMEOUT_MS = 2_000;

/**
 * `Runtime.evaluate` for page-observer plumbing (mark, changes, probes,
 * teardown). Unlike `evaluateInTab` it passes no `userGesture` — these
 * reads must never hand the page transient user activation it did not
 * earn — and it gives up after `OBSERVER_EVAL_TIMEOUT_MS`.
 */
async function evaluateObserverJs(client: CdpClient, expression: string): Promise<unknown> {
  const res = await client.send<CdpEvaluateResult<unknown>>(
    'Runtime.evaluate',
    { expression, returnByValue: true },
    OBSERVER_EVAL_TIMEOUT_MS,
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

const OBSERVER_UNAVAILABLE = { ok: false, reason: 'observer-unavailable' } as const;
const OBSERVER_DOC_CHANGED = { ok: false, reason: 'doc-changed' } as const;

/**
 * Take the page observer's action mark BEFORE an action dispatches (spec v4
 * §5.4). `null` when settle is off for this call (no changes are reported
 * then); an `observer-unavailable` marker when the observer was never
 * installed on this connection or the mark could not be taken.
 */
async function takeObserverMark(client: CdpClient, settle: SettleParams | null): Promise<unknown> {
  if (!settle) return null;
  if (observers.get(client)?.mirror.installed !== true) return OBSERVER_UNAVAILABLE;
  try {
    return await evaluateObserverJs(client, buildObserverMarkJs());
  } catch {
    return OBSERVER_UNAVAILABLE;
  }
}

/**
 * Run the settle wait, then read what the page observer saw since `mark`
 * and fold it into the settle result (`mergeSettleChanges`). Never throws:
 * a changes read that rejects — typically because the action navigated and
 * destroyed the context — is reported as `doc-changed`.
 */
async function settleWithChanges(
  client: CdpClient,
  settle: SettleParams | null,
  mark: unknown,
): Promise<Record<string, unknown> | undefined> {
  const settleResult = await runSettle(client, settle);
  if (!settleResult) return undefined;
  const parsed = readObserverMark(mark);
  let changes: unknown = mark ?? OBSERVER_UNAVAILABLE;
  if (parsed) {
    try {
      changes = await evaluateObserverJs(
        client,
        buildObserverChangesJs(parsed.mark, parsed.doc_id),
      );
    } catch {
      changes = OBSERVER_DOC_CHANGED;
    }
  }
  return mergeSettleChanges(settleResult, changes) ?? undefined;
}

async function dispatchKeyEvent(
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
  | { ok: true; x: number; y: number; tag: string; hit_element?: string; reresolved?: boolean }
  | { ok: false; reason: 'invalid-selector'; error: string }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'occluded'; blocker: string }
  | { ok: false; reason: 'retargeted'; hit_element: string }
  | RefResolveFailure;

type TypeResolveResult =
  | { ok: true; reresolved?: boolean }
  | { ok: false; reason: 'invalid-selector'; error: string }
  | { ok: false; reason: 'not-found' }
  | RefResolveFailure;

/** A `ref` target the page could not resolve — see `RESOLVE_TARGET_JS` in
 * `inpage/builders.ts`; `refFailureMessage` (flow.ts) turns it into the
 * error string. */
type RefResolveFailure =
  | { ok: false; reason: 'ref-stale'; ref: string; doc_id?: string }
  | { ok: false; reason: 'observer-unavailable' };

/** Result shape of `buildFocusJs` with a `ref` (with a selector it is a
 * boolean). */
type FocusRefResult = { ok: true; reresolved?: boolean } | RefResolveFailure;

async function performFind(
  client: CdpClient,
  params: { text?: string; role?: string; exact?: boolean; ref?: string; key?: FindKey },
): Promise<ActionOutcome<FindStepResult>> {
  try {
    const { text, ref } = params;
    if (params.key !== undefined) {
      const value = await evaluateInTab<FindStepResult>(client, buildFindJs({ key: params.key }));
      return { ok: true, result: value };
    }
    if (ref !== undefined) {
      const found = await evaluateInTab<FindStepResult>(client, buildFindJs({ ref }));
      const refError = found.matched ? null : refFailureMessage(found, ref);
      if (refError) return { ok: false, error: refError };
      return { ok: true, result: found };
    }
    if (!text) return { ok: false, error: 'find: text required' };
    const value = await evaluateInTab<FindStepResult>(
      client,
      buildFindJs({ text, role: params.role, exact: params.exact === true }),
    );
    return { ok: true, result: value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function performClick(
  client: CdpClient,
  params: {
    /** Exactly one of `selector` / `ref`. */
    selector?: string;
    ref?: string;
    force?: boolean;
    settle_ms?: number;
    settle_timeout_ms?: number;
    expect?: ExpectParams;
  },
): Promise<ActionOutcome<ClickStepResult>> {
  try {
    const { selector, ref, force = false } = params;
    const settle = resolveSettleParams({
      settle_ms: params.settle_ms,
      settle_timeout_ms: params.settle_timeout_ms,
    });
    const expectSpec = resolveExpectParams(params.expect);
    const evaluate = (expression: string): Promise<unknown> => evaluateInTab(client, expression);
    const resolved = await evaluateInTab<ClickResolveResult>(
      client,
      buildClickResolveJs(ref !== undefined ? { ref, force } : { selector, force }),
    );
    if (!resolved.ok) {
      const refError = ref !== undefined ? refFailureMessage(resolved, ref) : null;
      if (refError) return { ok: false, error: refError };
      if (resolved.reason === 'occluded') {
        return {
          ok: false,
          error: `Element covered by ${resolved.blocker} — click the covering element or dismiss it first`,
        };
      }
      if (resolved.reason === 'retargeted') {
        return {
          ok: false,
          error: retargetedClickMessage(resolved.hit_element, ref ?? selector ?? ''),
        };
      }
      if (resolved.reason === 'invalid-selector') {
        return { ok: false, error: `Invalid selector "${selector}": ${resolved.error}` };
      }
      return { ok: false, error: `Element not found: ${ref ?? selector}` };
    }
    const mark = await takeObserverMark(client, settle);
    const baseline = await beginExpect(evaluate, expectSpec);
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
    const settleResult = await settleWithChanges(client, settle, mark);
    const verdict = await verifyExpect(evaluate, expectSpec, baseline, settleResult);
    if (!verdict.ok) return { ok: false, error: verdict.error };
    const result: ClickStepResult = { clicked: ref ?? selector ?? '', tag: resolved.tag };
    if (ref !== undefined) result.ref = ref;
    if (resolved.reresolved === true) result.reresolved = true;
    if (resolved.hit_element) result.hit_element = resolved.hit_element;
    if (settleResult) result.settle = settleResult;
    if (verdict.expect) result.expect = verdict.expect;
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function performType(
  client: CdpClient,
  params: {
    selector?: string;
    /** Exclusive with `selector`. */
    ref?: string;
    text: string;
    clear?: boolean;
    settle_ms?: number;
    settle_timeout_ms?: number;
    expect?: ExpectParams;
  },
): Promise<ActionOutcome<TypeStepResult>> {
  try {
    const { selector, ref, text, clear = false } = params;
    const settle = resolveSettleParams({
      settle_ms: params.settle_ms,
      settle_timeout_ms: params.settle_timeout_ms,
    });
    const expectSpec = resolveExpectParams(params.expect);
    const evaluate = (expression: string): Promise<unknown> => evaluateInTab(client, expression);
    let reresolved = false;
    if (ref !== undefined) {
      const resolved = await evaluateInTab<TypeResolveResult>(
        client,
        buildTypeResolveJs({ ref, clear }),
      );
      if (!resolved.ok) {
        return {
          ok: false,
          error: refFailureMessage(resolved, ref) ?? `Element not found: ${ref}`,
        };
      }
      reresolved = resolved.reresolved === true;
    } else if (selector !== undefined) {
      const resolved = await evaluateInTab<TypeResolveResult>(
        client,
        buildTypeResolveJs({ selector, clear }),
      );
      if (!resolved.ok) {
        if (resolved.reason === 'invalid-selector') {
          return { ok: false, error: `Invalid selector "${selector}": ${resolved.error}` };
        }
        return { ok: false, error: `Element not found: ${selector}` };
      }
    }
    const mark = await takeObserverMark(client, settle);
    const baseline = await beginExpect(evaluate, expectSpec);
    await client.send('Input.insertText', { text });
    const settleResult = await settleWithChanges(client, settle, mark);
    const verdict = await verifyExpect(evaluate, expectSpec, baseline, settleResult);
    if (!verdict.ok) return { ok: false, error: verdict.error };
    const result: TypeStepResult = { typed: text.length };
    if (selector !== undefined) result.selector = selector;
    if (ref !== undefined) result.ref = ref;
    if (reresolved) result.reresolved = true;
    if (settleResult) result.settle = settleResult;
    if (verdict.expect) result.expect = verdict.expect;
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
    /** Exclusive with `selector`. */
    ref?: string;
    settle_ms?: number;
    settle_timeout_ms?: number;
    expect?: ExpectParams;
  },
): Promise<ActionOutcome<PressStepResult>> {
  try {
    const key = params.key;
    if (!key) return { ok: false, error: 'press: key required' };
    const def = resolveKey(key);
    if (!def) return { ok: false, error: `press: unrecognized key "${key}"` };
    const modifierNames = params.modifiers ?? [];
    const modifiers =
      modifiersToBitmask(modifierNames) | (def.needsShift ? MODIFIER_BITS.Shift : 0);
    const settle = resolveSettleParams({
      settle_ms: params.settle_ms,
      settle_timeout_ms: params.settle_timeout_ms,
    });
    const expectSpec = resolveExpectParams(params.expect);
    const evaluate = (expression: string): Promise<unknown> => evaluateInTab(client, expression);
    const ref = params.ref;
    let reresolved = false;
    if (ref !== undefined) {
      const focused = await evaluateInTab<FocusRefResult>(client, buildFocusJs({ ref }));
      if (!focused.ok) {
        return { ok: false, error: refFailureMessage(focused, ref) ?? `Element not found: ${ref}` };
      }
      reresolved = focused.reresolved === true;
    } else if (params.selector) {
      const focused = await evaluateInTab<boolean>(
        client,
        buildFocusJs({ selector: params.selector }),
      );
      if (!focused) {
        return { ok: false, error: `Element not found: ${params.selector}` };
      }
    }
    const mark = await takeObserverMark(client, settle);
    const baseline = await beginExpect(evaluate, expectSpec);
    await dispatchKeyEvent(client, def, modifiers);
    const settleResult = await settleWithChanges(client, settle, mark);
    const verdict = await verifyExpect(evaluate, expectSpec, baseline, settleResult);
    if (!verdict.ok) return { ok: false, error: verdict.error };
    const result: PressStepResult = { key, modifiers: modifierNames };
    if (ref !== undefined) result.ref = ref;
    if (reresolved) result.reresolved = true;
    if (settleResult) result.settle = settleResult;
    if (verdict.expect) result.expect = verdict.expect;
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
    ref?: string;
    expression?: string;
    network_url?: string;
    condition?: string;
    timeout_ms?: number;
    poll_interval_ms?: number;
  },
  /** Cancellation flag of the flow this wait belongs to, when it is a flow
   * step (see the `flow` case below). Checked on EVERY poll tick, which is
   * what makes the advertised worst-case cancellation latency of one step
   * true for a step that can legitimately park for 30 seconds. Absent for
   * the standalone `browser.wait_for` tool, which has no flow to be
   * cancelled with. */
  shouldCancel?: () => boolean,
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
    // Set when a ref probe reports that the page has no observer: the ref
    // can never resolve, so the wait fails instead of timing out (or, for
    // `detached` / `hidden`, matching a ref it never looked up).
    const refProbe = { unavailable: false };
    if (waitSelector !== undefined) {
      const expr = buildWaitForSelectorJs(waitSelector, waitCondition as WaitForSelectorCondition);
      check = async (): Promise<boolean> => {
        try {
          const result = await evaluateInTab(client, expr);
          return Boolean(result);
        } catch {
          return false;
        }
      };
    } else if (params.ref !== undefined) {
      const expr = buildWaitForSelectorJs(
        { ref: params.ref },
        waitCondition as WaitForSelectorCondition,
      );
      check = async (): Promise<boolean> => {
        try {
          const result = await evaluateInTab(client, expr);
          if (typeof result === 'object' && result !== null) {
            refProbe.unavailable = true;
            return true;
          }
          return result === true;
        } catch {
          return false;
        }
      };
    } else if (waitExpression !== undefined) {
      const wrapped = `Boolean(${waitExpression})`;
      check = async (): Promise<boolean> => {
        try {
          const result = await evaluateInTab(client, wrapped);
          return Boolean(result);
        } catch {
          return false;
        }
      };
    }

    const startedAt = Date.now();
    let checks = 0;
    let matched = false;
    let cancelled = false;
    while (check) {
      if (shouldCancel?.() === true) {
        cancelled = true;
        break;
      }
      checks++;
      if (await check()) {
        matched = true;
        break;
      }
      if (Date.now() - startedAt >= timeoutMs) break;
      await sleep(pollIntervalMs);
    }
    const elapsedMs = Date.now() - startedAt;
    if (refProbe.unavailable && params.ref !== undefined) {
      return {
        ok: false,
        error: refFailureMessage({ reason: 'observer-unavailable' }, params.ref) ?? '',
      };
    }
    // 'cancelled' is deliberately distinct from 'timeout': the step
    // executor turns a timeout into a flow FAILURE (with a recovery
    // snapshot) and a cancellation into a clean `stopped_by: 'cancelled'`.
    // Reporting a stopped wait as a timeout would invent a diagnosis for a
    // condition that was never given its budget.
    const result: WaitForStepResult = matched
      ? { matched: true, elapsed_ms: elapsedMs, checks }
      : {
          matched: false,
          elapsed_ms: elapsedMs,
          checks,
          reason: cancelled ? 'cancelled' : 'timeout',
        };
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The perform* bindings `runFlow` needs over one CDP connection, in one
 * place so the foreground run, the dry-run projection and the detached run
 * cannot drift apart — the same role `buildFlowDeps` plays in the
 * extension's `background.ts`. */
function buildCdpFlowDeps(
  client: CdpClient,
  shouldCancel: () => boolean,
  /** What a `wait_for` poll loop checks: the cancel flag plus, for a
   * foreground flow, its deadline. The runner itself only gets
   * `shouldCancel`, which is how it tells a human stop from a timeout. */
  shouldStopWaiting: () => boolean = shouldCancel,
): Omit<FlowDeps, 'onProgress'> {
  return {
    performFind: (fp) => performFind(client, fp),
    performClick: (cp) => performClick(client, cp),
    performType: (tp) => performType(client, tp),
    performPress: (pp) => performPress(client, pp),
    performWaitFor: (wp) => performWaitFor(client, wp, shouldStopWaiting),
    shouldCancel,
    // Drag is out of cdp-direct's v1 scope (CDP_TOOL_SUPPORT maps it to
    // false), so a flow drag step fails fast at this step with the exact
    // error the standalone browser.drag returns on a cdp: tab — naming the
    // extension transport as the fallback.
    performDrag: () =>
      Promise.resolve({ ok: false as const, error: cdpUnsupportedToolError('drag').message }),
    buildRecoverySnapshot: () =>
      evaluateInTab(client, buildSnapshotJs({ only_interactive: true, max_interactive: 40 })),
  };
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
        since: typeof p.since === 'string' ? p.since : undefined,
      };
      return evaluateInTab(client, buildSnapshotJs(opts));
    }

    case 'state':
      return evaluateInTab(client, buildStateJs());

    case 'screenshot': {
      const mode: ScreenshotMode =
        p.mode === 'full_page' || p.mode === 'element' ? p.mode : 'viewport';
      return runScreenshot(
        {
          send: (method, params) => client.send(method, params),
          resolveElementRect: (selector) =>
            evaluateInTab<ElementRectOutcome>(client, buildElementRectJs({ selector })),
        },
        {
          mode,
          selector: typeof p.selector === 'string' ? p.selector : undefined,
          format: p.format === 'jpeg' ? 'jpeg' : 'png',
          quality: typeof p.quality === 'number' ? p.quality : undefined,
          maxDimension: typeof p.max_dimension === 'number' ? p.max_dimension : undefined,
        },
      );
    }

    case 'find': {
      const outcome = await performFind(client, {
        text: typeof p.text === 'string' ? p.text : '',
        role: typeof p.role === 'string' ? p.role : undefined,
        exact: p.exact === true,
        ref: typeof p.ref === 'string' ? p.ref : undefined,
        key: typeof p.key === 'object' && p.key !== null ? (p.key as FindKey) : undefined,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome.result;
    }

    case 'click': {
      const ref = typeof p.ref === 'string' ? p.ref : undefined;
      const outcome = await performClick(client, {
        selector: typeof p.selector === 'string' ? p.selector : ref !== undefined ? undefined : '',
        ref,
        force: p.force === true,
        settle_ms: typeof p.settle_ms === 'number' ? p.settle_ms : undefined,
        settle_timeout_ms:
          typeof p.settle_timeout_ms === 'number' ? p.settle_timeout_ms : undefined,
        expect: p.expect as ExpectParams | undefined,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome.result;
    }

    case 'type': {
      const outcome = await performType(client, {
        selector: typeof p.selector === 'string' ? p.selector : undefined,
        ref: typeof p.ref === 'string' ? p.ref : undefined,
        text: typeof p.text === 'string' ? p.text : '',
        clear: p.clear === true,
        settle_ms: typeof p.settle_ms === 'number' ? p.settle_ms : undefined,
        settle_timeout_ms:
          typeof p.settle_timeout_ms === 'number' ? p.settle_timeout_ms : undefined,
        expect: p.expect as ExpectParams | undefined,
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
        ref: typeof p.ref === 'string' ? p.ref : undefined,
        settle_ms: typeof p.settle_ms === 'number' ? p.settle_ms : undefined,
        settle_timeout_ms:
          typeof p.settle_timeout_ms === 'number' ? p.settle_timeout_ms : undefined,
        expect: p.expect as ExpectParams | undefined,
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
        ref: typeof p.ref === 'string' ? p.ref : undefined,
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
      // Strict `=== true` on both flags: any other value runs the flow FOR
      // REAL and in the foreground. A dry run that silently became a real
      // run, or a foreground run that silently detached, would each be the
      // worst possible failure of their flag.
      const dryRun = p.dry_run === true;
      const detach = p.dry_run !== true && p.detach === true;
      const flowId = typeof p.flow_id === 'string' && p.flow_id.length > 0 ? p.flow_id : '';

      // THE cdp-direct kill switch. There is no extension here and
      // therefore no popup Stop button, so the user's only lever is
      // `browser-link cdp revoke` — and until slice 4, revoking
      // mid-flow did nothing to the flow already running: it was
      // grandfathered until it finished. Re-checking the gate per step
      // turns revoke into a real stop with a worst-case latency of one
      // step, and the flow returns cleanly with `stopped_by: 'cancelled'`
      // and everything it completed.
      //
      // Cheap enough to run per step: `checkCdpDirectGate` reads two small
      // local files, and the flow budget caps a run at 60s, which bounds
      // the number of checks to the low hundreds. Deliberately NOT cached —
      // the gate's own contract is that a revoked grant is visible to the
      // very next check, and a cache here would be exactly the staleness
      // window a kill switch must not have.
      //
      // A DETACHED flow additionally answers to `browser.flow_cancel` and
      // to its own 30-minute ceiling, both of which live in the
      // detached-flow registry — so on that path both questions are asked.
      // Revoking the grant still stops a detached flow, which matters: it
      // is the only lever a human at a terminal has here.
      const gateAllows = (): boolean => checkCdpDirectGate().ok;
      if (!detach) {
        const shouldCancel = (): boolean => !gateAllows();
        // Same relative-duration deadline the extension path honours. No
        // bridge timeout applies over cdp-direct, but the MCP client's own
        // call timeout still does, and a flow that outlives it loses its
        // partial state exactly as it would there.
        const deadlineAt =
          !dryRun && typeof p.deadline_ms === 'number' && Number.isFinite(p.deadline_ms)
            ? Date.now() + Math.max(0, p.deadline_ms)
            : undefined;
        const deps = buildCdpFlowDeps(
          client,
          shouldCancel,
          deadlineAt === undefined ? undefined : () => shouldCancel() || Date.now() >= deadlineAt,
        );
        return runFlow(
          rawSteps as FlowStep[],
          deadlineAt === undefined ? deps : { ...deps, deadlineAt },
          { dryRun },
        );
      }

      // ONE detached flow per tab — same rule, same reason, same error
      // shape as the extension path (see `handleFlow` in background.ts).
      const already = detachedFlowForTab(tabId);
      if (already) {
        throw new Error(
          `flow: a detached flow is already running on this tab (${already.flowId}). ` +
            `Wait for it, or stop it with browser.flow_cancel, before detaching another.`,
        );
      }
      const flow = registerDetachedFlow({ flowId, tabId, steps: rawSteps.length });
      // The gate branch cancels THROUGH the registry rather than short-
      // circuiting past it: `stopped_by: 'grant-revoked'` is the only thing
      // that tells the agent a human pulled the grant, as opposed to
      // `browser.flow_cancel` or the ceiling. Same reason the ceiling flips
      // its own reason inside `shouldStopDetachedFlow`.
      const shouldCancel = (): boolean => {
        if (shouldStopDetachedFlow(flow.flowId, Date.now())) return true;
        if (gateAllows()) return false;
        cancelDetachedFlow(flow.flowId, 'grant-revoked');
        return true;
      };
      // Deliberately floating: this IS detach. The result below goes back
      // now, the loop keeps running, and the agent's turn is free.
      void (async () => {
        let result: FlowResult | null = null;
        try {
          result = await runFlow(rawSteps as FlowStep[], {
            ...buildCdpFlowDeps(client, shouldCancel),
            onProgress: (progress) => {
              reportDetachedProgress(flow.flowId, progress);
            },
          });
        } catch {
          // A throw (dead CDP socket, closed tab) is a `failed` outcome,
          // recorded below from a null result. There is no caller left to
          // rethrow to.
        } finally {
          finishDetachedFlow(flow.flowId, result);
        }
      })();
      return {
        detached: true,
        started_at: flow.startedAt,
        steps: rawSteps.length,
        expires_at: flow.expiresAt,
      };
    }

    case 'flow_status': {
      const flowId = typeof p.flow_id === 'string' ? p.flow_id : '';
      if (flowId.length === 0) throw new Error('flow_status: flow_id required');
      return detachedFlowStatus(flowId);
    }

    case 'flow_cancel': {
      const flowId = typeof p.flow_id === 'string' ? p.flow_id : '';
      if (flowId.length === 0) throw new Error('flow_cancel: flow_id required');
      // In-process, so the flag flips synchronously and there is no wire
      // frame to send — the extension path's one asymmetry. The status
      // read that follows is the same one `browser.flow_cancel` returns on
      // either transport, so the two look identical to the agent.
      cancelDetachedFlow(flowId);
      return detachedFlowStatus(flowId);
    }

    default:
      // Reached only if a caller bypasses CDP_TOOL_SUPPORT's gate — defense
      // in depth, not a path browser-dispatch.ts's routing exercises.
      throw cdpUnsupportedToolError(tool);
  }
}
