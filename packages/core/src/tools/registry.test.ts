// The tool registry (design 3.3): dispatch, the failure kinds it produces
// itself, and each interaction entry's per-transport argument coercion.
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../ports/contract/index.js';
import type {
  CdpEvents,
  DragInput,
  Evaluator,
  Keyboard,
  Pointer,
  Settler,
} from '../ports/page-driver.js';
import { TOOL_REGISTRY } from './catalog.js';
import { clickTool, findTool, pressTool, typeTool } from './interaction.js';
import { createToolRegistry, dispatchTool, type RegisteredTool } from './registry.js';
import type { Requirement, ToolDeps } from './requirement.js';

const ALL: ReadonlySet<Requirement> = new Set<Requirement>([
  'evaluator',
  'keyboard',
  'pointer',
  'settler',
]);

function deps(evaluate: Evaluator['evaluate'] = () => Promise.resolve(undefined)): ToolDeps {
  const pointer: Pointer = { mouse: () => Promise.resolve() };
  const settler: Settler = {
    mark: () => Promise.resolve({ kind: 'none' }),
    settle: () => Promise.resolve(undefined),
  };
  const keyboard: Keyboard = { key: () => Promise.resolve(), insertText: () => Promise.resolve() };
  const drag: DragInput = {
    interceptDrags: () => Promise.resolve(),
    dragEvent: () => Promise.resolve(),
  };
  const events: CdpEvents = { waitFor: () => Promise.resolve(null) };
  return {
    evaluator: { evaluate },
    keyboard,
    pointer,
    settler,
    drag,
    'cdp-events': events,
    page: {
      info: () => Promise.resolve({ url: '', title: '' }),
      armLoadWait: () => ({ done: new Promise<void>(() => undefined), cancel: () => undefined }),
    },
    clock: createManualClock(),
  };
}

const echo = (name: string, handler: RegisteredTool['handler']): RegisteredTool => ({
  name,
  requires: ['evaluator'],
  listed: true,
  coerce: { extension: (p) => p, 'cdp-direct': (p) => p },
  handler,
});

describe('dispatchTool', () => {
  it('a tool not in the registry is `unknown-tool`', async () => {
    expect(await dispatchTool(TOOL_REGISTRY, ALL, deps(), 'extension', 'nope', {})).toEqual({
      ok: false,
      failure: { kind: 'unknown-tool', tool: 'nope' },
    });
  });

  it('a requirement the transport does not provide is `unsupported`, before anything runs', async () => {
    let ran = false;
    const outcome = await dispatchTool(
      TOOL_REGISTRY,
      new Set<Requirement>(['evaluator']),
      deps(() => {
        ran = true;
        return Promise.resolve(undefined);
      }),
      'cdp-direct',
      'click',
      { selector: '#go' },
    );
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'unsupported', tool: 'click', missing: ['pointer', 'settler'] },
    });
    expect(ran).toBe(false);
  });

  it('a handler that throws is `thrown`, carrying what was thrown', async () => {
    const boom = new TypeError('boom');
    const registry = createToolRegistry([echo('x', () => Promise.reject(boom))]);
    expect(await dispatchTool(registry, ALL, deps(), 'extension', 'x', {})).toEqual({
      ok: false,
      failure: { kind: 'thrown', message: 'boom', cause: boom },
    });
  });

  it('missing params read as an empty object', async () => {
    const seen: unknown[] = [];
    const registry = createToolRegistry([
      echo('x', (_deps, params) => {
        seen.push(params);
        return Promise.resolve({ ok: true, result: null });
      }),
    ]);
    await dispatchTool(registry, ALL, deps(), 'cdp-direct', 'x', undefined);
    expect(seen).toEqual([{}]);
  });

  it('a name registered twice is refused', () => {
    expect(() =>
      createToolRegistry([echo('x', () => Promise.reject()), echo('x', () => Promise.reject())]),
    ).toThrow('tool registered twice: x');
  });

  it('holds the interaction, wait_for, drag, page read, dialog, permission and download tools; only download_settle is unlisted', () => {
    expect([...TOOL_REGISTRY.keys()]).toEqual([
      'find',
      'click',
      'type',
      'press',
      'wait_for',
      'drag',
      'ping',
      'navigate',
      'snapshot',
      'state',
      'screenshot',
      'evaluate',
      'canvas_screenshot',
      'console',
      'network',
      'network_body',
      'dialog_respond',
      'set_permission',
      'download',
      'download_settle',
    ]);
    expect(
      [...TOOL_REGISTRY.values()].filter((entry) => !entry.listed).map((entry) => entry.name),
    ).toEqual(['download_settle']);
  });
});

