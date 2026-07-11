/**
 * Pure, chrome.*-free logic for turning captured in-page recorder events
 * (see `inpage/recorder.ts`) into `browser.flow`-grammar steps (see
 * `flow.ts`'s `FlowStep`), enforcing the 20-step cap, and building the
 * navigation `wait_for` hint. background.ts owns the CDP binding, the
 * `chrome.tabs.onUpdated` navigation signal, and the actual step array for
 * an in-progress recording; every DECISION about what that array should
 * contain next lives here, unit-tested without a real browser tab — same
 * separation `idle-policy.ts` and `settle.ts` already established.
 *
 * PRIVACY NOTE: `toFlowStep` is the ONLY place a `type` step's `text`
 * field is ever set, and it is ALWAYS the constant `TEXT_PLACEHOLDER`
 * (`"<TEXT>"`) — there is no code path here, or in `inpage/recorder.ts`,
 * that has access to a field's real value in the first place.
 */
import type { FlowStep } from './flow.js';

/** Mirrors `MAX_FLOW_STEPS` in flow.ts / the server's `browser.flow` schema
 * — a recording can never produce more steps than a flow recipe can hold. */
export const MAX_RECORDING_STEPS = 20;

/** The ONLY string ever used for a recorded `type` step's `text` field.
 * See the module doc — recorder.ts never transmits the real value, so this
 * constant is never substituting anything sensitive; it exists purely so
 * the recipe is immediately recognizable as needing a real value filled in
 * before replay (same placeholder convention `browser.map.save` already
 * documents for hand-written flow recipes). */
export const TEXT_PLACEHOLDER = '<TEXT>';

/** The default navigation-hint step suggested after a step that caused the
 * tab to navigate. `expression` is a valid `wait_for` mode per the
 * `browser.flow` schema (`oneOf: [selector, expression, network_url]`) —
 * kept intentionally simple (readyState) rather than guessing at a
 * selector on a document the recorder has not seen yet. Rendered by the
 * popup as an EDITABLE suggestion, not a fixed fact — the user (or a later
 * agent editing the saved recipe) may replace it with a more specific
 * selector-based wait. */
export function buildNavigationWaitForStep(): FlowStep {
  return { wait_for: { expression: "document.readyState === 'complete'" } };
}

/** Raw payload shapes emitted by `inpage/recorder.ts` over the CDP
 * binding — one JSON string per call. Mirrors the payload shapes
 * documented in recorder.ts's module doc (minus the transport-level
 * `nonce`, which `parseRecordedPayload` consumes and strips). */
export type RecordedPayload =
  | { kind: 'click'; selector: string; ambiguous?: boolean }
  | { kind: 'type'; selector: string; ambiguous?: boolean }
  | { kind: 'press'; key: string };

/** Fresh per-recording-session identifiers (see recorder.ts's THREAT MODEL
 * doc). The three global NAMES (binding, active-flag, stop-fn) are
 * INDEPENDENT random values with no shared prefix OR suffix — so a page
 * cannot cheaply enumerate `Object.getOwnPropertyNames(window)` for a
 * predictable pattern (`startsWith('__blRec_')`, `endsWith('_active')`, …)
 * to detect that recording is active; every recorder global is
 * indistinguishable from an ordinary random page global. The `nonce` is the
 * shared secret that authenticates every payload. All are generated from
 * `crypto.randomUUID()` — available in the MV3 service worker, the popup,
 * and every test environment this repo targets (Node >= 19). A leading
 * letter is prepended so each name is a syntactically valid identifier
 * (the recorder accesses every global via bracket notation, so this is
 * belt-and-braces, not strictly required). */
export interface RecordingSession {
  bindingName: string;
  activeFlag: string;
  stopFn: string;
  nonce: string;
}

export function generateRecordingSession(): RecordingSession {
  // A fresh bare random identifier per call. 32 hex chars from randomUUID,
  // with the FIRST char remapped to a letter whose value still varies with
  // the random input (hex letters a-f pass through; digits 0-9 map to g-p).
  // Result: a valid identifier with NO fixed, shared, guessable prefix or
  // suffix across sessions — nothing a page can pattern-match on.
  const rand = (): string => {
    const hex = crypto.randomUUID().replace(/-/g, '');
    const first = hex[0];
    const firstLetter = /[0-9]/.test(first)
      ? String.fromCharCode('g'.charCodeAt(0) + Number(first))
      : first;
    return firstLetter + hex.slice(1);
  };
  return { bindingName: rand(), activeFlag: rand(), stopFn: rand(), nonce: rand() };
}

