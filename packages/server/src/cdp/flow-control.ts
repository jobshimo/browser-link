// cdp-direct's `FlowControl` and `FlowCancel` (core `flow/flow-control.ts`,
// design 3.3, revision 11), over its own detached-flow model
// (`detached-flows.ts`, design section 8, Q4), the cdp-direct gate and the
// connection hold. Built per tool call; the state lives in `detached-flows.ts`
// and in the transport's connection holds.
import type { Clock } from '../generated/core/ports/clock.js';
import type { FlowCancel, FlowControl, FlowStepDeps } from '../generated/core/flow/flow-control.js';
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

export interface CdpFlowControlDeps {
  /** The `cdp:` tab id. */
  tabId: string;
  clock: Clock;
  /** The step bindings on this connection: `buildCdpFlowDeps` with the gate
   * check as its `shouldCancel`, and as `stopWaiting` when none is given. */
  steps: (options: { hidePasswordValues: boolean; stopWaiting?: () => boolean }) => FlowStepDeps;
  /** Whether the cdp-direct gate still passes (`checkCdpDirectGate`). */
  gateAllows: () => boolean;
  /** Hold the connection open while a flow runs, at most until `until`
   * (owner decision D1); returns the release. */
  hold: (until: number) => () => void;
}

export function createCdpFlowControl(deps: CdpFlowControlDeps): FlowControl {
  const { tabId, clock, gateAllows } = deps;
  return {
    detachedOnTab: () => detachedFlowForTab(tabId)?.flowId,
    steps: deps.steps,
    start({ flowId, steps, detached, deadlineAt }) {
      // THE cdp-direct kill switch. There is no popup Stop button here, so
      // the user's only lever is `browser-link cdp revoke`; re-checking the
      // gate before each step turns revoke into a real stop with a
      // worst-case latency of one step. Deliberately NOT cached: a revoked
      // grant is visible to the very next check.
      //
      // Foreground and detached runs are both registered, so `flow_status`
      // answers `running` with progress and `flow_cancel` stops either, as
      // on the extension; only a detached one is bound by the one-per-tab
      // rule and the 30-minute ceiling, and only it keeps a record afterwards.
      const flow = registerDetachedFlow({ flowId: flowId ?? '', tabId, steps, detached });
      // Owner decision D1. The idle sweep must not cut a running flow: the
      // hold is bounded by the detached ceiling, or for a foreground flow by
      // its deadline, or without one by the longest any flow may run.
      const release = deps.hold(
        detached ? (flow.expiresAt ?? 0) : (deadlineAt ?? clock.now() + MAX_DETACHED_FLOW_MS),
      );
      return Promise.resolve({
        // The registry answers to `browser.flow_cancel`, and a detached run
        // to its own 30-minute ceiling. The gate branch cancels THROUGH the
        // registry: `stopped_by: 'grant-revoked'` is the only thing that
        // tells the agent a human pulled the grant.
        shouldCancel: () => {
          if (shouldStopDetachedFlow(flow.flowId, clock.now())) return true;
          if (gateAllows()) return false;
          cancelDetachedFlow(flow.flowId, 'grant-revoked');
          return true;
        },
        onProgress: (progress) => {
          reportDetachedProgress(flow.flowId, progress);
        },
        startedAt: flow.startedAt,
        ...(flow.expiresAt === undefined ? {} : { expiresAt: flow.expiresAt }),
        finish: (result) => {
          release();
          finishDetachedFlow(flow.flowId, result);
        },
      });
    },
    status: (flowId) => Promise.resolve(detachedFlowStatus(flowId)),
  };
}

/** In process, so the flag flips synchronously and there is no wire frame
 * to send (the extension's `tool.cancel`); an unknown or finished id is a
 * no-op. */
export const cdpFlowCancel: FlowCancel = {
  cancel: (flowId) => {
    cancelDetachedFlow(flowId);
  },
};
