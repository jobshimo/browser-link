/**
 * Shared `expect` handling for the click / type / press actions
 * (`background.ts` in the extension, `cdp/transport.ts` on the server;
 * the server keeps an independent, drift-tested copy at
 * `packages/server/src/cdp/expect.ts`).
 *
 * WHY THIS EXISTS: `settle` proves the page went QUIET, not that the
 * action had an EFFECT. A click on an element whose handler never fired
 * returns `{ ok: true, settle: { mutation_count: 0, settled: true } }` —
 * indistinguishable from success until a later step fails. `expect` lets
 * the caller state the effect it is counting on (the URL changed, a
 * selector appeared/disappeared, some text showed up) and turns a missing
 * effect into an explicit failure at the step that caused it.
 *
 * Like settle.ts this lives outside `inpage/` (caller-context logic) and
 * takes the evaluate function as a parameter so it is unit-testable
 * without a live connection.
 */
import { buildExpectProbeJs } from './inpage/builders.js';
import type { EvaluateFn } from './settle.js';

/** Default and hard ceiling of the expectation window. The ceiling keeps
 * the worst-case budget of an action (settle + expect) inside the bridge
 * timeout and a flow's up-front budget model — mirrored by
 * `EXPECT_MAX_TIMEOUT_MS` in `tools/browser-dispatch.ts`. */
export const DEFAULT_EXPECT_TIMEOUT_MS = 3000;
export const MAX_EXPECT_TIMEOUT_MS = 10_000;
const EXPECT_POLL_MS = 100;

/** The wire shape: any combination of conditions plus the window. */
export interface ExpectParams {
  url_changed?: boolean;
  selector_appears?: string;
  selector_disappears?: string;
  text_appears?: string;
  timeout_ms?: number;
}

/** `ExpectParams` after validation/clamping. Only built when at least one
 * condition is actually requested. */
export interface ExpectSpec {
  urlChanged: boolean;
  selectorAppears?: string;
  selectorDisappears?: string;
  textAppears?: string;
  timeoutMs: number;
}

/** One sample of the page, as returned by `buildExpectProbeJs`. */
export interface ExpectObservation {
  url?: string;
  selector_appears?: boolean;
  selector_disappears?: boolean;
  text_appears?: boolean;
  invalid_selector?: string;
}

export interface ExpectMet {
  met: true;
  elapsed_ms: number;
}

export type ExpectVerdict = { ok: true; expect?: ExpectMet } | { ok: false; error: string };

export interface ExpectClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: ExpectClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      // Literal-bounded like the other timers here: EXPECT_POLL_MS is the
      // only caller-independent value that ever reaches setTimeout.
      setTimeout(resolve, ms > 0 && ms <= EXPECT_POLL_MS ? ms : EXPECT_POLL_MS);
    }),
};

/**
 * Normalize an `expect` param. Returns `null` when nothing is being
 * expected (absent, not an object, no condition, or only
 * `url_changed: false`) so callers skip every extra round trip. Lenient on
 * purpose: strict validation lives in the server's dispatcher, and this
 * runs in the extension where garbage should degrade, not throw.
 */
export function resolveExpectParams(raw: unknown): ExpectSpec | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const urlChanged = p.url_changed === true;
  const selectorAppears = str(p.selector_appears);
  const selectorDisappears = str(p.selector_disappears);
  const textAppears = str(p.text_appears);
  if (!urlChanged && !selectorAppears && !selectorDisappears && !textAppears) return null;
  const rawTimeout = p.timeout_ms;
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(rawTimeout, MAX_EXPECT_TIMEOUT_MS)
      : DEFAULT_EXPECT_TIMEOUT_MS;
  return { urlChanged, selectorAppears, selectorDisappears, textAppears, timeoutMs };
}

/** What the page looked like right BEFORE the action: the url plus one
 * full probe sample. `*_appears` / `selector_disappears` are transitions,
 * so each needs its starting state. */
export interface ExpectBaseline {
  url?: string;
  observed?: ExpectObservation;
}

/** Describe every condition of `spec` that `observed` does not satisfy.
 * Pure: an empty array means the expectation is met. */
export function unmetExpectations(
  spec: ExpectSpec,
  baseline: ExpectBaseline | undefined,
  observed: ExpectObservation,
): string[] {
  const unmet: string[] = [];
  const invalid = observed.invalid_selector;
  const startUrl = baseline?.url;
  if (
    spec.urlChanged &&
    (startUrl === undefined || observed.url === undefined || observed.url === startUrl)
  ) {
    unmet.push('url_changed');
  }
  if (spec.selectorAppears !== undefined && observed.selector_appears !== true) {
    unmet.push(
      invalid === 'selector_appears'
        ? `selector_appears "${spec.selectorAppears}" (invalid selector)`
        : `selector_appears "${spec.selectorAppears}"`,
    );
  }
  if (spec.selectorDisappears !== undefined && observed.selector_disappears !== true) {
    unmet.push(
      invalid === 'selector_disappears'
        ? `selector_disappears "${spec.selectorDisappears}" (invalid selector)`
        : `selector_disappears "${spec.selectorDisappears}"`,
    );
  }
  if (spec.textAppears !== undefined && observed.text_appears !== true) {
    unmet.push(`text_appears "${spec.textAppears}"`);
  }
  return unmet;
}

