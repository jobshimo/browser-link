/**
 * Detached-flow bookkeeping for the cdp-direct transport — the in-process
 * counterpart of the extension's `flow-registry.ts`.
 *
 * The two exist for the same reason and answer the same three questions
 * (`what is running on this tab`, `what is this flow doing`, `stop it`),
 * but they are deliberately NOT a shared module and not a verbatim copy
 * under the drift guard. The extension's version has to survive service
 * worker termination, so it persists records to `chrome.storage.session`
 * and reconciles them on restart; here there is nothing to survive — the
 * runner lives in this Node process, so if the process dies the flow dies
 * with it and there is no state left to be wrong about. That difference is
 * most of the extension file, and pretending the two are the same shape
 * would import a persistence model this side has no use for.
 *
 * What IS identical is the contract an agent sees: the same `flow_status`
 * payload keys, the same `'unknown'` answer for an id nobody recognises,
 * the same one-detached-flow-per-tab rule, the same 30-minute ceiling, and
 * exactly one summary `flow-finished` event per detached flow. On this
 * transport the event is added to `BridgeEventLog` directly (there is no
 * extension to push a `bridge.event` frame), through a sink `server.ts`
 * installs at startup.
 */

import type { FlowResult } from './flow.js';

/** Mirrors `MAX_DETACHED_FLOW_MS` in the extension's `flow-registry.ts` and
 * `MAX_DETACHED_FLOW_TIMEOUT_MS` in `tools/browser-dispatch.ts`. Kept in
 * sync manually — the three live in packages that share no module. */
export const MAX_DETACHED_FLOW_MS = 30 * 60_000;

/** How many finished detached flows keep their manifest addressable.
 * Oldest-first eviction. Unlike the extension's cap this is a memory bound
 * rather than a storage-quota one, but the reasoning is the same: the
 * access pattern is "the agent that launched it reads the manifest once". */
export const MAX_DETACHED_FLOW_RECORDS = 10;

export type FlowStopReason = 'cancelled' | 'expired' | 'grant-revoked';
export type FlowState = 'running' | 'completed' | 'cancelled' | 'failed' | 'expired' | 'unknown';

/** The wire payload `browser.flow_status` returns. Same keys the extension
 * produces (`flow-registry.ts`'s `FlowStatusPayload`) so an agent cannot
 * tell the two transports apart; the dispatcher stamps `tab_id` on top. */
export interface FlowStatusPayload {
  flow_id: string;
  state: FlowState;
  detached: boolean;
  started_at?: number;
  ended_at?: number;
  steps?: number;
  steps_completed?: number;
  iterations_completed?: number;
  stopped_by?: FlowStopReason;
  error?: string;
  cancelling?: true;
  expires_at?: number;
  manifest?: unknown[];
}

interface RunningFlow {
  flowId: string;
  tabId: string;
  startedAt: number;
  steps: number;
  expiresAt: number;
  cancelled: boolean;
  stopReason?: FlowStopReason;
  /** 1-based index of the step about to be dispatched, and of the repeat
   * iteration when one is running — `runFlow`'s `onProgress` shape. */
  step: number;
  iteration?: number;
}

interface FinishedFlow {
  flowId: string;
  tabId: string;
  state: Exclude<FlowState, 'running' | 'unknown'>;
  startedAt: number;
  endedAt: number;
  steps: number;
  stepsCompleted: number;
  iterationsCompleted?: number;
  stopReason?: FlowStopReason;
  error?: string;
  manifest: unknown[];
}

const running = new Map<string, RunningFlow>();
const finished = new Map<string, FinishedFlow>();

/** Where the one-per-flow summary event goes. Installed by `server.ts`
 * (`setCdpFlowEventSink`) rather than imported, so this module stays free
 * of a dependency on the bridge's event log — and so a build or test that
 * never wires it simply emits nothing instead of failing. */
export type FlowEventSink = (data: Record<string, unknown>) => void;
let eventSink: FlowEventSink | null = null;

export function setCdpFlowEventSink(sink: FlowEventSink | null): void {
  eventSink = sink;
}

/** The detached flow already running on this tab, if any. Returned rather
 * than a boolean so the rejection can NAME it — "busy" with no id leaves
 * the caller unable to inspect or stop what is blocking them. */
export function detachedFlowForTab(tabId: string): { flowId: string } | undefined {
  for (const flow of running.values()) {
    if (flow.tabId === tabId) return { flowId: flow.flowId };
  }
  return undefined;
}

export function registerDetachedFlow(input: {
  flowId: string;
  tabId: string;
  steps: number;
  now?: number;
}): RunningFlow {
  const startedAt = input.now ?? Date.now();
  const flow: RunningFlow = {
    flowId: input.flowId,
    tabId: input.tabId,
    startedAt,
    steps: input.steps,
    expiresAt: startedAt + MAX_DETACHED_FLOW_MS,
    cancelled: false,
    step: 0,
  };
  running.set(flow.flowId, flow);
  return flow;
}

/** Record progress — bound to `runFlow`'s `onProgress`. */
export function reportDetachedProgress(
  flowId: string,
  progress: { step: number; iteration?: number },
): void {
  const flow = running.get(flowId);
  if (!flow) return;
  flow.step = progress.step;
  flow.iteration = progress.iteration;
}

/** Flip a running flow to cancelled. Returns whether THIS call is what
 * flipped it — an unknown id, a finished one, or a second request is a
 * clean no-op, exactly as on the extension path. */
