// GENERATED from packages/core/src/tools/flow.ts. Do not edit.
/**
 * Registry entries of `flow`, `flow_status` and `flow_cancel` (design 3.3,
 * slice 18b). One body per tool; each transport gives its own flow model
 * through `FlowControl` (`flows`) and, on cdp-direct only, `FlowCancel`
 * (`flow-cancel`). The extension never receives a `flow_cancel` request:
 * it cancels through the `tool.cancel` frame, so it does not provide
 * `flow-cancel`.
 */
import type { FlowResult, FlowStep } from '../flow/flow-engine.js';
import { runFlow } from '../flow/flow-engine.js';
import type { FlowLaunch } from '../flow/flow-control.js';
import { withValuesHiddenNote } from '../inpage/builders.js';
import type { ToolOutcome } from './failure.js';
import type { ToolEntry } from './registry.js';
import { providedPort } from './requirement.js';

type Params = Record<string, unknown>;

export interface FlowParams {
  steps: Record<string, unknown>[];
  dryRun: boolean;
  detach: boolean;
  /** The id the server minted; absent when it sent none. */
  flowId: string | undefined;
  hidePasswordValues: boolean;
  /** `deadline_ms` when it is a finite number. */
  deadlineMs: number | undefined;
}

function coerceFlow(p: Params): FlowParams {
  return {
    // Wire-boundary narrowing: `p.steps` is untrusted JSON. Keep only
    // object-shaped entries here — `runFlow`'s own `stepKind()` guard
    // re-validates each one at runtime regardless, so a malformed entry
    // fails the flow cleanly instead of throwing.
    steps: Array.isArray(p.steps)
      ? p.steps.filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
      : [],
    // Strict `=== true` on both flags: any other wire value runs the flow
    // FOR REAL and in the foreground. A dry run that silently became a real
    // run, or a foreground run that silently detached, would each be the
    // worst possible failure of their flag.
    dryRun: p.dry_run === true,
    detach: p.detach === true,
    flowId: typeof p.flow_id === 'string' && p.flow_id.length > 0 ? p.flow_id : undefined,
    // Strict `=== true`: the user's hide-password-values setting (owner
    // decision D12), sent by the server only when it is on.
    hidePasswordValues: p.hide_password_values === true,
    deadlineMs:
      typeof p.deadline_ms === 'number' && Number.isFinite(p.deadline_ms)
        ? p.deadline_ms
        : undefined,
  };
}

/** The flow id of `flow_status` and `flow_cancel`; '' when missing. */
function coerceFlowId(p: Params): string {
  return typeof p.flow_id === 'string' ? p.flow_id : '';
}

const ok = (result: unknown): ToolOutcome => ({ ok: true, result });
const refused = (message: string): ToolOutcome => ({
  ok: false,
  failure: { kind: 'action', message },
});

