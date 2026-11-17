/**
 * The cdp-direct tool-routing adapter: implements the same call surface the
 * WS-bridge path (`bridge/ws-bridge.ts`'s `sendToolRequest`) uses —
 * `callCdpTool(tabId, tool, params, timeoutMs?) => Promise<unknown>` — but
 * executes each wire-level tool directly over a raw CDP-over-WebSocket
 * connection (`./client.ts`) instead of routing through the extension.
 *
 * Mirrors `packages/extension/src/background.ts`'s `handleTool` switch
 * case-for-case, using the SAME in-page builder strings
 * (`../generated/core/inpage/builders.ts`, the generated mirror of the core
 * module) and the SAME `browser.flow` step engine (generated from core's
 * `flow/flow-engine.ts`). `find` and `click` (slice 10), `type` and
 * `press` (slice 11), `wait_for` (slice 13), `drag` (slice 14) and `ping`,
 * `navigate`, `snapshot`, `state`, `screenshot`, `evaluate`,
 * `canvas_screenshot`, `console`, `network` and `network_body` (slice 15)
 * run through core's tool registry (`dispatchTool`, outcome mapped by
 * `./tool-outcome.ts`); `drag`, `canvas_screenshot`, `console`, `network`
 * and `network_body` are refused there, since cdp-direct does not provide
 * `drag`, `canvas`, `capture-buffers` or `response-bodies`. The wire-level contract is
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
import { withValuesHiddenNote, buildSnapshotJs } from '../generated/core/inpage/builders.js';
import { systemClock } from './adapters/system-clock.js';
import { createCdpClientSession } from './adapters/cdp-client-session.js';
import { createCdpPageInfo } from './adapters/cdp-page-info.js';
import { createPageDriver, type PageDriverHandle } from '../generated/core/session/page-driver.js';
import { performClick } from '../generated/core/actions/perform-click.js';
import { performFind } from '../generated/core/actions/perform-find.js';
import { performPress } from '../generated/core/actions/perform-press.js';
import { performType } from '../generated/core/actions/perform-type.js';
import { performWaitFor } from '../generated/core/actions/perform-wait-for.js';
import { TOOL_REGISTRY } from '../generated/core/tools/catalog.js';
import { dispatchTool } from '../generated/core/tools/registry.js';
import type { Requirement, ToolDeps } from '../generated/core/tools/requirement.js';
import { cdpToolResult } from './tool-outcome.js';
import {
  cancelDetachedFlow,
  detachedFlowForTab,
  detachedFlowStatus,
  finishDetachedFlow,
  MAX_DETACHED_FLOW_MS,
  registerDetachedFlow,
  reportDetachedProgress,
  shouldStopDetachedFlow,
} from './detached-flows.js';
import {
  runFlow,
  type FlowDeps,
  type FlowResult,
  type FlowStep,
} from '../generated/core/flow/flow-engine.js';

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
    sweepIdleConnections(Date.now());
  }, idleSweepIntervalMs);
  cleanupTimer.unref();
}

/**
 * Running flows holding a connection's idle clock, keyed by targetId (owner
 * decision D1). A flow's steps use the client directly and never pass
 * through `getConnection`, so without a hold the sweep would close the
 * socket under a flow nobody else touches. Each hold carries the flow's own
 * maximum end (`until`): past it the hold no longer counts.
 */
const flowHolds = new Map<string, Set<{ until: number }>>();

/** Hold `targetId`'s connection open while a flow runs, at most until
 * `until`. The returned release restarts the idle window from the flow's
 * last step (now, or the bound if the flow outlived it). */
function holdConnectionForFlow(targetId: string, until: number): () => void {
  const hold = { until };
  let holds = flowHolds.get(targetId);
  if (!holds) {
    holds = new Set();
    flowHolds.set(targetId, holds);
  }
  holds.add(hold);
  const owner = holds;
  return () => {
    owner.delete(hold);
    if (owner.size === 0 && flowHolds.get(targetId) === owner) flowHolds.delete(targetId);
    const conn = connections.get(targetId);
    const lastStepAt = Math.min(Date.now(), hold.until);
    if (conn && lastStepAt > conn.lastUsedAt) conn.lastUsedAt = lastStepAt;
  };
}

/** Close every connection unused for longer than the idle window at `now`.
 * A connection a running flow holds is skipped; one whose flow outlived its
 * bound counts as used at that bound. */
