/**
 * The extension's `FlowControl` (core `flow/flow-control.ts`, design 3.3,
 * revision 11): the flow tools on one tab over the worker's `FlowRegistry`
 * (the kill switch, the foreground deadlines, the popup's running list) and
 * `FlowHistory` (each tab's history and the detached flows' records). Built
 * per tool call and holds no state of its own: the state lives in the
 * registry and the history it receives. The extension gives no
 * `FlowCancel`: it cancels through the `tool.cancel` frame and the popup.
 */
import {
  buildSnapshotJs,
  MAX_DETACHED_FLOW_MS,
  performClick,
  performDrag,
  performFind,
  performPress,
  performType,
  performWaitFor,
  toFlowStatus,
  type Clock,
  type FlowControl,
  type FlowHistory,
  type FlowRegistry,
  type FlowResult,
  type FlowStepDeps,
  type PageDriverHandle,
  type ToolDeps,
} from '@browser-link/core';

export interface ExtensionFlowControlDeps {
  tabId: number;
  registry: FlowRegistry;
  history: FlowHistory;
  clock: Clock;
  /** The title Chrome shows for a tab (the `chrome-tab-title` adapter). */
  tabTitle(tabId: number): Promise<string | undefined>;
  /** A step's deps on this tab, re-read at each step; `waitDeps` adds the
   * tab's capture buffers, which only `wait_for` reads. */
  stepDeps(): ToolDeps;
  waitDeps(): ToolDeps;
  /** The tab's page driver, re-read at each step. */
  driver(): PageDriverHandle;
  /** Restart a tab's idle window from a flow's end (owner decision D1). */
  flowEnded(tabId: number, endedAt: number): void;
}

/** Fallback id for a `browser.flow` that arrived without one (a server
 * older than this extension). `crypto.randomUUID` is available in the MV3
 * service worker; the `flow_` prefix keeps a locally-minted id visually
 * distinguishable from a server-minted one in the popup. */
function newFlowId(): string {
  return `flow_${crypto.randomUUID()}`;
}

/** The text of a detached launch whose record would not store. */
export const LAUNCH_NOT_PERSISTED =
  'flow: could not persist the detached-flow launch record ' +
  '(chrome.storage.session write failed). NOTHING was executed: a ' +
  'detached flow with no record acts irreversibly with no evidence.';

export function createExtensionFlowControl(deps: ExtensionFlowControlDeps): FlowControl {
  const { tabId, registry, history, clock } = deps;

  /** Retire a finished flow: drop it from the registry, restart its tab's
   * idle window from its end, and hand it to the history. Never throws: a
   * storage failure must not turn a completed flow into a failed call. */
  const recordFinished = (flowId: string, result: FlowResult | null): void => {
    const entry = registry.finish(flowId);
    if (!entry) return;
    const endedAt = clock.now();
    deps.flowEnded(entry.tabId, endedAt);
    history.recordFinished(entry, result, endedAt);
  };

  return {
    detachedOnTab: () => registry.detachedForTab(tabId)?.flowId,

    // The perform* bindings, in one place so the real run and the dry-run
    // projection cannot drift apart. `stopWaiting` reaches `performWaitFor`
    // alone: it is the only perform* with a loop of its own to break out of.
    steps: ({ hidePasswordValues, stopWaiting }): FlowStepDeps => ({
      performFind: (params) =>
        performFind(deps.stepDeps(), { ...params, hide_password_values: hidePasswordValues }),
      performClick: (params) => performClick(deps.stepDeps(), params),
      performType: (params) => performType(deps.stepDeps(), params),
      performPress: (params) => performPress(deps.stepDeps(), params),
      performWaitFor: (params) => performWaitFor(deps.waitDeps(), params, stopWaiting),
      performDrag: (params) => performDrag({ ...deps.driver(), clock }, params),
      clock,
      buildRecoverySnapshot: () =>
        deps.driver().evaluator.evaluate(
          buildSnapshotJs({
            only_interactive: true,
            max_interactive: 40,
            hide_password_values: hidePasswordValues,
          }),
        ),
    }),

    async start({ flowId: minted, steps, detached, deadlineAt }) {
      // The server mints the id so the agent gets it back even when the
      // extension never answers; the local fallback covers an older server.
      const flowId = minted ?? newFlowId();
      const entry = registry.register({
        flowId,
        tabId,
        steps,
        detached,
        ...(detached ? { expiresAt: clock.now() + MAX_DETACHED_FLOW_MS } : {}),
        ...(deadlineAt === undefined ? {} : { foregroundDeadlineAt: deadlineAt }),
      });
      // Best effort and deliberately not awaited: the title only lets the
      // popup tell two concurrent flows apart.
      void deps
        .tabTitle(tabId)
        .then((title) => {
          if (typeof title === 'string') entry.title = title;
        })
        .catch(() => {
          // Tab gone or title unavailable — the panel falls back to the id.
        });
      // The detached record lands BEFORE the first step: it is the only
      // evidence a worker termination leaves behind, so a record that will
      // not store is a refusal while nothing has run yet.
      if (detached && !(await history.persistLaunch(entry))) {
        registry.finish(flowId);
        return { refused: LAUNCH_NOT_PERSISTED };
      }
      return {
        // Also covers the detached ceiling: `shouldStop` flips the entry to
        // `expired` the first time the deadline has passed.
        shouldCancel: () => registry.shouldStop(flowId, clock.now()),
        onProgress: (progress) => {
          entry.progress = progress;
        },
        startedAt: entry.startedAt,
        expiresAt: entry.expiresAt,
        finish: (result) => {
          recordFinished(flowId, result);
        },
      };
    },

    // The live registry first, then the persisted detached record; worker-
    // global, keyed by flow id, so any connected tab can read a finished
    // flow's manifest after its own tab closed.
    async status(flowId) {
      const entry = registry.get(flowId);
      const record = entry ? undefined : await history.record(flowId);
      return toFlowStatus(flowId, entry, record);
    },
  };
}
