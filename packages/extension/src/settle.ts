/**
 * Shared `settle_ms` / `settle_timeout_ms` handling for the click / type /
 * press actions in background.ts. Lives outside `inpage/` (this runs in the
 * extension's service-worker context) and takes the evaluate function as a
 * parameter so the failure handling is unit-testable without chrome.* —
 * background.ts passes a closure over `evaluateInTab`.
 */
import { buildSettleJs } from './inpage/builders.js';

/** Defaults and hard ceilings — same clamp-at-the-boundary philosophy as
 * the drag durations in background.ts. Mirrored by the schema bounds in
 * the server's browser-definitions.ts. */
export const DEFAULT_SETTLE_MS = 150;
export const MAX_SETTLE_MS = 2000;
export const DEFAULT_SETTLE_TIMEOUT_MS = 2000;
export const MAX_SETTLE_TIMEOUT_MS = 10_000;

export interface SettleParams {
  settleMs: number;
  settleTimeoutMs: number;
}

/**
 * Resolve the settle params for an action call. Returns `null` when settle
 * is disabled (`settle_ms: 0`, explicit) — the caller skips the extra
 * `Runtime.evaluate` round trip entirely in that case rather than running a
 * zero-length wait. `settle_ms` omitted defaults to `DEFAULT_SETTLE_MS`
 * (settle stays ON by default); any other numeric value is clamped into
 * (0, MAX_SETTLE_MS].
 */
export function resolveSettleParams(p: Record<string, unknown>): SettleParams | null {
  const rawSettleMs = p.settle_ms;
  const settleMs =
    typeof rawSettleMs === 'number' && Number.isFinite(rawSettleMs) && rawSettleMs >= 0
      ? Math.min(rawSettleMs, MAX_SETTLE_MS)
      : DEFAULT_SETTLE_MS;
  if (settleMs <= 0) return null;
  const rawTimeout = p.settle_timeout_ms;
  const settleTimeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout >= 0
      ? Math.min(rawTimeout, MAX_SETTLE_TIMEOUT_MS)
      : DEFAULT_SETTLE_TIMEOUT_MS;
  return { settleMs, settleTimeoutMs };
}

/** Evaluate-in-page function shape settleSafely needs — background.ts
 * passes `(expr) => evaluateInTab(tabId, expr)`. */
export type EvaluateFn = (expression: string) => Promise<unknown>;

/**
 * Run the settle wait, GUARANTEED not to throw. Returns the in-page settle
 * result, a degraded-but-truthful fallback when the evaluation failed, or
 * `undefined` when settle is disabled for this call.
 *
 * The guarantee matters because the action itself already SUCCEEDED by the
 * time settle runs: if the action triggered a full-document navigation, the
 * execution context the settle expression runs in is destroyed mid-wait and
 * `Runtime.evaluate` rejects. Letting that rejection escape would flip the
 * whole tool response to ok:false for an action that landed — an agent
 * would retry it and risk a duplicate submission. Instead the caller gets
 * `{ settled: false, reason: 'context-destroyed' | 'settle-error' }` spliced
 * onto an ok:true result: 'context-destroyed' is itself a strong signal the
 * action navigated the page.
 */
export async function settleSafely(
  evaluate: EvaluateFn,
  settle: SettleParams | null,
): Promise<Record<string, unknown> | undefined> {
  if (!settle) return undefined;
  try {
    const result = await evaluate(
      buildSettleJs({ settle_ms: settle.settleMs, settle_timeout_ms: settle.settleTimeoutMs }),
    );
    if (result && typeof result === 'object') return result as Record<string, unknown>;
    // Defensive: the expression always returns an object; anything else
    // means the evaluation pipeline degraded (e.g. serialization loss).
    return { settled: false, reason: 'settle-error' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const contextDestroyed = /context/i.test(message) || /navigat/i.test(message);
    return { settled: false, reason: contextDestroyed ? 'context-destroyed' : 'settle-error' };
  }
}
