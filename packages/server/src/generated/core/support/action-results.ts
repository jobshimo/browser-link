// GENERATED from packages/core/src/support/action-results.ts. Do not edit.
/**
 * What an action reports, shared by the actions (`actions/perform-*.ts`),
 * the flow engine that sequences them (`flow/flow-engine.ts`) and the tool
 * entries that map them to a `ToolOutcome` (`tools/`): the outcome shape,
 * the error texts both transports report, and the find, click, type,
 * press, wait_for and drag results. Moved verbatim from
 * `flow/flow-engine.ts` in slices 10 (find, click), 11 (type, press), 13
 * (wait_for) and 14 (drag), because `actions` may not import `flow`
 * (design 5.2); the flow engine re-exports them.
 */
import type { ExpectMet } from './expect.js';

/** Structured success/failure outcome shared by every perform* function
 * (core's `actions/`, and the ones `background.ts` and `cdp/transport.ts`
 * still hold until their slices move them).
 * `ok:false` carries the exact same error string the standalone
 * tool.response would have returned for that failure — both the tool
 * entries and the flow engine's step executor consume this shape, so the
 * two call paths can never drift. */
/** `sensitive_field` on a failure: a `type` / `press` failed after finding the
 * focused field sensitive (see `actionFailure` in `inpage/builders.ts`). */
export type ActionOutcome<T> =
  { ok: true; result: T } | { ok: false; error: string; sensitive_field?: boolean };

/** The error text for an action target given as an observer `ref` (spec v4
 * §6.3) that could not be resolved, shared by both transports' perform*
 * functions so the extension and cdp-direct report the same string.
 * `failure` is the in-page `resolveTarget` result (see `PAGE_OBSERVER_JS`
 * in `inpage/builders.ts`). The `ref-stale:` prefix is a stable contract.
 * Returns `null` for any other reason, which the caller reports as it
 * always did. */
export function refFailureMessage(
  failure: { reason?: string; doc_id?: string },
  ref: string,
): string | null {
  if (failure.reason === 'ref-stale') {
    return `ref-stale: ${ref} not found in document ${failure.doc_id ?? 'unknown'}: the element is gone, take a new snapshot`;
  }
  if (failure.reason === 'observer-unavailable') {
    return `observer-unavailable: ref ${ref} cannot be resolved without the page observer`;
  }
  return null;
}

/** ' (<note>)' when a result says part of the page was not walked (the
 * deep-query depth guard fired, see `NOT_WALKED_NOTE` in
 * `inpage/builders.ts`), else empty: a miss there may be a cut. */
export function notWalkedSuffix(result: object): string {
  const note = (result as { not_walked?: unknown }).not_walked;
  return typeof note === 'string' ? ` (${note})` : '';
}

/** The error text for a click whose predicted hit lands on an ancestor of
 * the target instead of the target itself (the in-page resolve reports
 * `reason: 'retargeted'`, see `checkOcclusion` in `inpage/deep-query.ts`):
 * the target is painted but not at its own centre — clipped by an overflow
 * container, zero-size, or covered by its own parent. Shared by both
 * transports' `performClick` so the standalone tool and a flow click step
 * report the same string. `target` is the selector or ref as given. */
export function retargetedClickMessage(hitElement: string, target: string): string {
  return (
    `Click would land on ${hitElement}, not on ${target}: scroll or expand its container, ` +
    'or target the element that receives clicks; force: true clicks there anyway'
  );
}

/** The error text for a click on a target with no visible box (the in-page
 * resolve reports `reason: 'no-box'`, see `hasVisibleBox` in
 * `inpage/deep-query.ts`): owner decision D4, never a pointer click at
 * (0,0). Shared by both transports' `performClick`. `target` is the
 * selector or ref as given. */
export function noBoxClickMessage(target: string): string {
  return (
    `Element ${target} has no visible box (not rendered, visibility-hidden, or an option of a select), ` +
    'so there is no point to click: make it visible first (open its menu, dialog or section), ' +
    "or pass force: true to call the element's own click() with no pointer"
  );
}

/** The error text for a `force` click on a target with no visible box whose
 * own `click()` could do nothing (the in-page programmatic click reports
 * `reason: 'not-clickable'`, see `buildProgrammaticClickJs`): a disabled
 * control (the element or a disabling ancestor fieldset), or an `<option>` /
 * `<optgroup>`, which `click()` never selects. Nothing was clicked. Shared
 * by both transports' `performClick`. `target` is the selector or ref as
 * given. */
export function notClickableMessage(target: string, why: string): string {
  if (why === 'option') {
    return (
      `Element ${target} is an <option> (or <optgroup>): clicking an option does nothing ` +
      "and it never selects it, so nothing was clicked; the select's value must be set instead"
    );
  }
  return (
    `Element ${target} is disabled, so its own click() does nothing and nothing was clicked: ` +
    'wait until it is enabled, or find the control that enables it'
  );
}

