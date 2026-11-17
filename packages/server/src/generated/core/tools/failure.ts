// GENERATED from packages/core/src/tools/failure.ts. Specifiers rewritten. Do not edit.
/**
 * The failure contract (design 3.4): the kinds of failure a tool call ends
 * in, named once in core. Each transport maps a `ToolOutcome` to its own
 * wire, byte-identical to what it sent before: the extension with
 * `toolResponse` below (its wire is the shared protocol, so the mapping is
 * pure and lives here, where it is tested), cdp-direct in the server
 * (`cdp/tool-outcome.ts`, which throws the server's error classes). Both
 * mappings pass `defineToolOutcomeMappingContract`.
 */
import type { ToolResponseMessage } from '../../shared/index.js';
import type { ActionOutcome } from '../support/action-results.js';
import type { Requirement } from './requirement.js';

export type ToolFailure =
  /** A perform* returned `ok: false`. */
  | { kind: 'action'; message: string }
  /** A `type` / `press` failed after acting on a sensitive field. */
  | { kind: 'sensitive'; message: string }
  /** An exception in the handler (a CDP error, bad input). `cause` is what
   * was thrown: cdp-direct rethrows it unchanged. */
  | { kind: 'thrown'; message: string; cause: unknown }
  /** Not in the registry. */
  | { kind: 'unknown-tool'; tool: string }
  /** The transport does not provide what the handler requires. */
  | { kind: 'unsupported'; tool: string; missing: Requirement[] };

export type ToolOutcome = { ok: true; result: unknown } | { ok: false; failure: ToolFailure };

/** The outcome of an action: its result, or its error text as `action`
 * (`sensitive` when the failure carries `sensitive_field: true`). */
export function fromActionOutcome<T>(outcome: ActionOutcome<T>): ToolOutcome {
  if (outcome.ok) return { ok: true, result: outcome.result };
  return {
    ok: false,
    failure: {
      kind: outcome.sensitive_field === true ? 'sensitive' : 'action',
      message: outcome.error,
    },
  };
}

/** A failure for whatever a handler threw. */
export function thrownFailure(err: unknown): ToolOutcome {
  return {
    ok: false,
    failure: {
      kind: 'thrown',
      message: err instanceof Error ? err.message : String(err),
      cause: err,
    },
  };
}

/** The error text of a failure on the extension wire. */
function extensionErrorText(failure: ToolFailure): string {
  switch (failure.kind) {
    case 'action':
    case 'sensitive':
    case 'thrown':
      return failure.message;
    case 'unknown-tool':
      return `Unknown tool: ${failure.tool}`;
    case 'unsupported':
      // Not reachable: the extension provides every requirement.
      return `Unsupported tool: ${failure.tool} needs ${failure.missing.join(', ')}`;
  }
}

/** The extension's `tool.response` for an outcome (design 3.4, extension
 * column): `sensitive` adds `sensitive_field: true`; the server turns it
 * into `SensitiveFieldError` and the agent sees only the message. */
export function toolResponse(id: string, outcome: ToolOutcome): ToolResponseMessage {
  if (outcome.ok) return { kind: 'tool.response', id, ok: true, result: outcome.result };
  const error = extensionErrorText(outcome.failure);
  return outcome.failure.kind === 'sensitive'
    ? { kind: 'tool.response', id, ok: false, error, sensitive_field: true }
    : { kind: 'tool.response', id, ok: false, error };
}
