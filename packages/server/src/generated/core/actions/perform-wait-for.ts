// GENERATED from packages/core/src/actions/perform-wait-for.ts. Do not edit.
/**
 * `browser.wait_for`: the body both the standalone tool
 * (`tools/wait-for.ts`) and a flow's wait_for step call. Moved in slice 13
 * from `background.ts` and `cdp/transport.ts`, whose two copies
 * `transport-parity.test.ts` kept equal. The page is polled through the
 * evaluator on `Clock`; `network_url` mode reads the transport's capture
 * watch, which only a transport providing `capture-buffers` gives.
 *
 * A timeout is an ordinary result (`matched: false`, `reason: 'timeout'`),
 * not a failure; a wait cut short by the flow's cancel flag reports
 * `reason: 'cancelled'`, which the step executor turns into a clean stop.
 */
import { buildWaitForSelectorJs, type WaitForSelectorCondition } from '../inpage/builders.js';
import type { Clock } from '../ports/clock.js';
import type { Evaluator } from '../ports/page-driver.js';
import type { CaptureWatch } from '../session/page-driver.js';
import {
  refFailureMessage,
  type ActionOutcome,
  type WaitForStepResult,
} from '../support/action-results.js';

export interface WaitForParams {
  selector?: string;
  /** Observer ref instead of `selector`; `condition` applies to both. */
  ref?: string;
  expression?: string;
  network_url?: string;
  condition?: string;
  timeout_ms?: number;
  poll_interval_ms?: number;
}

/** What a wait uses: the page's evaluator, the time, and the capture watch
 * when the transport has one. */
export interface WaitForDeps {
  evaluator: Evaluator;
  clock: Clock;
  captureBuffers?: CaptureWatch;
}

/** The text of a `network_url` wait on a transport without capture buffers. */
export const NETWORK_URL_UNSUPPORTED_MESSAGE =
  'wait_for: network_url mode is not supported over cdp-direct in v1 (no network buffering) — use a tab connected through the Chrome extension instead.';

