/**
 * Registry entries of the interaction tools (design 3.3): `find` and
 * `click` (slice 10); `type` and `press` join in slice 11. Each `coerce` is
 * the argument coercion its transport did in its own `case` before slice 10
 * (`background.ts` `handleTool`, `cdp/transport.ts` `callCdpTool`): where
 * the two differ (a missing `text` or `selector`: the extension's
 * `String(p[key])`, cdp-direct's `''`), each keeps its own (design 7(e)).
 */
import { performClick, type ClickParams } from '../actions/perform-click.js';
import { performFind, type FindParams } from '../actions/perform-find.js';
import type { FindKey } from '../inpage/builders.js';
import type { ExpectParams } from '../support/expect.js';
import { fromActionOutcome } from './failure.js';
import type { ToolEntry } from './registry.js';

type Params = Record<string, unknown>;

/** The extension's reads: a string as is, anything else through `String`. */
const str = (p: Params, key: string): string =>
  typeof p[key] === 'string' ? p[key] : String(p[key]);
const optStr = (p: Params, key: string): string | undefined =>
  typeof p[key] === 'string' ? p[key] : undefined;
const optNum = (p: Params, key: string): number | undefined =>
  typeof p[key] === 'number' ? p[key] : undefined;
const optObject = (p: Params, key: string): object | undefined => {
  const value = p[key];
  return typeof value === 'object' && value !== null ? value : undefined;
};

/** What both transports read the same way for a find. */
function findRest(p: Params): Omit<FindParams, 'text'> {
  return {
    role: optStr(p, 'role'),
    exact: p.exact === true,
    ref: optStr(p, 'ref'),
    key: optObject(p, 'key') as FindKey | undefined,
    offset: optObject(p, 'offset'),
    hide_password_values: p.hide_password_values === true,
  };
}

export const findTool: ToolEntry<FindParams, 'evaluator'> = {
  name: 'find',
  requires: ['evaluator'],
  listed: true,
  coerce: {
    extension: (p) => {
      const { role, exact, ref, key, offset, hide_password_values } = findRest(p);
      return {
        text: ref !== undefined || p.key !== undefined ? optStr(p, 'text') : str(p, 'text'),
        role,
        exact,
        ref,
        key,
        offset,
        hide_password_values,
      };
    },
    'cdp-direct': (p) => {
      const { role, exact, ref, key, offset, hide_password_values } = findRest(p);
      return {
        text: typeof p.text === 'string' ? p.text : '',
        role,
        exact,
        ref,
        key,
        offset,
        hide_password_values,
      };
    },
  },
  handler: async (deps, params) => fromActionOutcome(await performFind(deps, params)),
};

/** What both transports read the same way for a click. */
function clickRest(p: Params): Omit<ClickParams, 'selector' | 'ref'> {
  return {
    force: p.force === true,
    settle_ms: optNum(p, 'settle_ms'),
    settle_timeout_ms: optNum(p, 'settle_timeout_ms'),
    expect: p.expect as ExpectParams | undefined,
  };
}

export const clickTool: ToolEntry<ClickParams, 'evaluator' | 'pointer' | 'settler'> = {
  name: 'click',
  requires: ['evaluator', 'pointer', 'settler'],
  listed: true,
  coerce: {
    extension: (p) => {
      const ref = optStr(p, 'ref');
      return {
        selector: ref !== undefined ? optStr(p, 'selector') : str(p, 'selector'),
        ref,
        ...clickRest(p),
      };
    },
    'cdp-direct': (p) => {
      const ref = optStr(p, 'ref');
      return {
        selector: typeof p.selector === 'string' ? p.selector : ref !== undefined ? undefined : '',
        ref,
        ...clickRest(p),
      };
    },
  },
  handler: async (deps, params) => fromActionOutcome(await performClick(deps, params)),
};
