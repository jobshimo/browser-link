// GENERATED from packages/core/src/actions/perform-click.ts. Do not edit.
/**
 * `browser.click`: the body both the standalone tool (`tools/interaction.ts`)
 * and a flow's click step call. Moved in slice 10 from `background.ts` and
 * `cdp/transport.ts`, whose two copies `transport-parity.test.ts` kept equal.
 */
import {
  buildClickAimJs,
  buildClickResolveJs,
  buildProgrammaticClickJs,
  clickMissedMessage,
  clickMoveMissedMessage,
  type ClickHitCheckFields,
  HIT_CHECK_DIALOG_NOTE,
} from '../inpage/builders.js';
import type { Clock } from '../ports/clock.js';
import type { Evaluator, Pointer, Settler } from '../ports/page-driver.js';
import {
  noBoxClickMessage,
  notClickableMessage,
  notWalkedSuffix,
  PROGRAMMATIC_CLICK_NOTE,
  refFailureMessage,
  retargetedClickMessage,
  type ActionOutcome,
  type ClickStepResult,
} from '../support/action-results.js';
import {
  beginExpect,
  resolveExpectParams,
  verifyExpect,
  type ExpectParams,
} from '../support/expect.js';
import { resolveSettleParams } from '../support/settle.js';
import type { DialogWatch } from '../session/page-driver.js';
import { checkClickLanding, dispatchPointerPress, moveOntoTarget } from './click-landing.js';

/** A `ref` target the page could not resolve — see `resolveTarget` in
 * `inpage/builders.ts`; `refFailureMessage` (`support/action-results.ts`)
 * turns it into the error string. */
export type RefResolveFailure =
  | { ok: false; reason: 'ref-stale'; ref: string; doc_id?: string }
  | { ok: false; reason: 'observer-unavailable' };

/** Result shape returned by `buildClickResolveJs` — see `inpage/builders.ts`. */
type ClickResolveResult =
  | {
      ok: true;
      x: number;
      y: number;
      tag: string;
      hit_element?: string;
      reresolved?: boolean;
      hit_check?: 'not_verifiable';
    }
  | { ok: true; no_box: true; tag: string; reresolved?: boolean }
  | { ok: false; reason: 'no-box' }
  | { ok: false; reason: 'invalid-selector'; error: string }
  | { ok: false; reason: 'not-found'; not_walked?: string }
  | { ok: false; reason: 'occluded'; blocker: string }
  | { ok: false; reason: 'retargeted'; hit_element: string }
  | RefResolveFailure;

/** Result shape returned by `buildProgrammaticClickJs` (owner decision D4). */
type ProgrammaticClickResult =
  | { ok: true }
  | { ok: false; reason: 'invalid-selector'; error: string }
  | { ok: false; reason: 'not-found'; not_walked?: string }
  | { ok: false; reason: 'not-clickable'; why: string }
  | RefResolveFailure;

export interface ClickParams {
  /** Exactly one of `selector` / `ref`. */
  selector?: string;
  ref?: string;
  force?: boolean;
  settle_ms?: number;
  settle_timeout_ms?: number;
  expect?: ExpectParams;
}

/** What a click uses: the page, the pointer, the settle wait, the time and,
 * where the transport tracks them (the extension), the dialog watch. */
export interface ClickDeps {
  evaluator: Evaluator;
  pointer: Pointer;
  settler: Settler;
  clock: Clock;
  dialogs?: DialogWatch;
}