/** The error text for a `type` / `press` whose target did not take focus
 * (the in-page resolve reports `reason: 'not-focused'`, see
 * `FOCUS_REFUSAL_JS` in `inpage/builders.ts`): the text or key would have
 * gone to whatever had focus before, so nothing was sent. Shared by both
 * transports. `target` is the selector or ref as given; `why` is the
 * in-page guess at the cause. */
export function notFocusedMessage(
  target: string,
  why: string,
  action: 'typed' | 'pressed',
): string {
  return (
    `Element ${target} did not take focus (${why}), so nothing was ${action}: ` +
    'the input would have gone to whatever had focus before; target the field itself'
  );
}

/** The value of `programmatic_click` on a click result (owner decision D4):
 * a `force` click on a target with no visible box called the element's own
 * `click()` instead of the mouse. */
export const PROGRAMMATIC_CLICK_NOTE =
  'the target has no visible box, so its own click() was called: no pointer, no mouse events, no coordinates';

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
  /** The observer ref of the matched element (present when the page
   * observer is installed). The implicit target a find step leaves stays
   * its `selector`. */
  ref?: string;
  /** Set when a find by `ref` re-resolved a replaced node. */
  reresolved?: boolean;
  ambiguous?: boolean;
  tag?: string;
  text?: string;
  coords?: { x: number; y: number };
  frame?: string;
  /** On a cut `multiple-matches` answer: what was left out (owner decision
   * D6, see `buildFindJs`). */
  truncated?: { candidates?: number; next_offset?: { candidates?: number }; hint?: string };
  /** Set when the deep-query depth guard left part of the page unwalked. */
  not_walked?: string;
}

export interface ClickStepResult {
  /** The selector, or the ref, the click was asked for. */
  clicked: string;
  tag: string;
  /** Present when the target was given as a ref. */
  ref?: string;
  /** Present (true) only when the ref's node was gone and was re-resolved
   * by its semantic key. */
  reresolved?: boolean;
  /** Descriptor of the element that actually receives the dispatched
   * click, present ONLY when it differs from the resolved target: a
   * pointer-events:none target whose real hit-target sibling takes the
   * click, an ancestor wrapper, or a `force:true` click landing on
   * whatever covers the point (see `buildClickResolveJs`). Omitted when
   * the click lands on the target itself. */
  hit_element?: string;
  /** Present only when a `force` click found no visible box on the target
   * and called its own `click()` instead of the mouse; the value is
   * `PROGRAMMATIC_CLICK_NOTE` (owner decision D4). */
  programmatic_click?: string;
  /** `'not_verifiable'` when where the press landed could not be checked
   * (a frame element, a JavaScript dialog, a replaced document, no answer);
   * `hit_check_note` says why. Absent when the landing was verified. */
  hit_check?: 'not_verifiable';
  hit_check_note?: string;
  settle?: Record<string, unknown>;
  expect?: ExpectMet;
}

export interface TypeStepResult {
  typed: number;
  selector?: string;
  ref?: string;
  reresolved?: boolean;
  /** True when the focused field is one the page declares sensitive (see
   * `buildFocusedFieldJs`), false when it is not; absent when the probe
   * answered nothing usable. */
  sensitive_field?: boolean;
  settle?: Record<string, unknown>;
  expect?: ExpectMet;
}

export interface PressStepResult {
  key: string;
  modifiers: string[];
  ref?: string;
  reresolved?: boolean;
  /** True when the focused field is one the page declares sensitive (see
   * `buildFocusedFieldJs`), false when it is not; absent when the probe
   * answered nothing usable. */
  sensitive_field?: boolean;
  settle?: Record<string, unknown>;
  expect?: ExpectMet;
}

export interface WaitForStepResult {
  matched: boolean;
  elapsed_ms: number;
  checks: number;
  /** `'timeout'` on a genuine non-match. `'cancelled'` when the poll loop
   * was cut short by the flow's cancellation flag — a DIFFERENT outcome
   * that the step executor must not report as a timeout failure, since the
   * condition was never given its full budget. `performWaitFor` sets this. */
  reason?: string;
  /** Only on a timeout of a `wait_for` by ref (`visible` / `attached`) whose
   * element was gone at the last poll: `<ref> not found in document
   * <doc_id>: the element is gone, take a new snapshot`. */
  ref_gone?: string;
}

/** Full result of one drag — the same shape the standalone tool returns.
 * A flow step's per-step entry keeps only `drag_mode` of this (see
 * `compactActionResult`): the endpoints and durations echo what the
 * caller asked for, while `drag_mode` is NEW information — whether HTML5
 * native drag (dragstart/drop) or pointer-only events fired, the signal
 * for diagnosing a silently-failing drop. Moved from `flow/flow-engine.ts`
 * in slice 14. */
export interface DragStepResult {
  from: { x: number; y: number; selector: string | null };
  to: { x: number; y: number; selector: string | null };
  duration_ms_actual: number;
  drag_mode: 'html5' | 'pointer';
  interception_attempted: boolean;
  intercept_received: boolean;
  events_fired: string[];
}
