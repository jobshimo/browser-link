// The page read and capture entries (design 3.3, slice 15): each handler's
// result, each transport's coercion, and the requirements cdp-direct does
// not provide.
import { describe, expect, it } from 'vitest';
import { buildCanvasScreenshotJs } from '../inpage/canvas.js';
import { buildSnapshotJs, buildStateJs } from '../inpage/builders.js';
import { createManualClock } from '../ports/contract/index.js';
import type { PageInfo } from '../ports/page-info.js';
import type { CaptureWatch, ConsoleEntry, NetworkEntry } from '../session/page-driver.js';
import { TOOL_REGISTRY } from './catalog.js';
import { canvasScreenshotTool, evaluateTool, snapshotTool } from './page-read.js';
import { dispatchTool, type Transport } from './registry.js';
import type { Requirement, ToolDeps } from './requirement.js';

/** What the extension provides. */
const EXTENSION: ReadonlySet<Requirement> = new Set<Requirement>([
  'evaluator',
  'keyboard',
  'pointer',
  'settler',
  'drag',
  'cdp-events',
  'page',
  'capture-buffers',
  'canvas',
]);
/** What cdp-direct provides. */
const CDP: ReadonlySet<Requirement> = new Set<Requirement>([
  'evaluator',
  'keyboard',
  'pointer',
  'settler',
  'cdp-events',
  'page',
]);

interface Fake {
  deps: ToolDeps;
  evaluated: string[];
}

function fake(
  options: {
    answer?: (expression: string) => Promise<unknown>;
    info?: PageInfo['info'];
    capture?: CaptureWatch;
  } = {},
): Fake {
  const evaluated: string[] = [];
  const answer = options.answer ?? ((expression: string) => Promise.resolve(`value:${expression}`));
  const deps = {
    evaluator: {
      evaluate: (expression: string) => {
        evaluated.push(expression);
        return answer(expression);
      },
    },
    page: {
      info: options.info ?? (() => Promise.resolve({ url: 'https://x.test/', title: 'X' })),
      armLoadWait: () => ({ done: new Promise<void>(() => undefined), cancel: () => undefined }),
    },
    clock: createManualClock(),
    captureBuffers: options.capture,
  } as unknown as ToolDeps;
  return { deps, evaluated };
}

function run(
  f: Fake,
  tool: string,
  params: unknown,
  transport: Transport = 'extension',
  provided: ReadonlySet<Requirement> = transport === 'extension' ? EXTENSION : CDP,
) {
  return dispatchTool(TOOL_REGISTRY, provided, f.deps, transport, tool, params);
}

describe('ping', () => {
  it('answers { title, url } in that key order on both transports', async () => {
    for (const transport of ['extension', 'cdp-direct'] as const) {
      const outcome = await run(fake(), 'ping', {}, transport);
      expect(outcome).toEqual({ ok: true, result: { title: 'X', url: 'https://x.test/' } });
      expect(outcome.ok && Object.keys(outcome.result as object)).toEqual(['title', 'url']);
    }
  });

  it('a failed page read is `thrown`, carrying the error', async () => {
    const err = new Error('No tab with id: 7.');
    const outcome = await run(fake({ info: () => Promise.reject(err) }), 'ping', {});
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'thrown', message: 'No tab with id: 7.', cause: err },
    });
  });
});

describe('snapshot and state', () => {
  it('snapshot evaluates the snapshot expression of its coerced options and answers its value', async () => {
    const f = fake();
    const outcome = await run(f, 'snapshot', {
      within_selector: '#main',
      only_interactive: true,
      exclude: ['nav', 3],
      max_interactive: 10,
      since: 's3',
      offset: { interactive: 5 },
      hide_password_values: true,
    });
    const expected = buildSnapshotJs({
      within_selector: '#main',
      only_interactive: true,
      exclude: ['nav'],
      max_interactive: 10,
      since: 's3',
      offset: { interactive: 5 },
      hide_password_values: true,
    });
    expect(f.evaluated).toEqual([expected]);
    expect(outcome).toEqual({ ok: true, result: `value:${expected}` });
  });

  it('both transports read snapshot options the same way', () => {
    const raw = { within_selector: 7, only_interactive: 'yes', since: 42, offset: null };
    expect(snapshotTool.coerce.extension(raw)).toEqual(snapshotTool.coerce['cdp-direct'](raw));
    expect(snapshotTool.coerce.extension(raw)).toEqual({
      within_selector: undefined,
      only_interactive: false,
      exclude: undefined,
      max_interactive: undefined,
      since: undefined,
      offset: undefined,
      hide_password_values: false,
    });
  });

  it('state evaluates the state expression', async () => {
    const f = fake();
    expect(await run(f, 'state', {}, 'cdp-direct')).toEqual({
      ok: true,
      result: `value:${buildStateJs()}`,
    });
    expect(f.evaluated).toEqual([buildStateJs()]);
  });
});