export function cancelDetachedFlow(flowId: string, reason: FlowStopReason = 'cancelled'): boolean {
  const flow = running.get(flowId);
  if (!flow || flow.cancelled) return false;
  flow.cancelled = true;
  flow.stopReason = reason;
  return true;
}

/** The per-step question, ceiling included: cancelled, or past the
 * 30-minute deadline. Flipping the reason HERE is what makes an expiry
 * report as `'expired'` instead of being indistinguishable from a human
 * pressing Stop. */
export function shouldStopDetachedFlow(flowId: string, now: number): boolean {
  const flow = running.get(flowId);
  // An id the registry has forgotten is not "still allowed to run" — see
  // the extension registry's `shouldStop` for the same reasoning.
  if (!flow) return true;
  if (flow.cancelled) return true;
  if (now >= flow.expiresAt) {
    flow.cancelled = true;
    flow.stopReason = 'expired';
    return true;
  }
  return false;
}

/** Sum the completed iterations of every `repeat` step. Same derivation the
 * extension uses, over the same `results[]`. */
function countIterations(results: readonly unknown[]): number | undefined {
  let total: number | undefined;
  for (const entry of results) {
    if (typeof entry !== 'object' || entry === null) continue;
    const value = (entry as { iterations_completed?: unknown }).iterations_completed;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

/**
 * Retire a finished detached flow: move it to the finished map (manifest
 * included, addressable by id), enforce the record cap, and emit the ONE
 * summary event this flow gets — never one per iteration, which with
 * `MAX_EVENTS = 200` would evict the entire event log on a single long run.
 */
export function finishDetachedFlow(
  flowId: string,
  result: FlowResult | null,
  now = Date.now(),
): void {
  const flow = running.get(flowId);
  if (!flow) return;
  running.delete(flowId);

  let state: FinishedFlow['state'];
  let stepsCompleted: number;
  let manifest: unknown[] = [];
  let error: string | undefined;
  let iterationsCompleted: number | undefined;
  if (result === null) {
    // The runner threw (the CDP socket died, the tab closed). No result to
    // read, so fall back to the last progress report: step N announced
    // means N-1 finished.
    state = 'failed';
    stepsCompleted = Math.max(0, flow.step - 1);
  } else if (!result.ok) {
    state = 'failed';
    stepsCompleted = result.steps_completed;
    error = result.error;
  } else {
    manifest = result.results;
    stepsCompleted = result.steps_completed;
    iterationsCompleted = countIterations(result.results);
    state =
      result.stopped_by === 'cancelled'
        ? flow.stopReason === 'expired'
          ? 'expired'
          : 'cancelled'
        : 'completed';
  }

  finished.set(flowId, {
    flowId,
    tabId: flow.tabId,
    state,
    startedAt: flow.startedAt,
    endedAt: now,
    steps: flow.steps,
    stepsCompleted,
    ...(iterationsCompleted === undefined ? {} : { iterationsCompleted }),
    ...(flow.stopReason === undefined || state === 'completed'
      ? {}
      : { stopReason: flow.stopReason }),
    ...(error === undefined ? {} : { error }),
    manifest,
  });
  evictOldFinishedFlows();

  eventSink?.({
    tab_id: flow.tabId,
    flow_id: flowId,
    state,
    detached: true,
    steps: flow.steps,
    steps_completed: stepsCompleted,
    ...(iterationsCompleted === undefined ? {} : { iterations_completed: iterationsCompleted }),
    duration_ms: Math.max(0, now - flow.startedAt),
    ...(flow.stopReason === undefined || state === 'completed'
      ? {}
      : { stopped_by: flow.stopReason }),
    manifest_available: true,
  });
}

function evictOldFinishedFlows(): void {
  if (finished.size <= MAX_DETACHED_FLOW_RECORDS) return;
  const oldestFirst = [...finished.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const flow of oldestFirst.slice(0, finished.size - MAX_DETACHED_FLOW_RECORDS)) {
    finished.delete(flow.flowId);
  }
}

/** Status of any flow this process knows about, running or finished.
 * `'unknown'` for anything else — never an error, for the same reason
 * cancelling an unknown id is a no-op. */
export function detachedFlowStatus(flowId: string): FlowStatusPayload {
  const live = running.get(flowId);
  if (live) {
    return {
      flow_id: flowId,
      state: 'running',
      detached: true,
      started_at: live.startedAt,
      steps: live.steps,
      // The runner reports the step it is ABOUT to dispatch.
      steps_completed: Math.max(0, live.step - 1),
      ...(live.iteration === undefined
        ? {}
        : { iterations_completed: Math.max(0, live.iteration - 1) }),
      ...(live.cancelled ? { cancelling: true as const } : {}),
      expires_at: live.expiresAt,
    };
  }
  const done = finished.get(flowId);
  if (done) {
    return {
      flow_id: flowId,
      state: done.state,
      detached: true,
      started_at: done.startedAt,
      ended_at: done.endedAt,
      steps: done.steps,
      steps_completed: done.stepsCompleted,
      ...(done.iterationsCompleted === undefined
        ? {}
        : { iterations_completed: done.iterationsCompleted }),
      ...(done.stopReason === undefined ? {} : { stopped_by: done.stopReason }),
      ...(done.error === undefined ? {} : { error: done.error }),
      manifest: done.manifest,
    };
  }
  return { flow_id: flowId, state: 'unknown', detached: false };
}

/** Drop every tracked flow and unwire the event sink. Test-only — module
 * state is per-process by design and nothing on an agent-reachable path
 * clears it. */
export function resetDetachedFlowsForTest(): void {
  running.clear();
  finished.clear();
  eventSink = null;
}
