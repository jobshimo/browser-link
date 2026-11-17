// GENERATED from packages/core/src/actions/perform-find.ts. Do not edit.
/**
 * `browser.find`: the body both the standalone tool (`tools/interaction.ts`)
 * and a flow's find step call. Moved in slice 10 from `background.ts` and
 * `cdp/transport.ts`, whose two copies `transport-parity.test.ts` kept equal.
 */
import { buildFindJs, type FindKey } from '../inpage/builders.js';
import type { Evaluator } from '../ports/page-driver.js';
import {
  refFailureMessage,
  type ActionOutcome,
  type FindStepResult,
} from '../support/action-results.js';

export interface FindParams {
  text?: string;
  role?: string;
  exact?: boolean;
  ref?: string;
  key?: FindKey;
  offset?: { candidates?: number };
  /** The user's hide-password-values setting (owner decision D12). */
  hide_password_values?: boolean;
}

export async function performFind(
  { evaluator }: { evaluator: Evaluator },
  params: FindParams,
): Promise<ActionOutcome<FindStepResult>> {
  try {
    const { text, ref } = params;
    const hide_password_values = params.hide_password_values === true;
    if (params.key !== undefined) {
      const value = await evaluator.evaluate<FindStepResult>(
        buildFindJs({ key: params.key, hide_password_values }),
      );
      return { ok: true, result: value };
    }
    if (ref !== undefined) {
      const found = await evaluator.evaluate<FindStepResult>(
        buildFindJs({ ref, hide_password_values }),
      );
      const refError = found.matched ? null : refFailureMessage(found, ref);
      if (refError) return { ok: false, error: refError };
      return { ok: true, result: found };
    }
    if (!text) return { ok: false, error: 'find: text required' };
    const value = await evaluator.evaluate<FindStepResult>(
      buildFindJs({
        text,
        role: params.role,
        exact: params.exact === true,
        offset: params.offset,
        hide_password_values,
      }),
    );
    return { ok: true, result: value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
