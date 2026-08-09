/**
 * browser.flow step sequencing — the logic behind the composite action
 * tool. Runs a short, declarative list of find/click/type/press/wait_for/
 * drag/sleep steps strictly in order, fails fast on the first step that
 * does not succeed, and threads an "implicit target" from a `find` step
 * into the very next click/type/press step that omits its own
 * `selector`. A `drag` step stays OUT of that chain: both of its
 * endpoints are always explicit (selector or coords), so it neither
 * consumes nor sets the implicit target — a pending target survives a
 * drag step untouched for a later click/type/press, exactly like it
 * survives a wait_for. A `sleep` step is a fixed pause and stays out of
 * the chain for the same reason: it names no target at all.
 *
 * A `repeat` step runs a bounded sub-sequence up to `max_iterations`
 * times, optionally stopping early while a `while_found` selector still
 * matches. It does not nest, its inner steps count against the same
 * 20-step ceiling, and each iteration starts with a FRESH implicit
 * target — so nothing leaks across an iteration or across the repeat
 * boundary in either direction.
 *
 * Deliberately decoupled from any specific transport: every side effect
 * goes through the `FlowDeps` the caller injects. The concrete wiring —
 * `background.ts` in the extension, `cdp/transport.ts` on the server —
 * binds the real perform* functions (already closed over the tab id / CDP
 * client); tests wire fakes. This is what makes the sequencing logic —
 * step-shape validation, implicit-target threading, fail-fast, result
 * shaping — unit-testable without a real browser tab or CDP session.
 *
 * The individual `click` / `type` / `press` / `find` / `wait_for` /
 * `drag` tool handlers (`background.ts`'s `handleTool` switch in the
 * extension, `callCdpTool`'s switch in `cdp/transport.ts` on the server)
 * and this module's step executor call the exact SAME perform* functions
 * — there is one implementation of each action, never two copies that
 * can drift apart. The one deliberate asymmetry is `drag` over
 * cdp-direct: the tool is out of cdp-direct's v1 scope (see the server's
 * `cdp/support.ts`), so the server wires a `performDrag` that always
 * fails with the same unsupported-transport error the standalone
 * `browser.drag` returns on a `cdp:` tab.
 */

/** Structured success/failure outcome shared by every perform* function
 * (`background.ts` in the extension, `cdp/transport.ts` on the server).
 * `ok:false` carries the exact same error string the standalone
 * tool.response would have returned for that failure — both the thin
 * `case`/switch wrappers and this module's step executor consume this
 * shape, so the two call paths can never drift. */
export type ActionOutcome<T> = { ok: true; result: T } | { ok: false; error: string };

/** Hard cap on steps per flow — mirrors the `maxItems: 20` on the MCP
 * schema (`browser-definitions.ts`) and the server-side validation
 * (`browser-dispatch.ts`). Enforced again here so neither the extension
 * nor cdp-direct ever runs an oversized flow even if a future caller
 * bypasses the server's own check (e.g. a directly-wired test harness). */
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
  /** Descriptor of the element that actually receives the dispatched
   * click, present ONLY when it differs from the resolved target: a
   * pointer-events:none target whose real hit-target sibling takes the
   * click, an ancestor wrapper, or a `force:true` click landing on
   * whatever covers the point (see `buildClickResolveJs`). Omitted when
   * the click lands on the target itself. */
  hit_element?: string;
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

/** Mirrors the standalone `browser.drag` tool's params exactly (minus
 * `tab_id`): each endpoint is a CSS selector OR a viewport coordinate
 * pair, plus the same interpolation/hold options. Endpoint validation
 * (missing both forms, offscreen points) lives in `performDrag` itself,
 * so a flow drag step fails with the exact same error strings the
 * standalone tool returns. */
export interface DragStepParams {
  from_selector?: string;
  from_x?: number;
  from_y?: number;
  to_selector?: string;
  to_x?: number;
  to_y?: number;
  duration_ms?: number;
  hold_before_move_ms?: number;
  hold_before_release_ms?: number;
}

/** Full result of one drag — the same shape the standalone tool returns.
 * A flow step's per-step entry keeps only `drag_mode` of this (see
 * `compactActionResult`): the endpoints and durations echo what the
 * caller asked for, while `drag_mode` is NEW information — whether HTML5
 * native drag (dragstart/drop) or pointer-only events fired, the signal
 * for diagnosing a silently-failing drop. */
