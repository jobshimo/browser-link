/**
 * browser.flow step sequencing — the logic behind the composite action
 * tool. Runs a short, declarative list of find/click/type/press/wait_for
 * steps strictly in order, fails fast on the first step that does not
 * succeed, and threads an "implicit target" from a `find` step into the
 * very next click/type/press step that omits its own `selector`.
 *
 * Deliberately decoupled from chrome.debugger / CDP: every side effect
 * goes through the `FlowDeps` the caller injects. `background.ts` wires
 * the real perform* functions (already closed over the tab id and, for
 * wait_for, the tab's network buffer state); tests wire fakes. This is
 * what makes the sequencing logic — step-shape validation, implicit-target
 * threading, fail-fast, result shaping — unit-testable without a real
 * browser tab or CDP session.
 *
 * `background.ts`'s `case 'click'` / `'type'` / `'press'` / `'find'` /
 * `'wait_for'` handlers and this module's step executor call the exact
 * SAME perform* functions — there is one implementation of each action,
 * never two copies that can drift apart.
 */

/** Structured success/failure outcome shared by every extracted perform*
 * function in background.ts. `ok:false` carries the exact same error
 * string the standalone tool.response would have returned for that
 * failure — both the thin `case` wrappers and this module's step executor
 * consume this shape, so the two call paths can never drift. */
export type ActionOutcome<T> = { ok: true; result: T } | { ok: false; error: string };

/** Hard cap on steps per flow — mirrors the `maxItems: 20` on the MCP
 * schema (`browser-definitions.ts`) and the server-side validation
 * (`browser-dispatch.ts`). Enforced again here so the extension never
 * runs an oversized flow even if a future caller bypasses the server's
 * own check (e.g. a directly-wired test harness). */
export const MAX_FLOW_STEPS = 20;

export interface FindStepParams {
  text: string;
  role?: string;
  exact?: boolean;
}

export interface FindStepResult {
  matched: boolean;
  reason?: string;
  candidates?: { selector: string; text: string; tag: string }[];
  /** Up to 3 near-miss candidates on a `not-found` result — see
   * `buildFindJs` in `inpage/builders.ts` for the ranking rules. Not
   * consumed by `runFlow` today (the flow failure message stays as-is);
   * carried through so a future caller of the raw `performFind` outcome
   * (or a richer flow error message) can use it without a shape change. */
  near_misses?: { text: string; selector: string; role?: string }[];
  /** Human-readable detail on a `not-found` result — currently only set
   * when `role` excluded matches that existed under a broader scan. */
  error?: string;
  selector?: string;
  ambiguous?: boolean;
  tag?: string;
  text?: string;
  coords?: { x: number; y: number };
  frame?: string;
}

export interface ClickStepParams {
  selector?: string;
  force?: boolean;
  settle_ms?: number;
}

export interface ClickStepResult {
  clicked: string;
  tag: string;
  settle?: Record<string, unknown>;
}

export interface TypeStepParams {
  selector?: string;
  text: string;
  clear?: boolean;
  settle_ms?: number;
}

export interface TypeStepResult {
  typed: number;
  selector?: string;
  settle?: Record<string, unknown>;
}

export interface PressStepParams {
  key: string;
  modifiers?: string[];
  selector?: string;
  settle_ms?: number;
}

export interface PressStepResult {
  key: string;
  modifiers: string[];
  settle?: Record<string, unknown>;
}

export interface WaitForStepParams {
  selector?: string;
  expression?: string;
  network_url?: string;
  condition?: string;
  timeout_ms?: number;
  poll_interval_ms?: number;
}

export interface WaitForStepResult {
  matched: boolean;
  elapsed_ms: number;
  checks: number;
  reason?: string;
}

export type FlowStep =
  | { find: FindStepParams }
  | { click: ClickStepParams }
  | { type: TypeStepParams }
  | { press: PressStepParams }
  | { wait_for: WaitForStepParams };

type StepKind = 'find' | 'click' | 'type' | 'press' | 'wait_for';
const STEP_KINDS: readonly StepKind[] = ['find', 'click', 'type', 'press', 'wait_for'];

function isStepKind(key: string): key is StepKind {
  return (STEP_KINDS as readonly string[]).includes(key);
}

/** Identify which of the 5 step kinds a raw (untrusted) step object is.
 * Returns `null` unless the object has EXACTLY ONE key and that key is a
 * recognized kind — extra keys (`{find: {...}, mystery: 1}`) reject, in
 * line with the MCP schema's `additionalProperties: false`. The caller
 * treats `null` as an "unknown step shape" flow failure. */
function stepKind(step: unknown): StepKind | null {
  if (typeof step !== 'object' || step === null) return null;
  const keys = Object.keys(step);
  if (keys.length !== 1) return null;
  return isStepKind(keys[0]) ? keys[0] : null;
}

