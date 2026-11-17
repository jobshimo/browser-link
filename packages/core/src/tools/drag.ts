/**
 * Registry entry of `drag` (design 3.3, slice 14). It requires the drag
 * input and the CDP event wait besides the evaluator and the pointer. The
 * extension provides them all; cdp-direct does not provide `drag` (v1
 * scope), so the registry refuses the tool there as `unsupported`, which
 * cdp-direct maps to the text its `callCdpTool` always threw for it.
 * Numbers pass with a plain `typeof` check; `performDrag` applies the
 * finite and non-negative guard and the duration and hold clamps.
 */
import { performDrag, type DragParams } from '../actions/perform-drag.js';
import { fromActionOutcome } from './failure.js';
import type { ToolEntry } from './registry.js';

type Params = Record<string, unknown>;

const optStr = (p: Params, key: string): string | undefined =>
  typeof p[key] === 'string' ? p[key] : undefined;
const optNum = (p: Params, key: string): number | undefined =>
  typeof p[key] === 'number' ? p[key] : undefined;

function coerceDrag(p: Params): DragParams {
  return {
    from_selector: optStr(p, 'from_selector'),
    from_x: optNum(p, 'from_x'),
    from_y: optNum(p, 'from_y'),
    to_selector: optStr(p, 'to_selector'),
    to_x: optNum(p, 'to_x'),
    to_y: optNum(p, 'to_y'),
    duration_ms: optNum(p, 'duration_ms'),
    hold_before_move_ms: optNum(p, 'hold_before_move_ms'),
    hold_before_release_ms: optNum(p, 'hold_before_release_ms'),
  };
}

export const dragTool: ToolEntry<DragParams, 'evaluator' | 'pointer' | 'drag' | 'cdp-events'> = {
  name: 'drag',
  requires: ['evaluator', 'pointer', 'drag', 'cdp-events'],
  listed: true,
  coerce: { extension: coerceDrag, 'cdp-direct': coerceDrag },
  handler: async (deps, params) =>
    fromActionOutcome(
      await performDrag(
        {
          evaluator: deps.evaluator,
          pointer: deps.pointer,
          drag: deps.drag,
          events: deps['cdp-events'],
          clock: deps.clock,
        },
        params,
      ),
    ),
};