/**
 * Conditions that already held BEFORE the action, which therefore cannot
 * prove the action did anything (a dialog already open, text already on
 * the page). `expect` asserts a TRANSITION, so these fail up front.
 */
export function alreadyHeldExpectations(
  spec: ExpectSpec,
  baseline: ExpectBaseline | undefined,
): string[] {
  const before = baseline?.observed;
  if (!before) return [];
  const held: string[] = [];
  if (spec.selectorAppears !== undefined && before.selector_appears === true) {
    held.push(`selector_appears "${spec.selectorAppears}" was already present before the action`);
  }
  if (spec.selectorDisappears !== undefined && before.selector_disappears === true) {
    held.push(`selector_disappears "${spec.selectorDisappears}" was not present before the action`);
  }
  if (spec.textAppears !== undefined && before.text_appears === true) {
    held.push(`text_appears "${spec.textAppears}" was already on the page before the action`);
  }
  return held;
}

function probeExpression(spec: ExpectSpec): string {
  return buildExpectProbeJs({
    selector_appears: spec.selectorAppears,
    selector_disappears: spec.selectorDisappears,
    text_appears: spec.textAppears,
  });
}

/** Reject if `promise` has not settled within `ms`, so a hung probe (a
 * frozen tab, a wedged debugger) cannot stall the verification loop. */
function withProbeTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const bound = ms > 0 && ms <= MAX_EXPECT_TIMEOUT_MS ? ms : EXPECT_POLL_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`probe timed out after ${bound}ms`));
    }, bound);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Sample the page right BEFORE the action is dispatched: the baseline for
 * `url_changed` and the starting state of every transition condition. A
 * no-op (no page round trip) when nothing is expected. A failing sample
 * rejects, which aborts the action before it dispatches.
 */
export async function beginExpect(
  evaluate: EvaluateFn,
  spec: ExpectSpec | null,
): Promise<ExpectBaseline | undefined> {
  if (!spec) return undefined;
  const raw = await withProbeTimeout(evaluate(probeExpression(spec)), spec.timeoutMs);
  if (typeof raw !== 'object' || raw === null) return {};
  const observed = raw as ExpectObservation;
  return { url: observed.url, observed };
}

/**
 * Poll the page until `spec` holds or its window closes. Call it AFTER
 * the action was dispatched and settled. Never throws: a probe that fails
 * (typically the action navigated and tore down the execution context) is
 * treated as "not observable yet" and retried until the deadline — the
 * next tick usually lands on the new document. Each probe is bounded so
 * the loop overruns the window by at most one poll. An invalid selector is
 * the one exception: it can never become true, so it fails immediately.
 * A condition that already held before the action also fails immediately
 * (see `alreadyHeldExpectations`).
 *
 * Returns `{ ok: true, expect: { met: true, elapsed_ms } }`, or
 * `{ ok: false, error: 'expectation not met: <which> after <ms>ms ...' }`
 * with the action's settle info appended so the failure still says
 * whether the page was quiet or busy.
 */
export async function verifyExpect(
  evaluate: EvaluateFn,
  spec: ExpectSpec | null,
  baseline: ExpectBaseline | undefined,
  settle: Record<string, unknown> | undefined,
  clock: ExpectClock = realClock,
): Promise<ExpectVerdict> {
  if (!spec) return { ok: true };
  const settleNote = settle ? `; settle: ${JSON.stringify(settle)}` : '';
  const held = alreadyHeldExpectations(spec, baseline);
  if (held.length > 0) {
    return { ok: false, error: `expectation not met: ${held.join(', ')}${settleNote}` };
  }
  const expression = probeExpression(spec);
  const startedAt = clock.now();
  let unmet: string[];
  let probeFailures = 0;
  let probeSuccesses = 0;
  let lastProbeError = '';
  for (;;) {
    let observed: ExpectObservation | undefined;
    try {
      const remaining = spec.timeoutMs - (clock.now() - startedAt);
      const raw = await withProbeTimeout(evaluate(expression), Math.max(remaining, EXPECT_POLL_MS));
      if (typeof raw === 'object' && raw !== null) observed = raw;
      probeSuccesses++;
    } catch (err) {
      probeFailures++;
      lastProbeError = err instanceof Error ? err.message : String(err);
    }
    unmet = unmetExpectations(spec, baseline, observed ?? {});
    if (unmet.length === 0) {
      return { ok: true, expect: { met: true, elapsed_ms: clock.now() - startedAt } };
    }
    if (observed?.invalid_selector) break;
    if (clock.now() - startedAt >= spec.timeoutMs) break;
    await clock.sleep(EXPECT_POLL_MS);
  }
  const elapsed = clock.now() - startedAt;
  const probeNote =
    probeSuccesses === 0 && probeFailures > 0
      ? `; probe failed ${probeFailures} times (last: ${lastProbeError})`
      : '';
  return {
    ok: false,
    error: `expectation not met: ${unmet.join(', ')} after ${elapsed}ms${probeNote}${settleNote}`,
  };
}
