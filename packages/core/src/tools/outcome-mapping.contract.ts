// What every transport's mapping of a `ToolOutcome` to its wire guarantees
// (design 3.4 and 5.3, item 5): the table of 3.4, one outcome per kind. It
// lives in `tools/`, not `ports/contract/`, because it speaks `ToolOutcome`
// and `ports` imports nothing in core (5.2); it uses the same assertion
// helper, so it runs anywhere.

import { check, type ContractCase, equal } from '../ports/contract/assert.js';
import type { ToolOutcome } from './failure.js';

/** What the agent-facing side of a transport received for one outcome. */
export type WireObservation =
  | { ok: true; result: unknown }
  | {
      ok: false;
      /** The error text that reaches the agent. */
      error: string;
      /** Whether the wire marked the failure sensitive (the extension's
       * `sensitive_field: true`, cdp-direct's `SensitiveFieldError`). */
      sensitive: boolean;
      /** What a throwing mapping threw (absent for a response mapping). */
      thrown?: unknown;
    };

export interface ToolOutcomeMappingHarness {
  /** Map one outcome through the transport's mapping and observe its wire. */
  map(outcome: ToolOutcome): Promise<WireObservation>;
  /** `response`: the outcome becomes a message; `throw`: a failure is thrown. */
  wire: 'response' | 'throw';
  /** The transport's text for a tool that is not registered. */
  unknownToolText(tool: string): string;
}

const MESSAGE = 'Element not found: #missing';

export function defineToolOutcomeMappingContract(
  harness: ToolOutcomeMappingHarness,
): ContractCase[] {
  const failed = async (
    outcome: ToolOutcome,
    what: string,
  ): Promise<Extract<WireObservation, { ok: false }>> => {
    const seen = await harness.map(outcome);
    check(!seen.ok, `${what}: expected a failure on the wire`);
    return seen;
  };

  return [
    {
      name: 'a result passes through unchanged',
      run: async () => {
        const result = { clicked: '#go', tag: 'button' };
        equal(await harness.map({ ok: true, result }), { ok: true, result }, 'result');
      },
    },
    {
      name: 'action: the message, not marked sensitive',
      run: async () => {
        const seen = await failed(
          { ok: false, failure: { kind: 'action', message: MESSAGE } },
          'action',
        );
        equal([seen.error, seen.sensitive], [MESSAGE, false], 'action error, sensitive');
      },
    },
    {
      name: 'sensitive: the message, marked sensitive',
      run: async () => {
        const seen = await failed(
          { ok: false, failure: { kind: 'sensitive', message: MESSAGE } },
          'sensitive',
        );
        equal([seen.error, seen.sensitive], [MESSAGE, true], 'sensitive error, sensitive');
      },
    },
    {
      name: 'thrown: the message, not marked sensitive; a throwing wire rethrows the cause',
      run: async () => {
        const cause = new TypeError('Cannot read properties of undefined');
        const seen = await failed(
          { ok: false, failure: { kind: 'thrown', message: cause.message, cause } },
          'thrown',
        );
        equal([seen.error, seen.sensitive], [cause.message, false], 'thrown error, sensitive');
        if (harness.wire === 'throw') check(seen.thrown === cause, 'thrown: cause not rethrown');
      },
    },
    {
      name: "unknown-tool: the transport's own text",
      run: async () => {
        const seen = await failed(
          { ok: false, failure: { kind: 'unknown-tool', tool: 'nope' } },
          'unknown-tool',
        );
        equal(
          [seen.error, seen.sensitive],
          [harness.unknownToolText('nope'), false],
          'unknown-tool error, sensitive',
        );
      },
    },
    {
      name: 'unsupported: a failure naming the tool, not marked sensitive',
      run: async () => {
        const seen = await failed(
          { ok: false, failure: { kind: 'unsupported', tool: 'drag', missing: ['pointer'] } },
          'unsupported',
        );
        check(seen.error.includes('drag'), `unsupported: "${seen.error}" does not name the tool`);
        equal(seen.sensitive, false, 'unsupported sensitive');
      },
    },
  ];
}

/** Observe a mapping that throws on failure (cdp-direct): its return value
 * is the result; what it throws is the failure. */
export async function observeThrowingMapping(
  run: () => unknown,
  isSensitive: (err: unknown) => boolean,
): Promise<WireObservation> {
  try {
    return { ok: true, result: await run() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      sensitive: isSensitive(err),
      thrown: err,
    };
  }
}