export interface DragStepResult {
  from: { x: number; y: number; selector: string | null };
  to: { x: number; y: number; selector: string | null };
  duration_ms_actual: number;
  drag_mode: 'html5' | 'pointer';
  interception_attempted: boolean;
  intercept_received: boolean;
  events_fired: string[];
}

/** Hard cap on one `sleep` step's `ms`. Matches the ceiling a single
 * `wait_for` step may request, so no one step can park the flow longer
 * than the longest wait already expressible. Out-of-range values are a
 * validation ERROR rather than a silent clamp: a flow that asked to
 * throttle by 60s and got 30s would hammer a backend at twice the
 * intended rate without ever saying so. */
export const MAX_FLOW_SLEEP_MS = 30_000;

/** A fixed pause between steps. `settle_ms` cannot serve this purpose —
 * it is a quiet-PERIOD wait that returns as soon as the page stops
 * mutating, so it collapses to nothing on a page that is already idle.
 * Throttling a repeated action against a rate-limited backend needs a
 * real delay, and before this step existed the only way to get one was
 * to drop out of the flow into `browser.evaluate` — losing trusted CDP
 * input for every action in the loop. */
export interface SleepStepParams {
  ms: number;
}

/** Hard cap on one `repeat` step's `max_iterations`. The real ceiling in
 * practice is the flow's own worst-case time budget (a repeat's budget is
 * `max_iterations × (inner steps + delay)`), which bites long before this
 * does; this is the backstop that keeps a typo from producing an
 * absurd projected budget. */
export const MAX_FLOW_REPEAT_ITERATIONS = 500;

/** Hard cap on a `repeat`'s inter-iteration `delay_ms` — same ceiling a
 * standalone `sleep` step may request. */
export const MAX_FLOW_REPEAT_DELAY_MS = 30_000;

/** A BOUNDED loop over a sub-sequence of steps.
 *
 * `max_iterations` is REQUIRED, deliberately: it is what keeps a flow's
 * worst-case duration statically computable, which is the whole basis of
 * the up-front `MAX_FLOW_TIMEOUT_MS` rejection. An unbounded loop would
 * make that budget unknowable and force the bridge to either park
 * indefinitely or time out mid-flow — the exact failure the flow budget
 * exists to prevent.
 *
 * `while_found` is the early stop: the loop runs another iteration only
 * while that selector still matches something VISIBLE in the live DOM.
 * Making the stop condition declarative is the point — it replaces the
 * hand-rolled "parse a counter and guess when we are done" pattern that
 * silently misreads pages whose counters vanish at zero.
 *
 * Nesting is rejected: a repeat may not contain a repeat. One bounded
 * loop keeps the budget arithmetic trivial and the grammar honest.
 * `steps` may not contain a `repeat`, and inner steps count against the
 * same `MAX_FLOW_STEPS` ceiling as outer ones. */
export interface RepeatStepParams {
  steps: FlowStep[];
  max_iterations: number;
  while_found?: string;
  delay_ms?: number;
}

export interface RepeatStepResult {
  iterations_completed: number;
  /** `condition` — `while_found` stopped matching. `max_iterations` — the
   * bound was reached with the condition still true (or with no condition
   * at all). A failing inner step does not produce a result at all: it
   * fails the whole flow, like every other step. */
  stopped_by: 'condition' | 'max_iterations';
  /** Per-iteration list of the inner steps' compacted results. */
  iterations: unknown[][];
}

export type FlowStep =
  | { find: FindStepParams }
  | { click: ClickStepParams }
  | { type: TypeStepParams }
  | { press: PressStepParams }
  | { wait_for: WaitForStepParams }
  | { drag: DragStepParams }
  | { sleep: SleepStepParams }
  | { repeat: RepeatStepParams };

type StepKind = 'find' | 'click' | 'type' | 'press' | 'wait_for' | 'drag' | 'sleep' | 'repeat';
const STEP_KINDS: readonly StepKind[] = [
  'find',
  'click',
  'type',
  'press',
  'wait_for',
  'drag',
  'sleep',
  'repeat',
];
/** Every kind except `repeat` — the ones `executeLeafStep` handles. */
type LeafStepKind = Exclude<StepKind, 'repeat'>;

function isStepKind(key: string): key is StepKind {
  return (STEP_KINDS as readonly string[]).includes(key);
}