/** Everything the step executor needs from the outside world. `background.ts`
 * binds each method to the real perform* function; tests bind fakes.
 * `buildRecoverySnapshot` is called only on failure, and always renders the
 * same focused view (`only_interactive:true, max_interactive:40`) via the
 * shared `buildSnapshotJs` builder — same DOM walk `browser.snapshot` uses,
 * just pre-filtered so the agent sees where the flow stopped without a
 * follow-up round trip. */
export interface FlowDeps {
  performFind(params: FindStepParams): Promise<ActionOutcome<FindStepResult>>;
  performClick(
    params: ClickStepParams & { selector: string },
  ): Promise<ActionOutcome<ClickStepResult>>;
  performType(params: TypeStepParams): Promise<ActionOutcome<TypeStepResult>>;
  performPress(params: PressStepParams): Promise<ActionOutcome<PressStepResult>>;
  performWaitFor(params: WaitForStepParams): Promise<ActionOutcome<WaitForStepResult>>;
  buildRecoverySnapshot(): Promise<unknown>;
}

export interface FlowSuccess {
  ok: true;
  steps_completed: number;
  results: unknown[];
}

export interface FlowFailure {
  ok: false;
  failed_step: number;
  step_kind: string;
  error: string;
  steps_completed: number;
  recovery_snapshot: unknown;
}

export type FlowResult = FlowSuccess | FlowFailure;

/** Drop the noisy fields of a click/type/press result down to `{ ok, settle? }`
 * for the flow's per-step result — the agent already knows what it asked
 * for (the selector, the text length, the key); echoing that back N times
 * in a row is not worth the tokens. `settle` is kept because it carries
 * NEW information (did the page go quiet, did focus/URL drift). */
function compactActionResult(result: { settle?: Record<string, unknown> }): {
  ok: true;
  settle?: Record<string, unknown>;
} {
  return result.settle ? { ok: true, settle: result.settle } : { ok: true };
}

async function withRecoverySnapshot(
  deps: FlowDeps,
  index: number,
  kind: string,
  error: string,
  stepsCompleted: number,
): Promise<FlowFailure> {
  let recovery_snapshot: unknown = null;
  try {
    recovery_snapshot = await deps.buildRecoverySnapshot();
  } catch {
    // Best-effort: if the tab is gone or CDP throws on the recovery
    // snapshot too, still report the original step failure rather than
    // masking it behind a secondary snapshot error.
  }
  return {
    ok: false,
    failed_step: index,
    step_kind: kind,
    error,
    steps_completed: stepsCompleted,
    recovery_snapshot,
  };
}

/** Resolve a click/type/press step's target: an explicit `selector` always
 * wins; otherwise fall back to the implicit target left by a preceding
 * `find` step. `consumed` is true only when the implicit target was the
 * one actually used — a step providing its own selector leaves the
 * implicit target untouched for a LATER step to pick up. */
function resolveTarget(
  explicit: string | undefined,
  implicit: string | undefined,
): { resolved: string | undefined; consumed: boolean } {
  if (explicit !== undefined) return { resolved: explicit, consumed: false };
  return { resolved: implicit, consumed: implicit !== undefined };
}

/** Appended to a step failure when the PREVIOUS step's settle wait reported
 * `context-destroyed` — that reason means the page navigated during or right
 * after that step, so the failing step almost certainly raced the loading
 * document rather than genuinely missing its target. */
const NAVIGATION_RACE_HINT =
  " (previous step's settle reported context-destroyed — the page likely navigated;" +
  ' insert a wait_for step after the navigating action so this step does not race the page load)';

/**
 * Run a declarative sequence of steps strictly in order, stopping at the
 * first failure. See the module doc comment for the implicit-target and
 * result-shaping rules.
 *
 * `steps` is typed as `FlowStep[]` for ergonomic test-writing, but every
 * element is re-validated at runtime via `stepKind()` before use — the
 * array may originate from an untrusted JSON payload cast at the wire
 * boundary in `background.ts`, and a malformed entry must fail the flow
 * cleanly rather than throw.
 */
