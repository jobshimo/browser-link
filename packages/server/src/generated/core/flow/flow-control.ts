// GENERATED from packages/core/src/flow/flow-control.ts. Do not edit.
/**
 * What a transport gives the flow tools (design 3.3, revision 11): its own
 * flow model behind one per-transport service, in the family of the dialog
 * and capture watches, not a port. The extension implements it over core's
 * `FlowRegistry` and `FlowHistory`; cdp-direct over its own detached-flow
 * model (`cdp/detached-flows.ts`, section 8, Q4), its gate and its
 * connection hold. `FlowControl` is the `flows` requirement; `FlowCancel`,
 * which only cdp-direct gives, is `flow-cancel`.
 */
import type { FlowDeps, FlowProgress, FlowResult } from './flow-engine.js';

/** The step bindings `runFlow` needs from the transport. cdp-direct's carry
 * its own `shouldCancel` (the gate check), which a real run overrides with
 * the launch's. */
export type FlowStepDeps = Omit<FlowDeps, 'onProgress' | 'deadlineAt'>;

/** A flow the transport has registered and may run. */
export interface FlowLaunch {
  /** The cancel check `runFlow` asks before each step. */
  shouldCancel(): boolean;
  /** Progress of the running step. Given by the extension (every launch)
   * and by cdp-direct for a detached launch; cdp-direct's foreground run
   * reports none. */
  onProgress?(progress: FlowProgress): void;
  /** When the flow started and when a detached flow expires; read for a
   * detached launch only, where both transports give them. */
  startedAt?: number;
  expiresAt?: number;
  /** Retire the launch once its run ended (`null` when it threw). Called
   * exactly once. */
  finish(result: FlowResult | null): void;
}

export interface FlowStart {
  /** The id the server minted; absent when it sent none. */
  flowId: string | undefined;
  /** The number of steps. */
  steps: number;
  detached: boolean;
  /** A foreground flow's deadline (`deadline_ms` from now); the extension
   * registers it, cdp-direct bounds its connection hold by it. */
  deadlineAt: number | undefined;
}

export interface FlowControl {
  /** The id of the detached flow running on this tab, if any. */
  detachedOnTab(): string | undefined;
  /** The step bindings of a run on this tab. `stopWaiting` is what a
   * `wait_for` step's poll loop checks; absent for a dry run, where
   * cdp-direct waits on its gate check and the extension on nothing. */
  steps(options: { hidePasswordValues: boolean; stopWaiting?: () => boolean }): FlowStepDeps;
  /** Register a real run. A refusal (the extension's unpersisted detached
   * launch record) is the text the agent reads; nothing has run. */
  start(launch: FlowStart): Promise<FlowLaunch | { refused: string }>;
  /** The `flow_status` payload for an id, live or from the records: the
   * transport's own wire payload, which core only forwards. */
  status(flowId: string): Promise<unknown>;
}

/** cdp-direct's cancel of a flow by id: in process, so there is no wire
 * frame. The extension cancels through the `tool.cancel` frame and the
 * popup, never through a `flow_cancel` tool request, so it gives none. */
export interface FlowCancel {
  cancel(flowId: string): void;
}