/** Identify which of the 6 step kinds a raw (untrusted) step object is.
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
 * (extension) / `cdp/transport.ts` (server) binds each method to the real
 * perform* function; tests bind fakes.
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
  /** The extension binds the real drag implementation; the server's
   * cdp-direct wiring binds a stub that always returns the
   * unsupported-transport `ok:false` (drag is out of cdp-direct's v1
   * scope — see the server's `cdp/support.ts`), so a flow drag step on a
   * `cdp:` tab fails fast with the exact error the standalone
   * `browser.drag` returns there. */
  performDrag(params: DragStepParams): Promise<ActionOutcome<DragStepResult>>;
  buildRecoverySnapshot(): Promise<unknown>;
}

export interface FlowSuccess {
  ok: true;
  steps_completed: number;
  results: unknown[];
  /** Present ONLY on a `dryRun` projection, where nothing was dispatched
   * and `steps_completed` is therefore 0. Omitted on a real run, so an
   * existing consumer sees a byte-identical success shape. */
  dry_run?: true;
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

/** Drop the noisy fields of a click/type/press/drag result down to
 * `{ ok, settle?, hit_element?, drag_mode? }` for the flow's per-step
 * result — the agent already knows what it asked for (the selector, the
 * text length, the key, the drag endpoints); echoing that back N times in
 * a row is not worth the tokens. `settle` is kept because it carries NEW
 * information (did the page go quiet, did focus/URL drift), and so are a
 * click result's `hit_element` — where the click actually landed when
 * that differs from the resolved target (see `ClickStepResult`) — and a
 * drag result's `drag_mode` — whether HTML5 native drag or pointer-only
 * events fired (see `DragStepResult`). */
function compactActionResult(result: {
  settle?: Record<string, unknown>;
  hit_element?: string;
  drag_mode?: string;
}): {
  ok: true;
  settle?: Record<string, unknown>;
  hit_element?: string;
  drag_mode?: string;
} {
  return {
    ok: true,
    ...(result.settle ? { settle: result.settle } : {}),
    ...(result.hit_element ? { hit_element: result.hit_element } : {}),
    ...(result.drag_mode ? { drag_mode: result.drag_mode } : {}),
  };
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

/** Mutable state threaded through a run of steps: the pending implicit
 * target left by a `find`, and the settle reason of the most recent
 * successful action step (which arms the navigation-race hint). A
 * `repeat` body gets its OWN fresh state on every iteration, so an
 * implicit target never crosses an iteration or repeat boundary. */
interface LeafState {
  implicitTarget: string | undefined;
  /** `settle.reason` from the most recent SUCCESSFUL action step. When it
   * is 'context-destroyed', the next step failure gets the page-load-race
   * hint appended. Reset by any successful find/wait_for/drag step — those
   * prove the page is reachable again. */
  lastSettleReason: unknown;
}

/** What one step produced: its compacted result entry, or the message the
 * CALLER turns into a `FlowFailure`. Keeping the recovery snapshot and the
 * step index out of here is what lets the exact same executor be driven
 * from the top-level sequence and from inside a `repeat` body. */
type LeafOutcome = { ok: true; entry: unknown } | { ok: false; error: string };

/** Execute ONE non-repeat step against `state`, which it mutates. */
async function executeLeafStep(
  kind: LeafStepKind,
  stepRecord: Record<StepKind, unknown>,
  state: LeafState,
  deps: FlowDeps,
): Promise<LeafOutcome> {
  const raceHint = (): string =>
    state.lastSettleReason === 'context-destroyed' ? NAVIGATION_RACE_HINT : '';

  if (kind === 'find') {
    const params = stepRecord.find as FindStepParams;
    const outcome = await deps.performFind(params);
    if (!outcome.ok) return { ok: false, error: outcome.error + raceHint() };
    const r = outcome.result;
    if (!r.matched) {
      const candidateNote =
        r.reason === 'multiple-matches' && r.candidates
          ? ` — candidates: ${JSON.stringify(r.candidates)}`
          : '';
      return { ok: false, error: `find: ${r.reason ?? 'not-found'}${candidateNote}${raceHint()}` };
    }
    if (r.ambiguous) {
      return {
        ok: false,
        error: `find: selector "${r.selector ?? ''}" is ambiguous across shadow roots/iframes — refine text/role for a unique match`,
      };
    }
    state.implicitTarget = r.selector;
    state.lastSettleReason = undefined;
    return { ok: true, entry: { selector: r.selector } };
  }

  if (kind === 'wait_for') {
    const params = stepRecord.wait_for as WaitForStepParams;
    const outcome = await deps.performWaitFor(params);
    if (!outcome.ok) return { ok: false, error: outcome.error + raceHint() };
    if (!outcome.result.matched) {
      // No race hint here: a wait_for step IS the recommended remedy for
      // a navigation race — a plain timeout is a genuine non-match.
      return {
        ok: false,
        error: `wait_for: condition not met within timeout (${outcome.result.elapsed_ms}ms, ${outcome.result.checks} checks)`,
      };
    }
    state.lastSettleReason = undefined;
    return { ok: true, entry: { ok: true } };
  }

  if (kind === 'drag') {
    const params = stepRecord.drag as DragStepParams;
    // No resolveTarget here ON PURPOSE: a drag names BOTH endpoints
    // explicitly (selector or coords), so there is no single `selector`
    // slot the implicit target could unambiguously fill — a pending
    // implicit target survives this step untouched for a later
    // click/type/press, exactly like it survives a wait_for.
    const outcome = await deps.performDrag(params);
    if (!outcome.ok) return { ok: false, error: outcome.error + raceHint() };
    // A successful drag resolved both endpoints via an in-page probe,
    // which proves the document is reachable again after any earlier
    // navigation — clear the race hint like find/wait_for do. (Drag has
    // no settle phase, so there is no settle reason to carry instead.)
    state.lastSettleReason = undefined;
    return { ok: true, entry: compactActionResult(outcome.result) };
  }

  if (kind === 'sleep') {
    const params = stepRecord.sleep as SleepStepParams | undefined;
    const ms = params?.ms;
    // Re-validated here even though the server already checked: this
    // module is reachable from a directly-wired caller that never went
    // through `validateFlowSteps` (see the runFlow doc comment).
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 1 || ms > MAX_FLOW_SLEEP_MS) {
      return {
        ok: false,
        error: `sleep: ms must be an integer between 1 and ${MAX_FLOW_SLEEP_MS}`,
      };
    }
    // The guard above already REJECTED anything outside 1..MAX, so this
    // Math.min can never actually reduce a value — it is not a silent
    // clamp and does not weaken the reject-don't-clamp contract. It is
    // here so the timer's upper bound is provable from this line alone:
    // static analysis (CodeQL `js/resource-exhaustion`) cannot follow the
    // bound through the compound guard, and an unbounded user-controlled
    // timer duration is a finding worth keeping impossible BY SHAPE
    // rather than by argument.
    const delayMs = Math.min(ms, MAX_FLOW_SLEEP_MS);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
    // Deliberately does NOT clear `lastSettleReason`: find/wait_for/drag
    // clear it because each one probes the document and thereby PROVES
    // it is reachable again. A sleep proves nothing — it just waits — so
    // a pending navigation-race hint stays armed for the next failure.
    // The implicit target likewise survives untouched, exactly as it
    // survives a wait_for or a drag.
    return { ok: true, entry: { slept_ms: ms } };
  }

  if (kind === 'click') {
    const params = stepRecord.click as ClickStepParams;
    const { resolved, consumed } = resolveTarget(params.selector, state.implicitTarget);
    if (consumed) state.implicitTarget = undefined;
    if (resolved === undefined) {
      return {
        ok: false,
        error: 'click: no selector provided and no implicit target from a preceding find',
      };
    }
    const outcome = await deps.performClick({
      force: params.force,
      settle_ms: params.settle_ms,
      selector: resolved,
    });
    if (!outcome.ok) return { ok: false, error: outcome.error + raceHint() };
    state.lastSettleReason = outcome.result.settle?.reason;
    return { ok: true, entry: compactActionResult(outcome.result) };
  }

  if (kind === 'type') {
    const params = stepRecord.type as TypeStepParams;
    const { resolved, consumed } = resolveTarget(params.selector, state.implicitTarget);
    if (consumed) state.implicitTarget = undefined;
    const outcome = await deps.performType({
      text: params.text,
      clear: params.clear,
      settle_ms: params.settle_ms,
      selector: resolved,
    });
    if (!outcome.ok) return { ok: false, error: outcome.error + raceHint() };
    state.lastSettleReason = outcome.result.settle?.reason;
    return { ok: true, entry: compactActionResult(outcome.result) };
  }

  // press — the only kind left after the checks above.
  const params = stepRecord.press as PressStepParams;
  const { resolved, consumed } = resolveTarget(params.selector, state.implicitTarget);
  if (consumed) state.implicitTarget = undefined;
  const outcome = await deps.performPress({
    key: params.key,
    modifiers: params.modifiers,
    settle_ms: params.settle_ms,
    selector: resolved,
  });
  if (!outcome.ok) return { ok: false, error: outcome.error + raceHint() };
  state.lastSettleReason = outcome.result.settle?.reason;
  return { ok: true, entry: compactActionResult(outcome.result) };
}

/** A `repeat`'s params after shape validation, with defaults resolved. */
interface NormalizedRepeat {
  steps: readonly FlowStep[];
  maxIterations: number;
  whileFound: string | undefined;
  delayMs: number;
}

/** Validate a raw `repeat` body. Shared by the executor and the dry-run
 * planner so a flow can never be projected under looser rules than it
 * would actually run under. */
function normalizeRepeat(
  raw: unknown,
): { ok: true; value: NormalizedRepeat } | { ok: false; error: string } {
  const params = raw as RepeatStepParams | undefined;
  const innerSteps = params?.steps;
  if (!Array.isArray(innerSteps) || innerSteps.length === 0) {
    return { ok: false, error: 'repeat: steps must be a non-empty array' };
  }
  const maxIterations = params?.max_iterations;
  if (
    typeof maxIterations !== 'number' ||
    !Number.isInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > MAX_FLOW_REPEAT_ITERATIONS
  ) {
    return {
      ok: false,
      error: `repeat: max_iterations is required and must be an integer between 1 and ${MAX_FLOW_REPEAT_ITERATIONS}`,
    };
  }
  const whileFound = params?.while_found;
  if (whileFound !== undefined && (typeof whileFound !== 'string' || whileFound.length === 0)) {
    return { ok: false, error: 'repeat: while_found must be a non-empty string' };
  }
  const delayRaw = params?.delay_ms;
  if (
    delayRaw !== undefined &&
    (typeof delayRaw !== 'number' ||
      !Number.isInteger(delayRaw) ||
      delayRaw < 0 ||
      delayRaw > MAX_FLOW_REPEAT_DELAY_MS)
  ) {
    return {
      ok: false,
      error: `repeat: delay_ms must be an integer between 0 and ${MAX_FLOW_REPEAT_DELAY_MS}`,
    };
  }
  for (let j = 0; j < innerSteps.length; j++) {
    const innerKind = stepKind(innerSteps[j]);
    if (!innerKind) {
      return {
        ok: false,
        error: `repeat: step ${j}: each step must be exactly one of find | click | type | press | wait_for | drag | sleep`,
      };
    }
    if (innerKind === 'repeat') {
      return {
        ok: false,
        error: 'repeat: steps may not contain another repeat — nesting is not supported',
      };
    }
  }
  return {
    ok: true,
    value: {
      steps: innerSteps,
      maxIterations,
      whileFound,
      // Bounded with Math.min for the same reason `sleep` is: the guard
      // above already rejected anything larger, so this cannot silently
      // clamp — it makes the timer's ceiling provable from the call site.
      delayMs: Math.min(delayRaw ?? 0, MAX_FLOW_REPEAT_DELAY_MS),
    },
  };
}

/**
 * One-shot presence test for `while_found`.
 *
 * Deliberately reuses the existing `performWaitFor` seam instead of adding
 * a new `FlowDeps` method: `timeout_ms: 0` makes its poll loop run exactly
 * ONE check and return (it evaluates the condition BEFORE testing the
 * deadline), so this is a single in-page probe with no new wiring and
 * identical behaviour on both transports. `condition: 'visible'` matches
 * what `browser.find` considers a real element, so a row that is merely
 * hidden ends the loop just as a removed one does.
 */
async function whileFoundStillMatches(
  selector: string,
  deps: FlowDeps,
): Promise<{ ok: true; matched: boolean } | { ok: false; error: string }> {
  const outcome = await deps.performWaitFor({ selector, condition: 'visible', timeout_ms: 0 });
  if (!outcome.ok) return { ok: false, error: outcome.error };
  return { ok: true, matched: outcome.result.matched };
}

/** Run one `repeat` step to completion. */
async function executeRepeatStep(raw: unknown, deps: FlowDeps): Promise<LeafOutcome> {
  const normalized = normalizeRepeat(raw);
  if (!normalized.ok) return normalized;
  const { steps: innerSteps, maxIterations, whileFound, delayMs } = normalized.value;

  // Local, explicitly range-checked copy of the pause. `normalizeRepeat`
  // already rejected anything outside 0..MAX, so the `else` is
  // unreachable in practice — but the timer's ceiling has to be provable
  // from an upper-bound COMPARISON inside this function. A `Math.min` is
  // not enough here: the value reaches us through a property of the
  // normalized object, and static analysis (CodeQL
  // `js/resource-exhaustion`) does not carry the sanitizer across that
  // hop. An unbounded user-controlled timer duration stays impossible by
  // shape rather than by argument.
  let iterationDelayMs = 0;
  if (Number.isInteger(delayMs) && delayMs > 0 && delayMs <= MAX_FLOW_REPEAT_DELAY_MS) {
    iterationDelayMs = delayMs;
  }

  const iterations: unknown[][] = [];
  let stoppedBy: RepeatStepResult['stopped_by'] = 'max_iterations';

  for (let iter = 0; iter < maxIterations; iter++) {
    if (whileFound !== undefined) {
      const probe = await whileFoundStillMatches(whileFound, deps);
      if (!probe.ok) {
        return { ok: false, error: `repeat: while_found probe failed — ${probe.error}` };
      }
      if (!probe.matched) {
        stoppedBy = 'condition';
        break;
      }
    }

    // Fresh state per iteration: iteration N can never act on whatever
    // iteration N-1's `find` happened to resolve.
    const state: LeafState = { implicitTarget: undefined, lastSettleReason: undefined };
    const entries: unknown[] = [];

    for (let j = 0; j < innerSteps.length; j++) {
      const innerRaw: unknown = innerSteps[j];
      // Re-derived per iteration rather than trusted from normalizeRepeat:
      // same defense-in-depth every other step shape gets.
      const innerKind = stepKind(innerRaw);
      if (innerKind === null || innerKind === 'repeat') {
        return {
          ok: false,
          error: `repeat: iteration ${iter}, step ${j}: invalid step shape`,
        };
      }
      const outcome = await executeLeafStep(
        innerKind,
        innerRaw as Record<StepKind, unknown>,
        state,
        deps,
      );
      if (!outcome.ok) {
        return {
          ok: false,
          error: `repeat: iteration ${iter}, step ${j} (${innerKind}) failed — ${outcome.error}`,
        };
      }
      entries.push(outcome.entry);
    }

    iterations.push(entries);

    if (iterationDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, iterationDelayMs);
      });
    }
  }

  const entry: RepeatStepResult = {
    iterations_completed: iterations.length,
    stopped_by: stoppedBy,
    iterations,
  };
  return { ok: true, entry };
}