export async function runFlow(steps: readonly FlowStep[], deps: FlowDeps): Promise<FlowResult> {
  if (!Array.isArray(steps) || steps.length === 0) {
    return withRecoverySnapshot(deps, 0, 'none', 'flow: steps must be a non-empty array', 0);
  }
  if (steps.length > MAX_FLOW_STEPS) {
    return withRecoverySnapshot(
      deps,
      0,
      'none',
      `flow: at most ${MAX_FLOW_STEPS} steps allowed, got ${steps.length}`,
      0,
    );
  }

  const results: unknown[] = [];
  let implicitTarget: string | undefined;
  /** `settle.reason` from the most recent SUCCESSFUL action step. When it
   * is 'context-destroyed', the next step failure gets the page-load-race
   * hint appended. Reset by any successful find/wait_for step — those
   * prove the page is reachable again. */
  let lastSettleReason: unknown;
  const raceHint = (): string =>
    lastSettleReason === 'context-destroyed' ? NAVIGATION_RACE_HINT : '';

  for (let i = 0; i < steps.length; i++) {
    const raw: unknown = steps[i];
    const kind = stepKind(raw);
    if (!kind) {
      return withRecoverySnapshot(
        deps,
        i,
        'unknown',
        'flow: each step must be exactly one of find | click | type | press | wait_for',
        results.length,
      );
    }
    const stepRecord = raw as Record<StepKind, unknown>;

    if (kind === 'find') {
      const params = stepRecord.find as FindStepParams;
      const outcome = await deps.performFind(params);
      if (!outcome.ok) {
        return withRecoverySnapshot(deps, i, kind, outcome.error + raceHint(), results.length);
      }
      const r = outcome.result;
      if (!r.matched) {
        const candidateNote =
          r.reason === 'multiple-matches' && r.candidates
            ? ` — candidates: ${JSON.stringify(r.candidates)}`
            : '';
        return withRecoverySnapshot(
          deps,
          i,
          kind,
          `find: ${r.reason ?? 'not-found'}${candidateNote}${raceHint()}`,
          results.length,
        );
      }
      if (r.ambiguous) {
        return withRecoverySnapshot(
          deps,
          i,
          kind,
          `find: selector "${r.selector ?? ''}" is ambiguous across shadow roots/iframes — refine text/role for a unique match`,
          results.length,
        );
      }
      implicitTarget = r.selector;
      lastSettleReason = undefined;
      results.push({ selector: r.selector });
      continue;
    }

    if (kind === 'wait_for') {
      const params = stepRecord.wait_for as WaitForStepParams;
      const outcome = await deps.performWaitFor(params);
      if (!outcome.ok) {
        return withRecoverySnapshot(deps, i, kind, outcome.error + raceHint(), results.length);
      }
      if (!outcome.result.matched) {
        // No race hint here: a wait_for step IS the recommended remedy for
        // a navigation race — a plain timeout is a genuine non-match.
        return withRecoverySnapshot(
          deps,
          i,
          kind,
          `wait_for: condition not met within timeout (${outcome.result.elapsed_ms}ms, ${outcome.result.checks} checks)`,
          results.length,
        );
      }
      lastSettleReason = undefined;
      results.push({ ok: true });
      continue;
    }

    if (kind === 'click') {
      const params = stepRecord.click as ClickStepParams;
      const { resolved, consumed } = resolveTarget(params.selector, implicitTarget);
      if (consumed) implicitTarget = undefined;
      if (resolved === undefined) {
        return withRecoverySnapshot(
          deps,
          i,
          kind,
          'click: no selector provided and no implicit target from a preceding find',
          results.length,
        );
      }
      const outcome = await deps.performClick({
        force: params.force,
        settle_ms: params.settle_ms,
        selector: resolved,
      });
      if (!outcome.ok) {
        return withRecoverySnapshot(deps, i, kind, outcome.error + raceHint(), results.length);
      }
      lastSettleReason = outcome.result.settle?.reason;
      results.push(compactActionResult(outcome.result));
      continue;
    }

    if (kind === 'type') {
      const params = stepRecord.type as TypeStepParams;
      const { resolved, consumed } = resolveTarget(params.selector, implicitTarget);
      if (consumed) implicitTarget = undefined;
      const outcome = await deps.performType({
        text: params.text,
        clear: params.clear,
        settle_ms: params.settle_ms,
        selector: resolved,
      });
      if (!outcome.ok) {
        return withRecoverySnapshot(deps, i, kind, outcome.error + raceHint(), results.length);
      }
      lastSettleReason = outcome.result.settle?.reason;
      results.push(compactActionResult(outcome.result));
      continue;
    }

    // press — the only kind left after the checks above.
    const params = stepRecord.press as PressStepParams;
    const { resolved, consumed } = resolveTarget(params.selector, implicitTarget);
    if (consumed) implicitTarget = undefined;
    const outcome = await deps.performPress({
      key: params.key,
      modifiers: params.modifiers,
      settle_ms: params.settle_ms,
      selector: resolved,
    });
    if (!outcome.ok) {
      return withRecoverySnapshot(deps, i, kind, outcome.error + raceHint(), results.length);
    }
    lastSettleReason = outcome.result.settle?.reason;
    results.push(compactActionResult(outcome.result));
  }

  return { ok: true, steps_completed: results.length, results };
}