export const flowTool: ToolEntry<FlowParams, 'flows'> = {
  name: 'flow',
  requires: ['flows'],
  listed: true,
  coerce: { extension: coerceFlow, 'cdp-direct': coerceFlow },
  handler: async (deps, params) => {
    const flows = providedPort(deps.flows, 'flows');
    const steps = params.steps as FlowStep[];
    const hidePasswordValues = params.hidePasswordValues;

    // A dry run dispatches nothing and finishes in milliseconds, so it is
    // deliberately NOT registered: there is nothing to stop, and listing it
    // would push real runs out of a 20-entry history with entries that
    // never touched the page. It also ignores `detach`.
    if (params.dryRun) {
      const projection = await runFlow(steps, flows.steps({ hidePasswordValues }), {
        dryRun: true,
      });
      return ok(withValuesHiddenNote(projection, hidePasswordValues));
    }

    const detach = params.detach;
    if (detach) {
      // ONE detached flow per tab. Two loops clicking through the same page
      // have no use case and every failure mode; the error names the running
      // id so the caller can inspect or stop it.
      const running = flows.detachedOnTab();
      if (running !== undefined) {
        return refused(
          `flow: a detached flow is already running on this tab (${running}). ` +
            `Wait for it, or stop it with browser.flow_cancel, before detaching another.`,
        );
      }
    }

    // The server's time budget for a FOREGROUND flow, as a relative duration
    // (no shared clock). A detached flow has its own ceiling.
    const deadlineAt =
      !detach && params.deadlineMs !== undefined
        ? deps.clock.now() + Math.max(0, params.deadlineMs)
        : undefined;
    const launched = await flows.start({
      flowId: params.flowId,
      steps: steps.length,
      detached: detach,
      deadlineAt,
    });
    if ('refused' in launched) return refused(launched.refused);
    const launch: FlowLaunch = launched;

    // A `wait_for` poll loop only knows this one flag, so it must also trip
    // at the deadline or a 30s wait would sail past the bridge timeout. The
    // runner itself keeps the two causes apart (`shouldCancel` alone is a
    // stop; the deadline is `deadlineAt`).
    const stopWaiting = (): boolean =>
      launch.shouldCancel() || (deadlineAt !== undefined && deps.clock.now() >= deadlineAt);
    const run = (): Promise<FlowResult> =>
      runFlow(steps, {
        ...flows.steps({ hidePasswordValues, stopWaiting }),
        shouldCancel: () => launch.shouldCancel(),
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        ...(launch.onProgress === undefined
          ? {}
          : { onProgress: (progress) => launch.onProgress?.(progress) }),
      });

    if (detach) {
      // Deliberately floating: this IS detach. The result goes back now, the
      // loop keeps running, and `finish` eventually retires it. A throw
      // (closed tab, dead connection) is a `failed` outcome from a null
      // result; there is no caller left to rethrow to.
      void (async () => {
        let result: FlowResult | null = null;
        try {
          result = await run();
        } catch {
          // Recorded by `finish` from the null result.
        } finally {
          launch.finish(result);
        }
      })();
      return ok(
        withValuesHiddenNote(
          {
            detached: true,
            started_at: launch.startedAt,
            steps: steps.length,
            expires_at: launch.expiresAt,
          },
          hidePasswordValues,
        ),
      );
    }

    // The response is ok whenever the flow RAN (a failed step or a stop is a
    // business outcome the result carries); `finish` runs even on a throw.
    let result: FlowResult | null = null;
    try {
      result = await run();
      return ok(withValuesHiddenNote(result, hidePasswordValues));
    } finally {
      launch.finish(result);
    }
  },
};

/** Live run first, then the persisted record; an id neither knows answers
 * `state: 'unknown'`, never an error. Not scoped to the tab the request
 * came on: flows are keyed by id. */
export const flowStatusTool: ToolEntry<string, 'flows'> = {
  name: 'flow_status',
  requires: ['flows'],
  listed: true,
  coerce: { extension: coerceFlowId, 'cdp-direct': coerceFlowId },
  handler: async (deps, flowId) => {
    if (flowId.length === 0) return refused('flow_status: flow_id required');
    return ok(await providedPort(deps.flows, 'flows').status(flowId));
  },
};

/** cdp-direct only: in process, the flag flips at once and the answer is the
 * status read `browser.flow_cancel` returns on either transport. */
export const flowCancelTool: ToolEntry<string, 'flows' | 'flow-cancel'> = {
  name: 'flow_cancel',
  requires: ['flows', 'flow-cancel'],
  listed: true,
  coerce: { extension: coerceFlowId, 'cdp-direct': coerceFlowId },
  handler: async (deps, flowId) => {
    if (flowId.length === 0) return refused('flow_cancel: flow_id required');
    providedPort(deps['flow-cancel'], 'flow-cancel').cancel(flowId);
    return ok(await providedPort(deps.flows, 'flows').status(flowId));
  },
};