export async function performClick(
  deps: ClickDeps,
  params: ClickParams,
): Promise<ActionOutcome<ClickStepResult>> {
  const { evaluator, settler, clock } = deps;
  try {
    const { selector, ref, force = false } = params;
    const settle = resolveSettleParams({
      settle_ms: params.settle_ms,
      settle_timeout_ms: params.settle_timeout_ms,
    });
    const expectSpec = resolveExpectParams(params.expect);
    const evaluate = (expression: string): Promise<unknown> => evaluator.evaluate(expression);
    let resolved = await evaluator.evaluate<ClickResolveResult>(
      buildClickResolveJs(ref !== undefined ? { ref, force } : { selector, force }),
    );
    if (resolved.ok && !('no_box' in resolved)) {
      // The resolve scrolled the target into view; aim once the new layout
      // was painted, and arm the watch that proves where the press lands.
      resolved = await evaluator.evaluate<ClickResolveResult>(
        buildClickAimJs(ref !== undefined ? { ref, force } : { selector, force }),
      );
    }
    if (!resolved.ok) {
      const refError = ref !== undefined ? refFailureMessage(resolved, ref) : null;
      if (refError) return { ok: false, error: refError };
      if (resolved.reason === 'occluded') {
        return {
          ok: false,
          error: `Element covered by ${resolved.blocker} — click the covering element or dismiss it first`,
        };
      }
      if (resolved.reason === 'retargeted') {
        return {
          ok: false,
          error: retargetedClickMessage(resolved.hit_element, ref ?? selector ?? ''),
        };
      }
      if (resolved.reason === 'no-box') {
        return { ok: false, error: noBoxClickMessage(ref ?? selector ?? '') };
      }
      if (resolved.reason === 'invalid-selector') {
        return { ok: false, error: `Invalid selector "${selector}": ${resolved.error}` };
      }
      return {
        ok: false,
        error: `Element not found: ${ref ?? selector}${notWalkedSuffix(resolved)}`,
      };
    }
    const mark = await settler.mark(settle);
    const baseline = await beginExpect(evaluate, expectSpec, clock);
    let hitCheckNote: string | undefined;
    let dialogOpened = false;
    if ('no_box' in resolved) {
      const clicked = await evaluator.evaluate<ProgrammaticClickResult>(
        buildProgrammaticClickJs(ref !== undefined ? { ref } : { selector }),
      );
      if (!clicked.ok) {
        if (clicked.reason === 'not-clickable') {
          return { ok: false, error: notClickableMessage(ref ?? selector ?? '', clicked.why) };
        }
        const refError = ref !== undefined ? refFailureMessage(clicked, ref) : null;
        return {
          ok: false,
          error: refError ?? `Element not found: ${ref ?? selector}${notWalkedSuffix(clicked)}`,
        };
      }
    } else {
      // The press is sent only once the move was seen on the target (a
      // frame element's cannot be: it is clicked as before, not verified).
      // A JavaScript dialog the click opens pauses the page: the dispatch
      // answers at once, and nothing after it can be checked.
      const moved = await moveOntoTarget(
        deps,
        resolved.x,
        resolved.y,
        resolved.hit_check !== 'not_verifiable',
      );
      if (moved.miss) {
        return {
          ok: false,
          error: clickMoveMissedMessage(ref ?? selector ?? '', resolved, moved.tries, moved.miss),
        };
      }
      dialogOpened =
        moved.dialog || (await dispatchPointerPress(deps, resolved.x, resolved.y)).dialog;
      if (dialogOpened) {
        hitCheckNote = HIT_CHECK_DIALOG_NOTE;
      } else {
        // Report the click only where its press was seen; when that cannot be
        // known (a frame element, a dialog, a replaced document) say so.
        const landing = await checkClickLanding(deps, resolved.hit_check === 'not_verifiable');
        if (landing.missed) {
          return {
            ok: false,
            error: clickMissedMessage(ref ?? selector ?? '', resolved, landing.landed_on),
          };
        }
        hitCheckNote = landing.note;
      }
    }
    const settleResult = dialogOpened ? undefined : await settler.settle(settle, mark);
    const verdict = dialogOpened
      ? { ok: true as const, expect: undefined }
      : await verifyExpect(evaluate, expectSpec, baseline, settleResult, clock);
    if (!verdict.ok) return { ok: false, error: verdict.error };
    const result: ClickStepResult & ClickHitCheckFields = {
      clicked: ref ?? selector ?? '',
      tag: resolved.tag,
    };
    if (ref !== undefined) result.ref = ref;
    if (resolved.reresolved === true) result.reresolved = true;
    if ('no_box' in resolved) result.programmatic_click = PROGRAMMATIC_CLICK_NOTE;
    else if (resolved.hit_element) result.hit_element = resolved.hit_element;
    if (hitCheckNote !== undefined) {
      result.hit_check = 'not_verifiable';
      result.hit_check_note = hitCheckNote;
    }
    if (settleResult) result.settle = settleResult;
    if (verdict.expect) result.expect = verdict.expect;
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
