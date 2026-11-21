/**
 * The cdp-direct tool-routing adapter: implements the same call surface the
 * WS-bridge path (`bridge/ws-bridge.ts`'s `sendToolRequest`) uses —
 * `callCdpTool(tabId, tool, params, timeoutMs?) => Promise<unknown>` — but
 * executes each wire-level tool directly over a raw CDP-over-WebSocket
 * connection (`./client.ts`) instead of routing through the extension.
 *
 * Every wire tool runs through core's tool registry (`dispatchTool`, the
 * generated mirror of core's `tools/`, outcome mapped by
 * `./tool-outcome.ts`), the same bodies the extension runs; the flow tools
 * run on cdp-direct's own flow model (`./flow-control.ts`). A tool whose
 * requirements cdp-direct does not provide (`downloads`,
 * `content-settings`) is refused there with the unsupported text
 * (`./support.ts`). The wire-level contract is
 * identical: a resolved promise is a wire `ok:true` result, a rejected
 * promise is a wire `ok:false` (the rejection's message is the error
 * string) — exactly what `sendToolRequest` produces for the extension path,
 * so `tools/browser-dispatch.ts` cannot tell the two transports apart by
 * shape.
 */
import { loadConfig, sanitizeCdpPort } from '../config.js';
import { checkCdpDirectGate } from './gate.js';
import {
  buildTargetWsUrl,
  CDP_TAB_ID_PREFIX,
  cdpTargetIdFromTabId,
  isDrivablePageTarget,
} from './targets.js';
import { CdpClient, CdpCommandTimeoutError } from './client.js';
import type { DialogEventSink, PendingDialog } from '../generated/core/session/dialog-intake.js';
import { createCdpDialogWatch } from './adapters/cdp-dialog-watch.js';
import { createCdpCaptureWatch } from './adapters/cdp-capture-watch.js';
import type { CaptureBuffers } from '../generated/core/session/capture-intake.js';
import { CDP_DIRECT_PROVIDES, cdpUnsupportedToolError } from './support.js';
import { buildSnapshotJs } from '../generated/core/inpage/builders.js';
import { systemClock } from './adapters/system-clock.js';
import { createCdpClientSession } from './adapters/cdp-client-session.js';
import { createCdpPageInfo } from './adapters/cdp-page-info.js';
import { createPageDriver, type PageDriverHandle } from '../generated/core/session/page-driver.js';
import type { ObserverMessageOutcome } from '../generated/core/support/observer-host.js';
import { performClick } from '../generated/core/actions/perform-click.js';
import { performDrag } from '../generated/core/actions/perform-drag.js';
import { performFind } from '../generated/core/actions/perform-find.js';
import { performPress } from '../generated/core/actions/perform-press.js';
import { performType } from '../generated/core/actions/perform-type.js';
import { performWaitFor } from '../generated/core/actions/perform-wait-for.js';
import { TOOL_REGISTRY } from '../generated/core/tools/catalog.js';
import { dispatchTool } from '../generated/core/tools/registry.js';
import type { ToolDeps } from '../generated/core/tools/requirement.js';
import { cdpToolResult } from './tool-outcome.js';
import { cdpFlowCancel, createCdpFlowControl } from './flow-control.js';
import type { FlowDeps } from '../generated/core/flow/flow-engine.js';
import { DEFAULT_IDLE_TTL_MINUTES } from '../generated/core/policies/idle-rules.js';

// The v1 support table and what cdp-direct provides live in `./support.ts`
// (importable by `tools/browser-dispatch.ts` without pulling
// in this whole transport) — re-exported here so existing callers of
// `cdp/transport.ts` keep working.
export { CDP_TOOL_SUPPORT, isCdpToolSupported } from './support.js';
export { CDP_DIRECT_PROVIDES };
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

/** Idle connections holding no state are closed after this long unused — keeps a long-lived
 * server process from accumulating an unbounded number of open WebSockets
 * to targets an agent stopped touching hours ago. `let`, not `const`:
 * `setIdleCleanupConfigForTest` overrides both for tests, where waiting
 * out the real 5-minute window is not practical. */
