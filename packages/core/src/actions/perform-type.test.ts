// performType and performPress on fakes (slice 11): the order of their page
// steps, and the sensitive-field rule through the registry to the wire.
import { describe, expect, test } from 'vitest';
import { buildFocusJs, buildFocusedFieldJs, buildTypeResolveJs } from '../inpage/builders.js';
import { createManualClock } from '../ports/contract/index.js';
import type { Keyboard, Settler } from '../ports/page-driver.js';
import { TOOL_REGISTRY } from '../tools/catalog.js';
import { dispatchTool, type Transport } from '../tools/registry.js';
import { toolResponse } from '../tools/failure.js';
import type { Requirement, ToolDeps } from '../tools/requirement.js';
import { performPress } from './perform-press.js';
import { performType } from './perform-type.js';

const RESOLVE = buildTypeResolveJs({ selector: '#pw', clear: false });
const FOCUS = buildFocusJs({ selector: '#pw' });
const SENSITIVE = { sensitive_field: true };
const PLAIN = { sensitive_field: false };
const ALL = new Set<Requirement>(['evaluator', 'keyboard', 'pointer', 'settler']);

interface Fake {
  deps: ToolDeps;
  log: string[];
}

/** A page: `answers` per expression; the keyboard logs what it sends and
 * fails with `refuse` when given. */
function fake(answers: Record<string, unknown>, refuse?: Error): Fake {
  const log: string[] = [];
  const evaluate = <T>(expression: string): Promise<T> => {
    if (expression === RESOLVE) log.push('resolve');
    if (expression === FOCUS) log.push('focus');
    if (expression === buildFocusedFieldJs()) log.push('field');
    const answer = Object.hasOwn(answers, expression) ? answers[expression] : true;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as T);
  };
  const keyboard: Keyboard = {
    key: (event) => {
      log.push(`key:${event.type}`);
      return refuse ? Promise.reject(refuse) : Promise.resolve();
    },
    insertText: (text) => {
      log.push(`text:${text}`);
      return refuse ? Promise.reject(refuse) : Promise.resolve();
    },
  };
  const settler: Settler = {
    mark: () => {
      log.push('mark');
      return Promise.resolve({ kind: 'none' });
    },
    settle: () => {
      log.push('settle');
      return Promise.resolve(undefined);
    },
  };
  return {
    deps: {
      evaluator: { evaluate },
      keyboard,
      pointer: { mouse: () => Promise.resolve() },
      settler,
      clock: createManualClock(),
    },
    log,
  };
}

const REFUSED = new Error('Input.insertText refused');

describe('performType', () => {
  test('resolve, read the focused field, mark, insert the text, settle', async () => {
    const { deps, log } = fake({ [RESOLVE]: { ok: true }, [buildFocusedFieldJs()]: PLAIN });
    expect(await performType(deps, { selector: '#pw', text: 'abc', settle_ms: 0 })).toEqual({
      ok: true,
      result: { typed: 3, selector: '#pw', sensitive_field: false },
    });
    expect(log).toEqual(['resolve', 'field', 'mark', 'text:abc', 'settle']);
  });

  test('a failure after the field was read sensitive carries sensitive_field: true', async () => {
    const { deps } = fake({ [RESOLVE]: { ok: true }, [buildFocusedFieldJs()]: SENSITIVE }, REFUSED);
    expect(await performType(deps, { selector: '#pw', text: 'secret' })).toEqual({
      ok: false,
      error: REFUSED.message,
      sensitive_field: true,
    });
  });

  test('the same failure on a plain field carries no sensitive_field', async () => {
    const { deps } = fake({ [RESOLVE]: { ok: true }, [buildFocusedFieldJs()]: PLAIN }, REFUSED);
    expect(await performType(deps, { selector: '#pw', text: 'x' })).toEqual({
      ok: false,
      error: REFUSED.message,
    });
  });

  test('a target not found fails before the field is read: no text, no flag', async () => {
    const { deps, log } = fake({
      [RESOLVE]: { ok: false, reason: 'not-found' },
      [buildFocusedFieldJs()]: SENSITIVE,
    });
    expect(await performType(deps, { selector: '#pw', text: 'x' })).toEqual({
      ok: false,
      error: 'Element not found: #pw',
    });
    expect(log).toEqual(['resolve']);
  });
});

