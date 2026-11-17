/**
 * Registry entry of `wait_for` (design 3.3, slice 13). Both transports read
 * its params the same way. `network_url` mode needs `capture-buffers`: a
 * transport that does not provide them (cdp-direct) answers with the text
 * the tool always gave there, as an ordinary `action` failure; a timeout is
 * an ordinary result (`matched: false`, `reason: 'timeout'`), not a failure.
 */
import {
  NETWORK_URL_UNSUPPORTED_MESSAGE,
  performWaitFor,
  type WaitForParams,
} from '../actions/perform-wait-for.js';
import { fromActionOutcome } from './failure.js';
import type { ToolEntry } from './registry.js';

type Params = Record<string, unknown>;

const optStr = (p: Params, key: string): string | undefined =>
  typeof p[key] === 'string' ? p[key] : undefined;
const optNum = (p: Params, key: string): number | undefined =>
  typeof p[key] === 'number' ? p[key] : undefined;

function coerceWaitFor(p: Params): WaitForParams {
  return {
    selector: optStr(p, 'selector'),
    ref: optStr(p, 'ref'),
    expression: optStr(p, 'expression'),
    network_url: optStr(p, 'network_url'),
    condition: optStr(p, 'condition'),
    timeout_ms: optNum(p, 'timeout_ms'),
    poll_interval_ms: optNum(p, 'poll_interval_ms'),
  };
}

export const waitForTool: ToolEntry<WaitForParams, 'evaluator'> = {
  name: 'wait_for',
  requires: ['evaluator'],
  listed: true,
  coerce: { extension: coerceWaitFor, 'cdp-direct': coerceWaitFor },
  needs: (params) =>
    params.network_url === undefined
      ? []
      : [{ requirement: 'capture-buffers', message: NETWORK_URL_UNSUPPORTED_MESSAGE }],
  handler: async (deps, params) => fromActionOutcome(await performWaitFor(deps, params)),
};