const DEFAULT_IDLE_CLEANUP_MS = 5 * 60_000;
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60_000;
let idleCleanupMs = DEFAULT_IDLE_CLEANUP_MS;
let idleSweepIntervalMs = DEFAULT_IDLE_SWEEP_INTERVAL_MS;

/** Gate A (parity P5): a connection whose capture buffers hold an entry is
 * kept this long without a tool call on its tab, the extension's default
 * idle TTL; fixed, not a setting. The console replay of the dial fills the
 * buffers within seconds on almost any page that logs, so almost every used
 * tab falls under it. */
const CAPTURE_IDLE_CLEANUP_MS = DEFAULT_IDLE_TTL_MINUTES * 60_000;

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

/** How long `client` may go without a tool call before the sweep closes it
 * (gate A): never while a JavaScript dialog it saw open is pending; 30
 * minutes while its capture buffers hold an entry; otherwise the 5-minute
 * window. The buffers are dropped with the connection. A connection whose
 * socket already closed (the tab is gone) keeps nothing: only the 5-minute
 * window applies, so the sweep removes it. */
function idleLimitOf(client: CdpClient): number {
  if (!client.isOpen) return idleCleanupMs;
  if (dialogs.get(client)?.isOpen() === true) return Number.POSITIVE_INFINITY;
  const capture = captures.get(client);
  const holdsEntries =
    capture !== undefined && (capture.consoleBuffer.length > 0 || capture.networkOrder.length > 0);
  return holdsEntries ? Math.max(idleCleanupMs, CAPTURE_IDLE_CLEANUP_MS) : idleCleanupMs;
}

/** Close every connection unused for longer than its idle limit at `now`
 * (`idleLimitOf`). A connection a running flow holds is skipped; one whose
 * flow outlived its bound counts as used at that bound. Capture events do
 * not count as use: only a tool call on the tab does. */
function sweepIdleConnections(now: number): void {
  for (const [targetId, conn] of connections) {
    let lastActiveAt = conn.lastUsedAt;
    let held = false;
    for (const hold of flowHolds.get(targetId) ?? []) {
      if (now < hold.until) held = true;
      else lastActiveAt = Math.max(lastActiveAt, hold.until);
    }
    if (held) continue;
    if (now - lastActiveAt > idleLimitOf(conn.client)) {
      connections.delete(targetId);
      void closeConnection(conn.client, targetId);
    }
  }
}

/**
 * The actual dial: open the WebSocket, re-validate the target, enable
 * `Page`, `Log` and `Network`, install the page observer. Extracted out of `getConnection` so concurrent callers can share
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
  // The connection's pending dialog, fed by core's dialog intake (parity
  // P3). Subscribed BEFORE Page.enable: the client delivers frames in
  // order, so an opening event that arrives right behind the Page.enable
  // answer cannot slip past it. Only a connection whose Page.enable
  // completed before a dialog opened ever receives its opening event
  // (experiment X1).
  dialogs.set(client, createCdpDialogWatch(client, cdpDialogSink(targetId)));
  // The connection's console and network buffers, fed by core's capture
  // intake (parity P5). Subscribed BEFORE Log.enable and the observer's
  // Runtime.enable: Chrome follows each answer with a replay of the page's
  // earlier log and console entries (lab X2), which would otherwise be
  // lost. The buffers die with the connection; a redial's own replay
  // refills fresh ones, so nothing is held twice.
  captures.set(client, createCdpCaptureWatch(client, systemClock));
  // Page.enable unlocks Page.loadEventFired (navigate's wait_for_load) and
  // the dialog events. Runtime.evaluate and Input.* commands work without
  // their own domain being explicitly enabled. The page observer enables
  // Runtime itself, for `Runtime.bindingCalled`.
  await enablePage(client);
  // Log and Network feed the capture buffers (console, network, a
  // network_url wait) and let Network.getResponseBody answer for requests
  // this connection saw (network_body).
  await enableCapture(client);
  // The page observer, as the extension installs it in `connectTab`.
  // Non-fatal: on failure the connection is used as before and actions
  // report `settle.changes: null` with `observer-unavailable`. `list_tabs`
  // reads target info live, so a top-document message only updates the
  // driver's mirror.
  const driver = newPageDriver(client);
  drivers.set(client, driver);
  const installed = await driver.install({
    enableRuntime: true,
    onTopDocument: (outcome) => {
      noteTopDocument(client, outcome);
    },
  });
  if (!installed.ok) {
    console.warn('browser-link: cdp-direct page observer not installed', installed.error);
  }
  return { client, lastUsedAt: Date.now() };
}

/** How long the dial waits for `Page.enable`: the client's default
 * per-command timeout. `let` for `setPageEnableTimeoutForTest`. */