/** Total step count INCLUDING a repeat's inner steps. A 20-step ceiling
 * that only counted the outer array would let a single repeat smuggle in
 * an arbitrarily long body. */
function countTotalSteps(steps: readonly FlowStep[]): number {
  let total = 0;
  // Walked as `unknown`, not as FlowStep: the array is typed for
  // ergonomic test-writing but arrives as untrusted JSON cast at the wire
  // boundary, so an entry can genuinely be null or a primitive. Narrowing
  // from `unknown` keeps those guards meaningful instead of letting the
  // declared type talk the compiler out of them.
  for (const step of steps as readonly unknown[]) {
    total++;
    if (typeof step === 'object' && step !== null && 'repeat' in step) {
      const inner = (step as { repeat?: { steps?: unknown } }).repeat?.steps;
      if (Array.isArray(inner)) total += inner.length;
    }
  }
  return total;
}

export interface RunFlowOptions {
  /** Validate and PROJECT the flow without dispatching a single input
   * event, navigation or pause. Answers the one question that matters
   * before an irreversible bulk run — "I am about to do this up to N
   * times; would it even start?" — and is the reason `repeat` and this
   * flag shipped together. */
  dryRun?: boolean;
}

/**
 * Project a flow without executing it. Reads are allowed (a `while_found`
 * probe is a read); nothing is ever dispatched.
 */
