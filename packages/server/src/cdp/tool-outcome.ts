// cdp-direct's mapping of a core `ToolOutcome` to `callCdpTool`'s contract
// (design 3.4, cdp-direct column): a result is returned, a failure thrown,
// byte-identical to what each `case` threw before slice 10. Checked by
// `defineToolOutcomeMappingContract` in `tool-outcome.test.ts`.
import type { ToolOutcome } from '../generated/core/tools/failure.js';
import { SensitiveFieldError } from '../activity/sensitive-field-error.js';
import { cdpUnsupportedToolError } from './support.js';

export function cdpToolResult(outcome: ToolOutcome): unknown {
  if (outcome.ok) return outcome.result;
  const { failure } = outcome;
  switch (failure.kind) {
    case 'action':
      throw new Error(failure.message);
    case 'sensitive':
      throw new SensitiveFieldError(failure.message);
    case 'thrown':
      throw failure.cause;
    case 'unknown-tool':
    case 'unsupported':
      // The text of `callCdpTool`'s defense-in-depth `default`.
      throw cdpUnsupportedToolError(failure.tool);
  }
}
