/**
 * Limits on a flow that both the flow registry and the idle rules need
 * (docs/design/service-worker-architecture.md, 5.2: `policies` may import
 * this file of `support` and nothing else of it). The extension's
 * `flow-registry.ts` re-exports them.
 */

/** Absolute wall-clock ceiling on a DETACHED flow, from the moment it is
 * registered. Mirrors `MAX_DETACHED_FLOW_TIMEOUT_MS` in the server's
 * `browser-dispatch.ts` (which rejects an over-ceiling flow up front) and
 * `cdp/detached-flows.ts` (the cdp-direct runner's own copy); kept in sync
 * manually, since the three packages share no module for it.
 *
 * A detached flow escapes `MAX_FLOW_TIMEOUT_MS` — nothing is parked on it,
 * so the 60s "do not hold a tool call open longer than this" rule simply
 * does not apply. What it must NOT escape is having an end: a flow that
 * keeps acting with no agent attached and no upper bound is exactly the
 * runaway this whole program exists to make impossible. Past the ceiling
 * the flow self-cancels and reports `stopped_by: 'expired'` — a distinct
 * outcome from a human pressing Stop, because "I ran out of time" and
 * "someone stopped me" are different facts about the same partial work.
 *
 * Enforced as a DEADLINE checked at the same points as the cancel flag
 * (see `shouldStop`), never as a timer: a timer would fire while the
 * runner is mid-step and could not stop anything anyway, and a
 * request-derived `setTimeout` duration is a resource-exhaustion finding
 * waiting to happen. */
export const MAX_DETACHED_FLOW_MS = 30 * 60_000;