async function planFlow(steps: readonly FlowStep[], deps: FlowDeps): Promise<FlowResult> {
  const results: unknown[] = [];
  for (let i = 0; i < steps.length; i++) {
    const raw: unknown = steps[i];
    const kind = stepKind(raw);
    if (!kind) {
      return withRecoverySnapshot(
        deps,
        i,
        'unknown',
        'flow: each step must be exactly one of find | click | type | press | wait_for | drag | sleep | repeat',
        results.length,
      );
    }
    if (kind !== 'repeat') {
      results.push({ step: kind });
      continue;
    }
    const stepRecord = raw as Record<StepKind, unknown>;
    const normalized = normalizeRepeat(stepRecord.repeat);
    if (!normalized.ok) {
      return withRecoverySnapshot(deps, i, kind, normalized.error, results.length);
    }
    const { maxIterations, whileFound, delayMs } = normalized.value;
    let wouldStart = true;
    if (whileFound !== undefined) {
      const probe = await whileFoundStillMatches(whileFound, deps);
      if (!probe.ok) {
        return withRecoverySnapshot(
          deps,
          i,
          kind,
          `repeat: while_found probe failed — ${probe.error}`,
          results.length,
        );
      }
      wouldStart = probe.matched;
    }
    results.push({
      step: 'repeat',
      max_iterations: maxIterations,
      inner_steps: normalized.value.steps.length,
      delay_ms: delayMs,
      ...(whileFound === undefined ? {} : { while_found: whileFound }),
      would_start: wouldStart,
    });
  }
  return { ok: true, steps_completed: 0, results, dry_run: true };
}