describe('find: each transport keeps its own coercion (design 7(e))', () => {
  it('a missing text: the extension reads "undefined", cdp-direct reads ""', () => {
    expect(findTool.coerce.extension({}).text).toBe('undefined');
    expect(findTool.coerce['cdp-direct']({}).text).toBe('');
  });

  it('with a ref or a key, the extension leaves a missing text undefined', () => {
    expect(findTool.coerce.extension({ ref: 'd1:e2' }).text).toBeUndefined();
    expect(findTool.coerce.extension({ key: { role: 'button' } }).text).toBeUndefined();
  });

  it('cdp-direct: a missing text fails as before, the extension searches "undefined"', async () => {
    const evaluated: string[] = [];
    const evaluate = (expression: string): Promise<never> => {
      evaluated.push(expression);
      return Promise.resolve({ matched: false } as never);
    };
    expect(
      await dispatchTool(TOOL_REGISTRY, ALL, deps(evaluate), 'cdp-direct', 'find', {}),
    ).toEqual({ ok: false, failure: { kind: 'action', message: 'find: text required' } });
    expect(evaluated).toEqual([]);
    expect(await dispatchTool(TOOL_REGISTRY, ALL, deps(evaluate), 'extension', 'find', {})).toEqual(
      {
        ok: true,
        result: { matched: false },
      },
    );
    expect(evaluated).toHaveLength(1);
  });

  it('both read the other fields the same way', () => {
    const p = {
      text: 'Go',
      role: 'button',
      exact: true,
      offset: { candidates: 3 },
      hide_password_values: true,
      key: null,
    };
    expect(findTool.coerce.extension(p)).toEqual(findTool.coerce['cdp-direct'](p));
    expect(findTool.coerce.extension({ text: 'Go', exact: 'yes', role: 3 })).toEqual({
      text: 'Go',
      role: undefined,
      exact: false,
      ref: undefined,
      key: undefined,
      offset: undefined,
      hide_password_values: false,
    });
  });
});

describe('click: each transport keeps its own coercion (design 7(e))', () => {
  it('a missing selector: the extension reads "undefined", cdp-direct reads ""', () => {
    expect(clickTool.coerce.extension({}).selector).toBe('undefined');
    expect(clickTool.coerce['cdp-direct']({}).selector).toBe('');
  });

  it('with a ref, both leave a missing selector undefined', () => {
    expect(clickTool.coerce.extension({ ref: 'd1:e2' }).selector).toBeUndefined();
    expect(clickTool.coerce['cdp-direct']({ ref: 'd1:e2' }).selector).toBeUndefined();
  });

  it('both read force, settle and expect the same way', () => {
    const p = {
      selector: '#go',
      force: true,
      settle_ms: 0,
      settle_timeout_ms: 'x',
      expect: { url_changed: true },
    };
    expect(clickTool.coerce.extension(p)).toEqual({
      selector: '#go',
      ref: undefined,
      force: true,
      settle_ms: 0,
      settle_timeout_ms: undefined,
      expect: { url_changed: true },
    });
    expect(clickTool.coerce['cdp-direct'](p)).toEqual(clickTool.coerce.extension(p));
  });
});

describe('type: each transport keeps its own coercion (design 7(e))', () => {
  it('a missing selector and text: the extension reads "undefined", cdp-direct leaves the selector out and types ""', () => {
    expect(typeTool.coerce.extension({})).toMatchObject({
      selector: 'undefined',
      text: 'undefined',
    });
    expect(typeTool.coerce['cdp-direct']({})).toMatchObject({ selector: undefined, text: '' });
  });

  it('with a ref, both leave a missing selector undefined', () => {
    expect(typeTool.coerce.extension({ ref: 'd1:e2', text: 'x' }).selector).toBeUndefined();
    expect(typeTool.coerce['cdp-direct']({ ref: 'd1:e2', text: 'x' }).selector).toBeUndefined();
  });

  it('both read clear, settle and expect the same way', () => {
    const p = {
      selector: '#q',
      text: 'hi',
      clear: 'yes',
      settle_ms: 0,
      settle_timeout_ms: 'x',
      expect: { value_equals: 'hi' },
    };
    expect(typeTool.coerce.extension(p)).toEqual({
      selector: '#q',
      ref: undefined,
      text: 'hi',
      clear: false,
      settle_ms: 0,
      settle_timeout_ms: undefined,
      expect: { value_equals: 'hi' },
    });
    expect(typeTool.coerce['cdp-direct'](p)).toEqual(typeTool.coerce.extension(p));
  });
});

describe('press: both transports read it the same way', () => {
  it('keeps string modifiers only, and reads a missing one as []', () => {
    const p = { key: 'Enter', modifiers: ['Shift', 3, 'Control'], selector: '#q', settle_ms: 5 };
    expect(pressTool.coerce.extension(p)).toEqual({
      key: 'Enter',
      modifiers: ['Shift', 'Control'],
      selector: '#q',
      ref: undefined,
      settle_ms: 5,
      settle_timeout_ms: undefined,
      expect: undefined,
    });
    expect(pressTool.coerce['cdp-direct'](p)).toEqual(pressTool.coerce.extension(p));
    expect(pressTool.coerce.extension({ key: 7, modifiers: 'Shift' })).toMatchObject({
      key: undefined,
      modifiers: [],
    });
  });
});
