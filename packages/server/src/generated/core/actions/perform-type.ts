// GENERATED from packages/core/src/actions/perform-type.ts. Do not edit.
/**
 * `browser.type`: the body both the standalone tool (`tools/interaction.ts`)
 * and a flow's type step call. Moved in slice 11 from `background.ts` and
 * `cdp/transport.ts`, whose two copies `transport-parity.test.ts` kept equal;
 * the text goes in through the page driver's `Keyboard.insertText`.
 *
 * The sensitive-field rule (owner decision, 1.0.0): the focused field is read
 * before the text is sent (`buildFocusedFieldJs`); a failure after that
 * carries `sensitive_field: true` when the field is sensitive
 * (`actionFailure`), which the tool entry maps to the `sensitive` kind.
 *
 * `selector` is optional here (the standalone tool's JSON schema still
 * requires it, so that path never changes): when omitted, this skips element
 * resolution entirely and types into whatever currently has focus, mirroring
 * how `performPress` behaves with no `selector`. That is what lets a
 * `browser.flow` step continue typing into a freshly-appeared, auto-focused
 * input (e.g. a search box that opened after a preceding click) without a
 * selector for it.
 */
import {
  actionFailure,
  buildFocusedFieldJs,
  buildTypeResolveJs,
  isFocusedField,
} from '../inpage/builders.js';
import type { Clock } from '../ports/clock.js';
import type { Evaluator, Keyboard, Settler } from '../ports/page-driver.js';
import {
  notFocusedMessage,
  notWalkedSuffix,
  refFailureMessage,
  type ActionOutcome,
  type TypeStepResult,
} from '../support/action-results.js';
import {
  beginExpect,
  resolveExpectParams,
  verifyExpect,
  type ExpectParams,
} from '../support/expect.js';
import { resolveSettleParams } from '../support/settle.js';
import type { RefResolveFailure } from './perform-click.js';

/** The target of a type / press did not take focus — see `FOCUS_REFUSAL_JS`
 * in `inpage/builders.ts`; `notFocusedMessage` (`support/action-results.ts`)
 * gives the error. */
export type FocusRefusal = { ok: false; reason: 'not-focused'; why: string };

/** Result shape returned by `buildTypeResolveJs` — see `inpage/builders.ts`. */
type TypeResolveResult =
  | { ok: true; reresolved?: boolean }
  | { ok: false; reason: 'invalid-selector'; error: string }
  | { ok: false; reason: 'not-found'; not_walked?: string }
  | FocusRefusal
  | RefResolveFailure;

export interface TypeParams {
  selector?: string;
  /** Exclusive with `selector`. */
  ref?: string;
  text: string;
  clear?: boolean;
  settle_ms?: number;
  settle_timeout_ms?: number;
  expect?: ExpectParams;
}

/** What a type uses: the page's evaluator, keyboard and settle wait, and the
 * time the expectation probes run on. */
export interface TypeDeps {
  evaluator: Evaluator;
  keyboard: Keyboard;
  settler: Settler;
  clock: Clock;
}

export async function performType(
  { evaluator, keyboard, settler, clock }: TypeDeps,
  params: TypeParams,
): Promise<ActionOutcome<TypeStepResult>> {
  let field: unknown;
  try {
    const { selector, ref, text, clear = false } = params;
    const settle = resolveSettleParams({
      settle_ms: params.settle_ms,
      settle_timeout_ms: params.settle_timeout_ms,
    });
    const expectSpec = resolveExpectParams(params.expect);
    const evaluate = (expression: string): Promise<unknown> => evaluator.evaluate(expression);
    let reresolved = false;
    if (ref !== undefined) {
      const resolved = await evaluator.evaluate<TypeResolveResult>(
        buildTypeResolveJs({ ref, clear }),
      );
      if (!resolved.ok) {
        if (resolved.reason === 'not-focused') {
          return { ok: false, error: notFocusedMessage(ref, resolved.why, 'typed') };
        }
        return {
          ok: false,
          error: refFailureMessage(resolved, ref) ?? `Element not found: ${ref}`,
        };
      }
      reresolved = resolved.reresolved === true;
    } else if (selector !== undefined) {
      const resolved = await evaluator.evaluate<TypeResolveResult>(
        buildTypeResolveJs({ selector, clear }),
      );
      if (!resolved.ok) {
        if (resolved.reason === 'not-focused') {
          return { ok: false, error: notFocusedMessage(selector, resolved.why, 'typed') };
        }
        if (resolved.reason === 'invalid-selector') {
          return { ok: false, error: `Invalid selector "${selector}": ${resolved.error}` };
        }
        return { ok: false, error: `Element not found: ${selector}${notWalkedSuffix(resolved)}` };
      }
    }
    field = await evaluate(buildFocusedFieldJs()).catch(() => undefined);
    const mark = await settler.mark(settle);
    const baseline = await beginExpect(evaluate, expectSpec, clock);
    await keyboard.insertText(text);
    const settleResult = await settler.settle(settle, mark);
    const verdict = await verifyExpect(evaluate, expectSpec, baseline, settleResult, clock);
    if (!verdict.ok) return actionFailure(verdict.error, field);
    const result: TypeStepResult = { typed: text.length };
    if (selector !== undefined) result.selector = selector;
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