/**
 * Run a declarative sequence of steps strictly in order, stopping at the
 * first failure. See the module doc comment for the implicit-target and
 * result-shaping rules.
 *
 * `steps` is typed as `FlowStep[]` for ergonomic test-writing, but every
 * element is re-validated at runtime via `stepKind()` before use — the
 * array may originate from an untrusted JSON payload cast at the wire
 * boundary in `background.ts` (extension) / `cdp/transport.ts` (server),
 * and a malformed entry must fail the flow cleanly rather than throw.
 *
 * With `options.dryRun`, the flow is validated and projected instead:
 * nothing is dispatched, and each entry describes what WOULD run.
 */
export async function runFlow(
  steps: readonly FlowStep[],
  deps: FlowDeps,
  options: RunFlowOptions = {},
): Promise<FlowResult> {
  if (!Array.isArray(steps) || steps.length === 0) {
    return withRecoverySnapshot(deps, 0, 'none', 'flow: steps must be a non-empty array', 0);
  }
  const totalSteps = countTotalSteps(steps);
  if (totalSteps > MAX_FLOW_STEPS) {
    return withRecoverySnapshot(
      deps,
      0,
      'none',
      `flow: at most ${MAX_FLOW_STEPS} steps allowed, got ${totalSteps}`,
      0,
    );
  }

  if (options.dryRun === true) return planFlow(steps, deps);

  const results: unknown[] = [];
  const state: LeafState = { implicitTarget: undefined, lastSettleReason: undefined };

  for (let i = 0; i < steps.length; i++) {
    const raw: unknown = steps[i];
    const kind = stepKind(raw);
    if (!kind) {
      return withRecoverySnapshot(
        deps,
        i,
        'unknown',
        'flow: each step must be exactly one of find | click | type | press | wait_for | drag | sleep | repeat',
        results.length,
      );
    }
    const stepRecord = raw as Record<StepKind, unknown>;

    if (kind === 'repeat') {
      const outcome = await executeRepeatStep(stepRecord.repeat, deps);
      if (!outcome.ok) {
        return withRecoverySnapshot(deps, i, kind, outcome.error, results.length);
      }
      // A repeat body runs with its own state and does not leak one out:
      // a pending implicit target from BEFORE the repeat also does not
      // survive it, since the body may have navigated or re-rendered.
      state.implicitTarget = undefined;
      state.lastSettleReason = undefined;
      results.push(outcome.entry);
      continue;
    }

    const outcome = await executeLeafStep(kind, stepRecord, state, deps);
    if (!outcome.ok) {
      return withRecoverySnapshot(deps, i, kind, outcome.error, results.length);
    }
    results.push(outcome.entry);
  }

  return { ok: true, steps_completed: results.length, results };
}