const DEFAULT_PAGE_ENABLE_TIMEOUT_MS = 15_000;
let pageEnableTimeoutMs = DEFAULT_PAGE_ENABLE_TIMEOUT_MS;

/** The text of `PageEnableTimeoutError`. It does not claim a dialog: a hung
 * or busy renderer gives the same timeout. */
export function pageEnableTimeoutMessage(timeoutMs: number): string {
  return (
    `cdp-direct: the page did not answer Page.enable within ${String(timeoutMs / 1000)} s; ` +
    'a JavaScript dialog opened while cdp-direct had no connection may be blocking it, ' +
    'or the page is unresponsive; close any dialog in the browser and retry.'
  );
}

/** The dial's `Page.enable` got no answer in time. Experiment X1: a page
 * showing a JavaScript dialog that opened while no cdp-direct connection
 * existed never answers it, and that dialog cannot be answered over
 * cdp-direct. */
export class PageEnableTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(pageEnableTimeoutMessage(timeoutMs));
    this.name = 'PageEnableTimeoutError';
  }
}

/** Send the dial's `Page.enable`. Its timeout (a `CdpCommandTimeoutError`,
 * never matched by text) becomes `PageEnableTimeoutError`; any failure
 * closes the client, which is never cached. */
async function enablePage(client: CdpClient): Promise<void> {
  try {
    await client.send('Page.enable', {}, pageEnableTimeoutMs);
  } catch (err) {
    client.close();
    if (err instanceof CdpCommandTimeoutError) throw new PageEnableTimeoutError(err.timeoutMs);
    throw err;
  }
}

/** Send the dial's `Log.enable` and `Network.enable`. A failure closes the
 * client, which is never cached, as for `Page.enable`. */
async function enableCapture(client: CdpClient): Promise<void> {
  try {
    await client.send('Log.enable');
    await client.send('Network.enable');
  } catch (err) {
    client.close();
    throw err;
  }
}

/** Where the dialog events of a `cdp:` tab go: the server's bridge event
 * log, installed by `server.ts` (`setCdpBridgeEventSink`) as the flow sink
 * is (`detached-flows.ts`), so a build or test that never wires it emits
 * nothing. */
export type CdpBridgeEventSink = (eventKind: string, data: Record<string, unknown>) => void;
let bridgeEventSink: CdpBridgeEventSink | null = null;

export function setCdpBridgeEventSink(sink: CdpBridgeEventSink | null): void {
  bridgeEventSink = sink;
}

/** The dialog intake's sink for one connection, bound to its `cdp:` tab
 * id: the event carries `tab_id` as the extension's `bridge.event` does
 * once the bridge adds it. */
function cdpDialogSink(targetId: string): DialogEventSink {
  const tabId = `${CDP_TAB_ID_PREFIX}${targetId}`;
  return {
    emit: (event) => {
      bridgeEventSink?.(event.eventKind, { ...event.data, tab_id: tabId });
    },
  };
}

/** The page driver of each connection (core's `session/page-driver.ts`):
 * evaluation, keys, settle, and the page observer. Keyed by client so the
 * perform* helpers, which only get the client, can reach it. */
const drivers = new WeakMap<CdpClient, PageDriverHandle>();

/** The pending dialog of each dialed connection (its `DialogWatch`). A
 * client that was never dialed (tests) has none, and its clicks do not
 * watch dialogs, as before P3. */
const dialogs = new WeakMap<CdpClient, PendingDialog>();

/** The capture buffers of each dialed connection (its `CaptureWatch`). */
const captures = new WeakMap<CdpClient, CaptureBuffers>();

/** The page identity (build, view_sig) the top document of each dialed
 * connection last reported (parity P6, G12). Dropped when a new top document
 * starts, so a listing never shows the identity of a page that is gone. */
