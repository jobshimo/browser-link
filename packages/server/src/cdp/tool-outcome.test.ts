// cdp-direct's outcome mapping (design 3.4) against the outcome-mapping
// contract, with the server's own error classes.
import { describe, expect, it } from 'vitest';
import { SensitiveFieldError } from '../activity/sensitive-field-error.js';
import type { ContractCase } from '../generated/core/ports/contract/assert.js';
import {
  defineToolOutcomeMappingContract,
  observeThrowingMapping,
} from '../generated/core/tools/outcome-mapping.contract.js';
import { cdpUnsupportedToolError } from './support.js';
import { cdpToolResult } from './tool-outcome.js';

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
}

describe('outcome-mapping contract: cdp-direct (cdpToolResult)', () => {
  run(
    defineToolOutcomeMappingContract({
      map: (outcome) =>
        observeThrowingMapping(
          () => cdpToolResult(outcome),
          (err) => err instanceof SensitiveFieldError,
        ),
      wire: 'throw',
      unknownToolText: (tool) => cdpUnsupportedToolError(tool).message,
    }),
  );
});

describe('cdpToolResult: what callCdpTool threw before slice 10', () => {
  it('an action failure is a plain Error, not a SensitiveFieldError', () => {
    let thrown: unknown;
    try {
      cdpToolResult({ ok: false, failure: { kind: 'action', message: 'Element not found: #x' } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(SensitiveFieldError);
    expect((thrown as Error).message).toBe('Element not found: #x');
  });
});
