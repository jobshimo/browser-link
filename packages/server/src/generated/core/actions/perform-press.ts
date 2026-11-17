// GENERATED from packages/core/src/actions/perform-press.ts. Do not edit.
/**
 * `browser.press`: the body both the standalone tool (`tools/interaction.ts`)
 * and a flow's press step call. Moved in slice 11 from `background.ts` and
 * `cdp/transport.ts`, whose two copies `transport-parity.test.ts` kept equal;
 * the key goes in through the page driver's keyboard (`pressKey`).
 *
 * The sensitive-field rule is `performType`'s: the focused field is read
 * before the key is sent, and a failure after that carries
 * `sensitive_field: true` when the field is sensitive (`actionFailure`).
 */
import {
  actionFailure,
  buildFocusJs,
  buildFocusedFieldJs,
  isFocusedField,
} from '../inpage/builders.js';
import type { Clock } from '../ports/clock.js';
import type { Evaluator, Keyboard, Settler } from '../ports/page-driver.js';
import { pressKey } from '../session/page-driver.js';
import {
  notFocusedMessage,
  refFailureMessage,
  type ActionOutcome,
  type PressStepResult,
} from '../support/action-results.js';
import {
  beginExpect,
  resolveExpectParams,
  verifyExpect,
  type ExpectParams,
} from '../support/expect.js';
import { MODIFIER_BITS, modifiersToBitmask, resolveKey } from '../support/keymap.js';
import { resolveSettleParams } from '../support/settle.js';
import type { RefResolveFailure } from './perform-click.js';
import type { FocusRefusal } from './perform-type.js';

/** Result shape of `buildFocusJs` with a `ref` (with a selector it is
 * `true`, `false` when not found, or a `FocusRefusal`). */
type FocusRefResult = { ok: true; reresolved?: boolean } | FocusRefusal | RefResolveFailure;

export interface PressParams {
  key?: string;
  modifiers?: string[];
  selector?: string;
  /** Exclusive with `selector`. */
  ref?: string;
  settle_ms?: number;
  settle_timeout_ms?: number;
  expect?: ExpectParams;
}

/** What a press uses: the page's evaluator, keyboard and settle wait, and
 * the time the expectation probes run on. */
export interface PressDeps {
  evaluator: Evaluator;
  keyboard: Keyboard;
  settler: Settler;
  clock: Clock;
}

export async function performPress(
  { evaluator, keyboard, settler, clock }: PressDeps,
  params: PressParams,
): Promise<ActionOutcome<PressStepResult>> {
  let field: unknown;
  try {
    const key = params.key;
    if (!key) return { ok: false, error: 'press: key required' };
    const def = resolveKey(key);
    if (!def) return { ok: false, error: `press: unrecognized key "${key}"` };
    const modifierNames = params.modifiers ?? [];
    const modifiers =
      modifiersToBitmask(modifierNames) | (def.needsShift ? MODIFIER_BITS.Shift : 0);
    const settle = resolveSettleParams({
      settle_ms: params.settle_ms,
      settle_timeout_ms: params.settle_timeout_ms,
    });
    const expectSpec = resolveExpectParams(params.expect);
    const evaluate = (expression: string): Promise<unknown> => evaluator.evaluate(expression);
    const ref = params.ref;
    let reresolved = false;
    if (ref !== undefined) {
      const focused = await evaluator.evaluate<FocusRefResult>(buildFocusJs({ ref }));
      if (!focused.ok) {
        if (focused.reason === 'not-focused') {
          return { ok: false, error: notFocusedMessage(ref, focused.why, 'pressed') };
        }
        return { ok: false, error: refFailureMessage(focused, ref) ?? `Element not found: ${ref}` };
      }
      reresolved = focused.reresolved === true;
    } else if (params.selector) {
      const focused = await evaluator.evaluate<boolean | FocusRefusal>(
        buildFocusJs({ selector: params.selector }),
      );
      if (!focused) {
        return { ok: false, error: `Element not found: ${params.selector}` };
      }
      if (focused !== true && 'why' in focused) {
        return { ok: false, error: notFocusedMessage(params.selector, focused.why, 'pressed') };
      }
    }
    field = await evaluate(buildFocusedFieldJs()).catch(() => undefined);
    const mark = await settler.mark(settle);
    const baseline = await beginExpect(evaluate, expectSpec, clock);
    await pressKey(keyboard, def, modifiers);
    const settleResult = await settler.settle(settle, mark);
    const verdict = await verifyExpect(evaluate, expectSpec, baseline, settleResult, clock);
    if (!verdict.ok) return actionFailure(verdict.error, field);
    const result: PressStepResult = { key, modifiers: modifierNames };
    if (ref !== undefined) result.ref = ref;
    if (reresolved) result.reresolved = true;
    if (isFocusedField(field)) result.sensitive_field = field.sensitive_field;
    if (settleResult) result.settle = settleResult;
    if (verdict.expect) result.expect = verdict.expect;
    return { ok: true, result };
  } catch (err) {
    return actionFailure(err instanceof Error ? err.message : String(err), field);
  }
}