/** Upper bound on a recorded selector's length. genSelectorInfo's worst
 * case (a fully-qualified 32-part structural path) sits far below this;
 * anything longer is not a selector the recorder produced. */
export const MAX_RECORDED_SELECTOR_LENGTH = 1000;

/** The ONLY keys the recorder ever emits as a `press` payload — the
 * allowlist `parseRecordedPayload` enforces. Deliberately NOT the full set
 * `browser.press` accepts: recorder-originated steps are validated MORE
 * strictly than agent-authored ones, because the binding channel they
 * arrive over is callable by page scripts (see recorder.ts's THREAT MODEL
 * doc). Kept in sync by hand with recorder.ts's SPECIAL_KEYS + Enter. */
export const RECORDED_PRESS_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/**
 * Characters no legitimate CSS selector generated by genSelectorInfo can
 * contain: C0 + DEL + C1 controls, ZWSP, line/paragraph separators, the
 * legacy bidi embedding/override controls (LRE..RLO), WORD JOINER, the
 * modern bidi isolate block (LRI..PDI), and BOM. Deliberately does NOT
 * block ZWJ (U+200D — present in every multi-codepoint emoji sequence) or
 * LRM/RLM (U+200E/U+200F — embedded by RTL-aware sites): genSelectorInfo's
 * aria-label branch inlines raw attribute text, so a legit label carrying
 * an emoji or directional mark must still parse. The nonce remains the
 * real gate; this is defense in depth against a selector-shaped smuggling
 * attempt using genuinely invisible / spoofing characters.
 */
/* eslint-disable no-control-regex -- intentionally matches control chars */
const CONTROL_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u200B\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/;
/* eslint-enable no-control-regex */
/**
 * Parse + validate one `Runtime.bindingCalled` payload string against the
 * ACTIVE session's nonce. Returns `null` on anything malformed — and the
 * bar here is deliberately HIGHER than the generic `validateFlowSteps`,
 * because the CDP binding is callable by any script running in the target
 * page (see recorder.ts's THREAT MODEL doc), not just the recorder:
 *
 *  - the payload's `nonce` must equal `expectedNonce` (the per-session
 *    secret only the injected recorder knows) — a blind page-script call
 *    fails HERE and records nothing;
 *  - `selector` is length-capped and rejected on control characters, so
 *    the channel cannot smuggle arbitrary blobs (e.g. a cookie string
 *    disguised as a selector) into the map DB;
 *  - `key` must be on the exact allowlist of keys the recorder emits.
 */
export function parseRecordedPayload(raw: string, expectedNonce: string): RecordedPayload | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.nonce !== 'string' || o.nonce !== expectedNonce) return null;
  if (o.kind === 'click' || o.kind === 'type') {
    if (typeof o.selector !== 'string' || o.selector.length === 0) return null;
    if (o.selector.length > MAX_RECORDED_SELECTOR_LENGTH) return null;
    if (CONTROL_CHARS.test(o.selector)) return null;
    const ambiguous = o.ambiguous === true;
    return ambiguous
      ? { kind: o.kind, selector: o.selector, ambiguous: true }
      : { kind: o.kind, selector: o.selector };
  }
  if (o.kind === 'press') {
    if (typeof o.key !== 'string' || !RECORDED_PRESS_KEYS.has(o.key)) return null;
    return { kind: 'press', key: o.key };
  }
  return null;
}