function sweepIdleConnections(now: number): void {
  for (const [targetId, conn] of connections) {
    let lastActiveAt = conn.lastUsedAt;
    let held = false;
    for (const hold of flowHolds.get(targetId) ?? []) {
      if (now < hold.until) held = true;
      else lastActiveAt = Math.max(lastActiveAt, hold.until);
    }
    if (held) continue;
    if (now - lastActiveAt > idleCleanupMs) {
      connections.delete(targetId);
      void closeConnection(conn.client, targetId);
    }
  }
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
  // Runtime itself, for `Runtime.bindingCalled`.
  await client.send('Page.enable');
  // The page observer, as the extension installs it in `connectTab`.
  // Non-fatal: on failure the connection is used as before and actions
  // report `settle.changes: null` with `observer-unavailable`. cdp-direct has
  // no bridge events and `list_tabs` reads target info live, so a
  // top-document message only updates the driver's mirror.
  const driver = newPageDriver(client);
  drivers.set(client, driver);
  const installed = await driver.install({ enableRuntime: true });
  if (!installed.ok) {
    console.warn('browser-link: cdp-direct page observer not installed', installed.error);
  }
  return { client, lastUsedAt: Date.now() };
}

/** The page driver of each connection (core's `session/page-driver.ts`):
 * evaluation, keys, settle, and the page observer. Keyed by client so the
 * perform* helpers, which only get the client, can reach it. */
const drivers = new WeakMap<CdpClient, PageDriverHandle>();

function newPageDriver(client: CdpClient, commandTimeoutMs?: number): PageDriverHandle {
  return createPageDriver({
    session: createCdpClientSession(client, commandTimeoutMs),
    page: createCdpPageInfo(client, systemClock),
    clock: systemClock,
  });
}

/** The connection's page driver; a client that was never dialled (tests)
 * gets a fresh one whose observer is not installed, as before slice 9. */
function pageDriver(client: CdpClient): PageDriverHandle {
  return drivers.get(client) ?? newPageDriver(client);
}

/** What cdp-direct provides to the tool registry (design 3.3). It does not
 * provide `capture-buffers`: it never enables the Network domain or keeps
 * console messages, so a `network_url` wait, `browser.console` and
 * `browser.network` are refused; nor `drag`, so `browser.drag` is refused;
 * nor `canvas`, so `browser.canvas_screenshot` is refused; nor
 * `response-bodies`, so `browser.network_body` is refused (all v1 scope;
 * changing any is a behavior change). */
export const CDP_DIRECT_PROVIDES: ReadonlySet<Requirement> = new Set<Requirement>([
  'evaluator',
  'keyboard',
  'pointer',
  'settler',
  'cdp-events',
  'page',
  'navigator',
  'screen-capture',
]);

/** What the core actions and the registry handlers use on one connection.
 * With `evaluateTimeoutMs`, the evaluator's `Runtime.evaluate` has that
 * per-command timeout instead of the client's 15s default (see
 * `callCdpTool`: an entry that declares `commandTimeout: 'call-budget'`). */
function actionDeps(client: CdpClient, evaluateTimeoutMs?: number): ToolDeps {
  const driver = pageDriver(client);
  const { evaluator, keyboard, pointer, drag, events, settler, page } = driver;
  return {
    evaluator:
      evaluateTimeoutMs === undefined
        ? evaluator
        : newPageDriver(client, evaluateTimeoutMs).evaluator,
    keyboard,
    pointer,
    drag,
    'cdp-events': events,
    settler,
    page,
    navigator: driver.navigator,
    'screen-capture': driver.screen,
    'response-bodies': driver.responses,
    clock: systemClock,
  };
}

/**
 * Best-effort observer removal, then close the socket. Never throws. The
 * in-page teardown is skipped when a newer connection to the same target
 * already exists: the page holds one observer instance, which that
 * connection's install left in place (equal version), so tearing it down
 * here would leave the newer connection without an observer.
 */
