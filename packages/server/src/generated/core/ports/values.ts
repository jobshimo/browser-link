// GENERATED from packages/core/src/ports/values.ts. Do not edit.
// The value types the ports speak, declared here so `ports` imports nothing
// in core (5.2). They were copied as they were from the extension's
// settle.ts (`SettleParams`, `EvaluateFn`) and observer-host.ts
// (`ObserverMark`); slice 7 deleted those originals and re-pointed
// `support/` at these.

export interface SettleParams {
  settleMs: number;
  settleTimeoutMs: number;
}

/** Evaluate-in-page function shape settleSafely needs — the caller passes
 * a closure over its own evaluate primitive: `(expr) =>
 * evaluateInTab(tabId, expr)` in the extension, `(expr) =>
 * evaluateInTab(client, expr)` on the server. */
export type EvaluateFn = (expression: string) => Promise<unknown>;

/** The part of an action mark (`buildObserverMarkJs`) the changes read needs. */
export interface ObserverMark {
  mark: number;
  doc_id: string;
}