/**
 * Convert one captured payload into its `browser.flow`-grammar step. The
 * `type` branch is the privacy boundary described in the module doc — the
 * placeholder is a constant, never derived from anything the payload
 * carries (the payload has no field capable of carrying a real value in
 * the first place).
 *
 * The payload's `ambiguous` flag is deliberately NOT embedded in the step
 * itself: `browser.flow`'s JSON schema sets `additionalProperties: false`
 * on every step body, so an extra key would make the recipe fail schema
 * validation at REPLAY time. Instead, background.ts tracks which step
 * indices were ambiguous (`RecordingState.ambiguousStepIndices`), the
 * popup surfaces a per-step warning in the review list, and
 * `buildAmbiguousNote` below folds the same information into the saved
 * recipe's description — the computed safety signal is surfaced, never
 * silently dropped.
 */
export function toFlowStep(payload: RecordedPayload): FlowStep {
  switch (payload.kind) {
    case 'click':
      return { click: { selector: payload.selector } };
    case 'type':
      return { type: { selector: payload.selector, text: TEXT_PLACEHOLDER } };
    case 'press':
      return { press: { key: payload.key } };
  }
}

/**
 * Human-readable caution for a recipe whose recorded selectors could not
 * be made unique across the page's deep search scope (see
 * `genSelectorInfo`'s `ambiguous` flag). `indices` are 0-based step
 * positions; the note renders them 1-based to match the popup's numbered
 * review list. Returns `null` when nothing was ambiguous, so callers can
 * skip touching the description entirely in the common case.
 */
export function buildAmbiguousNote(indices: readonly number[]): string | null {
  if (indices.length === 0) return null;
  const human = indices.map((i) => i + 1).join(', ');
  const plural = indices.length === 1 ? 'Step' : 'Steps';
  return (
    `${plural} ${human}: selector may match multiple elements ` +
    `(resolves first-match-wins) — verify before replaying.`
  );
}

/** Result of appending a step to an in-progress recording. `capped: true`
 * means the 20-step ceiling was already reached BEFORE this call — the
 * step was NOT appended, and background.ts should auto-stop the
 * recording and surface the cap notice to the popup. */
export interface AppendResult {
  steps: FlowStep[];
  capped: boolean;
}

/** Append one already-converted `FlowStep` to a recording's step list,
 * enforcing `MAX_RECORDING_STEPS`. Pure — returns a NEW array, never
 * mutates `steps`, so background.ts can keep using the previous array if
 * `capped` comes back true. */
export function appendRecordingStep(steps: readonly FlowStep[], step: FlowStep): AppendResult {
  if (steps.length >= MAX_RECORDING_STEPS) {
    return { steps: [...steps], capped: true };
  }
  return { steps: [...steps, step], capped: false };
}

/**
 * Decide whether a newly-observed tab URL represents a navigation that
 * happened WHILE recording (vs. e.g. a same-document hash change or a
 * redundant `chrome.tabs.onUpdated` "complete" event for the URL already
 * being recorded). Pure string comparison — background.ts is responsible
 * for tracking `lastRecordedUrl` and calling this on every "complete"
 * update for the recording tab.
 *
 * LIMITATION (documented in the README): the caller drives this off
 * `chrome.tabs.onUpdated`'s "complete" status, which does NOT fire for
 * single-page-app route changes done purely via the History API
 * (`pushState`/`replaceState`, no document load). Those transitions get no
 * automatic `wait_for` hint step; a user editing the recipe adds one by
 * hand if replay needs to wait for the SPA route to settle.
 */
export function isNavigationForRecording(lastRecordedUrl: string, currentUrl: string): boolean {
  return currentUrl.length > 0 && currentUrl !== lastRecordedUrl;
}

/** One-line human-readable description of a `FlowStep`, for the popup's
 * step review list. Deliberately terse — the popup shows these in a
 * scrollable `<ol>` alongside the step count. */
export function describeFlowStep(step: FlowStep): string {
  if ('click' in step) return `Click ${step.click.selector ?? '(implicit target)'}`;
  if ('type' in step) return `Type into ${step.type.selector ?? '(focused field)'}`;
  if ('press' in step) return `Press ${step.press.key}`;
  if ('wait_for' in step) {
    const w = step.wait_for;
    if (w.selector) return `Wait for ${w.selector}`;
    if (w.expression) return `Wait for ${w.expression}`;
    if (w.network_url) return `Wait for network: ${w.network_url}`;
    return 'Wait';
  }
  if ('find' in step) return `Find "${step.find.text}"`;
  return 'Unknown step';
}