async function closeConnection(client: CdpClient, targetId: string): Promise<void> {
  if (client.isOpen) {
    await drivers
      .get(client)
      ?.uninstall(() => !connections.has(targetId) && !inFlight.has(targetId));
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
  flowHolds.clear();
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

/** Test-only: run one idle sweep as if the clock read `now`, so a test can
 * step past the real 5-minute window without waiting for it. */
export function sweepIdleConnectionsForTest(now: number): void {
  sweepIdleConnections(now);
}

// === Flow deps ==============================================================

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
  /** The user's hide-password-values setting (owner decision D12): find
   * steps and the recovery snapshot hide password values too. */
  hidePasswordValues = false,
): Omit<FlowDeps, 'onProgress'> {
  return {
    performFind: (fp) =>
      performFind(actionDeps(client), { ...fp, hide_password_values: hidePasswordValues }),
    performClick: (cp) => performClick(actionDeps(client), cp),
    performType: (tp) => performType(actionDeps(client), tp),
    performPress: (pp) => performPress(actionDeps(client), pp),
    performWaitFor: (wp) => performWaitFor(actionDeps(client), wp, shouldStopWaiting),
    shouldCancel,
    clock: systemClock,
    // Drag is out of cdp-direct's v1 scope (CDP_TOOL_SUPPORT maps it to
    // false, and CDP_DIRECT_PROVIDES lacks `drag`), so a flow drag step fails fast at this step with the exact
    // error the standalone browser.drag returns on a cdp: tab — naming the
    // extension transport as the fallback.
    performDrag: () =>
      Promise.resolve({ ok: false as const, error: cdpUnsupportedToolError('drag').message }),
    buildRecoverySnapshot: () =>
      pageDriver(client).evaluator.evaluate(
        buildSnapshotJs({
          only_interactive: true,
          max_interactive: 40,
          hide_password_values: hidePasswordValues,
        }),
      ),
  };
}

// === Tool dispatch ==========================================================

interface TargetInfoResult {
  targetInfo: { title?: string; url?: string; type?: string };
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
 * timeout (see client.ts), the page's `armLoadWait` caps navigation's load wait at 20s,
 * `performWaitFor` clamps its own poll loop to <=30s, and `runFlow`'s budget
 * was already validated <=60s upstream. Wrapping the whole call in a second
 * timer would only add a redundant, harder-to-reason-about failure mode (an
 * outer reject while an inner CDP command is still in flight and will settle
 * on its own bound). The one consumer is `evaluate`, whose single
 * `Runtime.evaluate` command runs caller-supplied JS for a caller-controlled
 * duration — there the budget IS that command's own per-command timeout
 * (replacing the 15s default, still no outer race): its registry entry
 * declares `commandTimeout: 'call-budget'`, so the evaluator the registry
 * gets for it sends through a session with that timeout,
 * so `browser.evaluate`'s `timeout_ms` reaches cdp-direct tabs too and its
 * timeout text (`cdp-direct: command "Runtime.evaluate" timed out after
 * Nms`) is the client's own. Kept in the signature for shape-parity with
 * `callBrowserTool` for every other tool.
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
  // A registered tool (design 3.3) runs through core; its outcome is
  // returned or thrown by `cdpToolResult` (3.4).
  const entry = TOOL_REGISTRY.get(tool);
  if (entry) {
    return cdpToolResult(
      await dispatchTool(
        TOOL_REGISTRY,
        CDP_DIRECT_PROVIDES,
        actionDeps(client, entry.commandTimeout === 'call-budget' ? timeoutMs : undefined),
        'cdp-direct',
        tool,
        params,
      ),
    );
  }
  const p = (params ?? {}) as Record<string, unknown>;

  switch (tool) {
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
      // Strict `=== true`: the user's hide-password-values setting (D12).
      const hidePasswordValues = p.hide_password_values === true;

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
          hidePasswordValues,
        );
        // Owner decision D1: the idle sweep must not cut a running flow. A
        // dry run only probes and needs no hold. Bounded by the flow's own
        // deadline; without one (a caller that sent none) by the longest
        // any flow may run.
        const release = dryRun
          ? undefined
          : holdConnectionForFlow(targetId, deadlineAt ?? Date.now() + MAX_DETACHED_FLOW_MS);
        let ran: FlowResult;
        try {
          ran = await runFlow(
            rawSteps as FlowStep[],
            deadlineAt === undefined ? deps : { ...deps, deadlineAt },
            { dryRun },
          );
        } finally {
          release?.();
        }
        return withValuesHiddenNote(ran, hidePasswordValues);
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
      // Owner decision D1, bounded by the detached ceiling.
      const release = holdConnectionForFlow(targetId, flow.expiresAt);
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
            ...buildCdpFlowDeps(client, shouldCancel, shouldCancel, hidePasswordValues),
            onProgress: (progress) => {
              reportDetachedProgress(flow.flowId, progress);
            },
          });
        } catch {
          // A throw (dead CDP socket, closed tab) is a `failed` outcome,
          // recorded below from a null result. There is no caller left to
          // rethrow to.
        } finally {
          release();
          finishDetachedFlow(flow.flowId, result);
        }
      })();
      return withValuesHiddenNote(
        {
          detached: true,
          started_at: flow.startedAt,
          steps: rawSteps.length,
          expires_at: flow.expiresAt,
        },
        hidePasswordValues,
      );
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