const docIdentities = new WeakMap<CdpClient, { build: string; view_sig: string }>();

function noteTopDocument(client: CdpClient, outcome: ObserverMessageOutcome): void {
  if (outcome.kind === 'doc_start') docIdentities.delete(client);
  else if (outcome.kind === 'doc_info') {
    docIdentities.set(client, { build: outcome.build, view_sig: outcome.view_sig });
  }
}

/**
 * Add build and view_sig to the listed cdp tabs that already have a live
 * connection and whose top document reported them. Never dials and never runs
 * script in a page: a tab without a connection, or one that has not reported,
 * is listed as it was.
 */
export function withCdpFootprint<T extends { tab_id: string }>(
  tabs: readonly T[],
): (T & { build?: string; view_sig?: string })[] {
  return tabs.map((tab) => {
    const targetId = cdpTargetIdFromTabId(tab.tab_id);
    const conn = targetId === null ? undefined : connections.get(targetId);
    const identity = conn?.client.isOpen ? docIdentities.get(conn.client) : undefined;
    return identity ? { ...tab, ...identity } : tab;
  });
}

function newPageDriver(client: CdpClient, commandTimeoutMs?: number): PageDriverHandle {
  return createPageDriver({
    session: createCdpClientSession(client, commandTimeoutMs),
    page: createCdpPageInfo(client, systemClock),
    clock: systemClock,
    dialogs: dialogs.get(client),
  });
}

/** The connection's page driver; a client that was never dialled (tests)
 * gets a fresh one whose observer is not installed, as before slice 9. */
function pageDriver(client: CdpClient): PageDriverHandle {
  return drivers.get(client) ?? newPageDriver(client);
}

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
    'dialog-input': driver.dialog,
    clock: systemClock,
    dialogs: driver.dialogs,
    captureBuffers: captures.get(client),
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
  pageEnableTimeoutMs = DEFAULT_PAGE_ENABLE_TIMEOUT_MS;
}

/** Test-only: how long the dial waits for `Page.enable` (15 s by default);
 * restored by `resetConnectionsForTest`. Not on any agent-reachable path. */
export function setPageEnableTimeoutForTest(timeoutMs: number): void {
  pageEnableTimeoutMs = timeoutMs;
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

/** Test-only: how many connections the cache holds now (dead ones not yet
 * removed included). Not on any agent-reachable path. */
export function cachedConnectionCountForTest(): number {
  return connections.size;
}

// === Flow deps ==============================================================

/** The perform* bindings `runFlow` needs over one CDP connection, in one
 * place so the foreground run, the dry-run projection and the detached run
 * cannot drift apart — the role the extension's `app/flow-control.ts`
 * `steps` plays there. */
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
    // Bound as the extension's flow steps bind it (`app/flow-control.ts`): the
    // connection's page driver gives the evaluator, the pointer, the drag
    // input and the CDP event wait, so a flow drag step runs the same body as
    // the standalone browser.drag.
    performDrag: (dp) => {
      const { evaluator, pointer, drag, events } = pageDriver(client);
      return performDrag({ evaluator, pointer, drag, events, clock: systemClock }, dp);
    },
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
  // Every wire tool runs through core's registry (design 3.3); its outcome
  // is returned or thrown by `cdpToolResult` (3.4), and a tool the registry
  // does not know is refused with the unsupported text.
  const entry = TOOL_REGISTRY.get(tool);
  const gateAllows = (): boolean => checkCdpDirectGate().ok;
  const deps: ToolDeps = {
    ...actionDeps(client, entry?.commandTimeout === 'call-budget' ? timeoutMs : undefined),
    flows: createCdpFlowControl({
      tabId,
      clock: systemClock,
      steps: ({ hidePasswordValues, stopWaiting }) =>
        buildCdpFlowDeps(client, () => !gateAllows(), stopWaiting, hidePasswordValues),
      gateAllows,
      hold: (until) => holdConnectionForFlow(targetId, until),
    }),
    'flow-cancel': cdpFlowCancel,
  };
  return cdpToolResult(
    await dispatchTool(TOOL_REGISTRY, CDP_DIRECT_PROVIDES, deps, 'cdp-direct', tool, params),
  );
}