describe('performPress', () => {
  test('focus, read the focused field, mark, send the key sequence, settle', async () => {
    const { deps, log } = fake({ [FOCUS]: true, [buildFocusedFieldJs()]: PLAIN });
    expect(await performPress(deps, { key: 'Enter', selector: '#pw' })).toEqual({
      ok: true,
      result: { key: 'Enter', modifiers: [], sensitive_field: false },
    });
    expect(log.filter((step) => !step.startsWith('key:'))).toEqual([
      'focus',
      'field',
      'mark',
      'settle',
    ]);
    expect(log.some((step) => step.startsWith('key:'))).toBe(true);
  });

  test('a failure after the field was read sensitive carries sensitive_field: true', async () => {
    const { deps } = fake({ [FOCUS]: true, [buildFocusedFieldJs()]: SENSITIVE }, REFUSED);
    expect(await performPress(deps, { key: 'a', selector: '#pw' })).toEqual({
      ok: false,
      error: REFUSED.message,
      sensitive_field: true,
    });
  });

  test('a missing key fails before anything reaches the page', async () => {
    const { deps, log } = fake({});
    expect(await performPress(deps, {})).toEqual({ ok: false, error: 'press: key required' });
    expect(log).toEqual([]);
  });
});

describe('type and press through the registry: the `sensitive` kind (design 3.4)', () => {
  const transports: Transport[] = ['extension', 'cdp-direct'];

  for (const transport of transports) {
    test(`${transport}: type on a sensitive field fails as \`sensitive\``, async () => {
      const { deps } = fake(
        { [RESOLVE]: { ok: true }, [buildFocusedFieldJs()]: SENSITIVE },
        REFUSED,
      );
      expect(
        await dispatchTool(TOOL_REGISTRY, ALL, deps, transport, 'type', {
          selector: '#pw',
          text: 'secret',
        }),
      ).toEqual({ ok: false, failure: { kind: 'sensitive', message: REFUSED.message } });
    });

    test(`${transport}: press on a sensitive field fails as \`sensitive\``, async () => {
      const { deps } = fake({ [FOCUS]: true, [buildFocusedFieldJs()]: SENSITIVE }, REFUSED);
      expect(
        await dispatchTool(TOOL_REGISTRY, ALL, deps, transport, 'press', {
          key: 'a',
          selector: '#pw',
        }),
      ).toEqual({ ok: false, failure: { kind: 'sensitive', message: REFUSED.message } });
    });

    test(`${transport}: type on a plain field fails as \`action\``, async () => {
      const { deps } = fake({ [RESOLVE]: { ok: true }, [buildFocusedFieldJs()]: PLAIN }, REFUSED);
      expect(
        await dispatchTool(TOOL_REGISTRY, ALL, deps, transport, 'type', {
          selector: '#pw',
          text: 'x',
        }),
      ).toEqual({ ok: false, failure: { kind: 'action', message: REFUSED.message } });
    });
  }

  test('the extension wire of a sensitive type: the message and sensitive_field, nothing typed', async () => {
    const { deps } = fake({ [RESOLVE]: { ok: true }, [buildFocusedFieldJs()]: SENSITIVE }, REFUSED);
    const outcome = await dispatchTool(TOOL_REGISTRY, ALL, deps, 'extension', 'type', {
      selector: '#pw',
      text: 'secret',
    });
    const wire = JSON.stringify(toolResponse('9', outcome));
    expect(wire).toBe(
      `{"kind":"tool.response","id":"9","ok":false,"error":"${REFUSED.message}","sensitive_field":true}`,
    );
    expect(wire).not.toContain('secret');
  });
});
