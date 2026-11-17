// The failure contract (design 3.4): the extension's mapping against the
// outcome-mapping contract, and RED probes showing the contract catches a
// broken mapping. cdp-direct's mapping runs the same contract in the server
// (`cdp/tool-outcome.test.ts`).
import { describe, expect, it } from 'vitest';
import type { ContractCase } from '../ports/contract/assert.js';
import { fromActionOutcome, thrownFailure, toolResponse, type ToolOutcome } from './failure.js';
import {
  defineToolOutcomeMappingContract,
  observeThrowingMapping,
  type ToolOutcomeMappingHarness,
  type WireObservation,
} from './outcome-mapping.contract.js';

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
}

function observeResponse(outcome: ToolOutcome): Promise<WireObservation> {
  const response = toolResponse('req-1', outcome);
  return Promise.resolve(
    response.ok
      ? { ok: true, result: response.result }
      : { ok: false, error: response.error, sensitive: response.sensitive_field === true },
  );
}

const extensionHarness: ToolOutcomeMappingHarness = {
  map: observeResponse,
  wire: 'response',
  unknownToolText: (tool) => `Unknown tool: ${tool}`,
};

class Sensitive extends Error {}

/** A throwing mapping shaped like cdp-direct's, for the contract's own tests. */
function throwingMapping(outcome: ToolOutcome): unknown {
  if (outcome.ok) return outcome.result;
  const { failure } = outcome;
  switch (failure.kind) {
    case 'action':
      throw new Error(failure.message);
    case 'sensitive':
      throw new Sensitive(failure.message);
    case 'thrown':
      throw failure.cause;
    case 'unknown-tool':
    case 'unsupported':
      throw new Error(`browser.${failure.tool} is not supported`);
  }
}

const throwingHarness = (map: (outcome: ToolOutcome) => unknown): ToolOutcomeMappingHarness => ({
  map: (outcome) =>
    observeThrowingMapping(
      () => map(outcome),
      (err) => err instanceof Sensitive,
    ),
  wire: 'throw',
  unknownToolText: (tool) => `browser.${tool} is not supported`,
});

describe('outcome-mapping contract: the extension wire (toolResponse)', () => {
  run(defineToolOutcomeMappingContract(extensionHarness));
});

describe('outcome-mapping contract: a throwing wire', () => {
  run(defineToolOutcomeMappingContract(throwingHarness(throwingMapping)));
});

describe('toolResponse: the extension wire, byte for byte', () => {
  it('a result', () => {
    expect(JSON.stringify(toolResponse('7', { ok: true, result: { a: 1 } }))).toBe(
      '{"kind":"tool.response","id":"7","ok":true,"result":{"a":1}}',
    );
  });

  it('an action failure carries no sensitive_field', () => {
    expect(
      JSON.stringify(
        toolResponse('7', {
          ok: false,
          failure: { kind: 'action', message: 'Element not found: #x' },
        }),
      ),
    ).toBe('{"kind":"tool.response","id":"7","ok":false,"error":"Element not found: #x"}');
  });

  it('a sensitive failure adds sensitive_field: true', () => {
    expect(
      JSON.stringify(
        toolResponse('7', { ok: false, failure: { kind: 'sensitive', message: 'm' } }),
      ),
    ).toBe('{"kind":"tool.response","id":"7","ok":false,"error":"m","sensitive_field":true}');
  });

  it("an unknown tool answers the switch's old default text", () => {
    expect(
      toolResponse('7', { ok: false, failure: { kind: 'unknown-tool', tool: 'nope' } }),
    ).toEqual({ kind: 'tool.response', id: '7', ok: false, error: 'Unknown tool: nope' });
  });
});

describe('fromActionOutcome and thrownFailure', () => {
  it('an action error is `action`; with sensitive_field it is `sensitive`', () => {
    expect(fromActionOutcome({ ok: false, error: 'e' })).toEqual({
      ok: false,
      failure: { kind: 'action', message: 'e' },
    });
    expect(fromActionOutcome({ ok: false, error: 'e', sensitive_field: true })).toEqual({
      ok: false,
      failure: { kind: 'sensitive', message: 'e' },
    });
    expect(fromActionOutcome({ ok: true, result: 3 })).toEqual({ ok: true, result: 3 });
  });

  it('a thrown non-Error becomes its String, as handleTool did', () => {
    const outcome = thrownFailure('plain');
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'thrown', message: 'plain', cause: 'plain' },
    });
  });
});

describe('the outcome-mapping contract catches a broken mapping (RED probes)', () => {
  const failing = async (harness: ToolOutcomeMappingHarness, name: string): Promise<void> => {
    const contractCase = defineToolOutcomeMappingContract(harness).find((c) => c.name === name);
    if (!contractCase) throw new Error(`no case ${name}`);
    await expect(contractCase.run()).rejects.toThrow();
  };

  it('extension: `sensitive` mapped like `action` (no sensitive_field)', async () => {
    await failing(
      {
        ...extensionHarness,
        map: (outcome) =>
          observeResponse(
            !outcome.ok && outcome.failure.kind === 'sensitive'
              ? { ok: false, failure: { kind: 'action', message: outcome.failure.message } }
              : outcome,
          ),
      },
      'sensitive: the message, marked sensitive',
    );
  });

  it('throwing wire: `sensitive` thrown as a plain Error', async () => {
    await failing(
      throwingHarness((outcome) => {
        if (!outcome.ok && outcome.failure.kind === 'sensitive') {
          throw new Error(outcome.failure.message);
        }
        return throwingMapping(outcome);
      }),
      'sensitive: the message, marked sensitive',
    );
  });

  it('throwing wire: `thrown` wrapped in a new Error instead of rethrown', async () => {
    await failing(
      throwingHarness((outcome) => {
        if (!outcome.ok && outcome.failure.kind === 'thrown') {
          throw new Error(outcome.failure.message);
        }
        return throwingMapping(outcome);
      }),
      'thrown: the message, not marked sensitive; a throwing wire rethrows the cause',
    );
  });

  it('extension: an action error text changed', async () => {
    await failing(
      {
        ...extensionHarness,
        map: async (outcome) => {
          const seen = await observeResponse(outcome);
          return seen.ok ? seen : { ...seen, error: `${seen.error}.` };
        },
      },
      'action: the message, not marked sensitive',
    );
  });

  it('extension: the unknown-tool text changed', async () => {
    await failing(
      { ...extensionHarness, unknownToolText: (tool) => `No such tool: ${tool}` },
      "unknown-tool: the transport's own text",
    );
  });
});