export async function performWaitFor(
  { evaluator, clock, captureBuffers }: WaitForDeps,
  params: WaitForParams,
  /** Cancellation flag of the flow this wait belongs to, when it is a flow
   * step. Checked on EVERY poll tick, which is what makes the advertised
   * worst-case cancellation latency of one step true for a step that can
   * legitimately park for 30 seconds — without it, pressing Stop during a
   * long `wait_for` would do nothing visible until the wait timed out on
   * its own. Absent for the standalone `browser.wait_for` tool, which has
   * no flow to be cancelled with. */
  shouldCancel?: () => boolean,
): Promise<ActionOutcome<WaitForStepResult>> {
  // The check the registry makes too (`needs`): a flow step reaches the
  // action without going through the registry.
  if (params.network_url !== undefined && captureBuffers === undefined) {
    return { ok: false, error: NETWORK_URL_UNSUPPORTED_MESSAGE };
  }
  try {
    const waitSelector = params.selector;
    const waitExpression = params.expression;
    const waitNetworkUrl = params.network_url;
    const waitCondition = params.condition ?? 'visible';
    // Defensive caps mirror the dispatcher's contract and keep CodeQL
    // happy about setTimeout durations driven by request params.
    const MAX_WAIT_TIMEOUT_MS = 30_000;
    const MIN_POLL_MS = 50;
    const MAX_POLL_MS = 1_000;
    const requestedTimeout = params.timeout_ms ?? 5_000;
    const timeoutMs =
      requestedTimeout < MAX_WAIT_TIMEOUT_MS ? requestedTimeout : MAX_WAIT_TIMEOUT_MS;
    const requestedPoll = params.poll_interval_ms ?? 100;
    const pollIntervalMs =
      requestedPoll < MIN_POLL_MS
        ? MIN_POLL_MS
        : requestedPoll > MAX_POLL_MS
          ? MAX_POLL_MS
          : requestedPoll;

    // Build the check function based on which mode the caller picked. The
    // dispatcher already enforced "exactly one of selector / ref / expression /
    // network_url" so we just pick the first defined one. If none are
    // defined (shouldn't happen from a well-formed call), the check stays
    // null and we return matched=false immediately.
    let check: (() => Promise<boolean>) | null = null;
    // Set when a ref probe reports that the page has no observer: the ref
    // can never resolve, so the wait fails instead of timing out (or, for
    // `detached` / `hidden`, matching a ref it never looked up).
    // `stale` is set while the last probe found the ref's element gone
    // (`visible` / `attached` only; `hidden` / `detached` count it as met);
    // `docChanged` says the ref belongs to another document, which can never
    // come back, so the wait fails at once instead of polling.
    const refProbe: {
      unavailable: boolean;
      stale: { reason: string; doc_id?: string } | null;
      docChanged: boolean;
    } = { unavailable: false, stale: null, docChanged: false };
    if (waitSelector !== undefined) {
      const expr = buildWaitForSelectorJs(waitSelector, waitCondition as WaitForSelectorCondition);
      check = async (): Promise<boolean> => {
        try {
          const result = await evaluator.evaluate(expr);
          return Boolean(result);
        } catch {
          // If the page is unreachable mid-poll, count as "not yet matched".
          return false;
        }
      };
    } else if (params.ref !== undefined) {
      const expr = buildWaitForSelectorJs(
        { ref: params.ref },
        waitCondition as WaitForSelectorCondition,
      );
      check = async (): Promise<boolean> => {
        try {
          const result = await evaluator.evaluate(expr);
          if (typeof result === 'object' && result !== null) {
            const probe = result as { reason?: unknown; doc_id?: unknown; doc_changed?: unknown };
            if (probe.reason === 'ref-stale') {
              refProbe.stale = {
                reason: 'ref-stale',
                ...(typeof probe.doc_id === 'string' ? { doc_id: probe.doc_id } : {}),
              };
              refProbe.docChanged = probe.doc_changed === true;
              // A node that is merely detached may be re-attached or
              // re-rendered, which is what the wait may be for: keep polling.
              return refProbe.docChanged;
            }
            refProbe.unavailable = true;
            return true;
          }
          refProbe.stale = null;
          return result === true;
        } catch {
          return false;
        }
      };
    } else if (waitExpression !== undefined) {
      const wrapped = `Boolean(${waitExpression})`;
      check = async (): Promise<boolean> => {
        try {
          const result = await evaluator.evaluate(wrapped);
          return Boolean(result);
        } catch {
          return false;
        }
      };
    } else if (waitNetworkUrl !== undefined) {
      const needle = waitNetworkUrl.toLowerCase();
      check = (): Promise<boolean> => {
        for (const url of captureBuffers?.finishedUrls() ?? []) {
          if (url.toLowerCase().includes(needle)) return Promise.resolve(true);
        }
        return Promise.resolve(false);
      };
    }

    const startedAt = clock.now();
    let checks = 0;
    let matched = false;
    let cancelled = false;
    while (check) {
      if (shouldCancel?.() === true) {
        cancelled = true;
        break;
      }
      checks++;
      if (await check()) {
        matched = true;
        break;
      }
      if (clock.now() - startedAt >= timeoutMs) break;
      await clock.sleep(pollIntervalMs);
    }
    const elapsedMs = clock.now() - startedAt;
    if (refProbe.unavailable && params.ref !== undefined) {
      return {
        ok: false,
        error: refFailureMessage({ reason: 'observer-unavailable' }, params.ref) ?? '',
      };
    }
    // A ref of another document can never match: fail now with the owner's
    // sentence. (A merely detached node keeps the timeout result, below.)
    if (refProbe.stale !== null && params.ref !== undefined && refProbe.docChanged) {
      return { ok: false, error: refFailureMessage(refProbe.stale, params.ref) ?? '' };
    }
    // The element the ref names was gone at the last poll: the timeout result
    // keeps its shape and carries the sentence in `ref_gone`.
    const refGone =
      refProbe.stale !== null && params.ref !== undefined && !cancelled && !matched
        ? (refFailureMessage(refProbe.stale, params.ref) ?? '').replace(/^ref-stale: /, '')
        : '';

    // 'cancelled' is deliberately distinct from 'timeout': the step
    // executor turns a timeout into a flow FAILURE (with a recovery
    // snapshot) and a cancellation into a clean `stopped_by: 'cancelled'`.
    // Reporting a stopped wait as a timeout would invent a diagnosis for a
    // condition that was never given its budget.
    const result: WaitForStepResult = matched
      ? { matched: true, elapsed_ms: elapsedMs, checks }
      : {
          matched: false,
          elapsed_ms: elapsedMs,
          checks,
          reason: cancelled ? 'cancelled' : 'timeout',
          ...(refGone ? { ref_gone: refGone } : {}),
        };
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