describe('evaluate: each transport keeps its own coercion (design 7(e))', () => {
  it('a missing expression: the extension evaluates "undefined", cdp-direct ""', () => {
    expect(evaluateTool.coerce.extension({})).toEqual({ expression: 'undefined' });
    expect(evaluateTool.coerce['cdp-direct']({})).toEqual({ expression: '' });
    expect(evaluateTool.coerce.extension({ expression: 5 })).toEqual({ expression: '5' });
    expect(evaluateTool.coerce['cdp-direct']({ expression: 5 })).toEqual({ expression: '' });
  });

  it('answers the value; the page exception is `thrown`, carrying the error', async () => {
    const f = fake();
    expect(await run(f, 'evaluate', { expression: '1+1' })).toEqual({
      ok: true,
      result: 'value:1+1',
    });
    const err = new Error('ReferenceError: nope is not defined');
    expect(
      await run(fake({ answer: () => Promise.reject(err) }), 'evaluate', { expression: 'nope' }),
    ).toEqual({ ok: false, failure: { kind: 'thrown', message: err.message, cause: err } });
  });
});

describe('canvas_screenshot', () => {
  it('evaluates the canvas expression of its coerced options', async () => {
    const f = fake();
    await run(f, 'canvas_screenshot', {
      selector: '#c',
      format: 'jpeg',
      region: { x: 1, y: 2, w: 3, h: 4 },
    });
    expect(f.evaluated).toEqual([
      buildCanvasScreenshotJs({
        selector: '#c',
        format: 'jpeg',
        region: { x: 1, y: 2, w: 3, h: 4 },
      }),
    ]);
  });

  it('drops a region with a non-number side and reads any format but jpeg as png', () => {
    expect(
      canvasScreenshotTool.coerce.extension({
        region: { x: 1, y: 2, w: '3', h: 4 },
        format: 'gif',
      }),
    ).toEqual({ selector: undefined, region: undefined, format: 'png' });
  });

  it('cdp-direct does not provide `canvas`: refused before anything runs', async () => {
    const f = fake();
    expect(await run(f, 'canvas_screenshot', {}, 'cdp-direct')).toEqual({
      ok: false,
      failure: { kind: 'unsupported', tool: 'canvas_screenshot', missing: ['canvas'] },
    });
    expect(f.evaluated).toEqual([]);
  });
});

describe('console and network read the capture watch', () => {
  const consoleEntries: ConsoleEntry[] = [
    { timestamp: 1, level: 'warn', text: 'a', source: 'console' },
    { timestamp: 2, level: 'error', text: 'b', source: 'log' },
    { timestamp: 3, level: 'warn', text: 'c', source: 'console' },
  ];
  const networkEntries: NetworkEntry[] = [
    { request_id: '1', url: 'https://x.test/API/users', method: 'GET', started_at: 1 },
    { request_id: '2', url: 'https://x.test/style.css', method: 'GET', started_at: 2 },
    { request_id: '3', url: 'https://x.test/api/items', method: 'POST', started_at: 3 },
  ];
  const capture: CaptureWatch = {
    finishedUrls: () => [],
    consoleEntries: () => consoleEntries,
    networkEntries: () => networkEntries,
  };

  it('console answers every entry, or those of `level`', async () => {
    const f = fake({ capture });
    expect(await run(f, 'console', {})).toEqual({ ok: true, result: consoleEntries });
    expect(await run(f, 'console', { level: 'warn' })).toEqual({
      ok: true,
      result: [consoleEntries[0], consoleEntries[2]],
    });
    expect(await run(f, 'console', { level: '' })).toEqual({ ok: true, result: consoleEntries });
  });

  it('network answers every request in order, or those whose URL holds `url_filter`, ignoring case', async () => {
    const f = fake({ capture });
    expect(await run(f, 'network', {})).toEqual({ ok: true, result: networkEntries });
    expect(await run(f, 'network', { url_filter: '/Api/' })).toEqual({
      ok: true,
      result: [networkEntries[0], networkEntries[2]],
    });
  });

  it('cdp-direct does not provide `capture-buffers`: both are refused', async () => {
    for (const tool of ['console', 'network']) {
      expect(await run(fake({ capture }), tool, {}, 'cdp-direct')).toEqual({
        ok: false,
        failure: { kind: 'unsupported', tool, missing: ['capture-buffers'] },
      });
    }
  });

  it('a transport that provides `capture-buffers` without a watch fails as `thrown`', async () => {
    const outcome = await run(fake(), 'console', {});
    expect(outcome.ok === false && outcome.failure).toMatchObject({
      kind: 'thrown',
      message: 'capture-buffers provided without a capture watch',
    });
  });
});
