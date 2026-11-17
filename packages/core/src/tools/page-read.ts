/**
 * Registry entries of the page read and capture tools (design 3.3, slice
 * 15): `ping`, `snapshot`, `state`, `evaluate`, `canvas_screenshot`,
 * `console` and `network`. Each handler is the body its transport ran in
 * its own `case` before (`background.ts` `handleTool` and its `handle*`
 * functions, `cdp/transport.ts` `callCdpTool`), with the same result.
 *
 * - `ping` answers `{ title, url }` in that key order, from `PageInfo.info`.
 * - `evaluate` keeps each transport's coercion of a missing expression (the
 *   extension's `String(p[key])`, cdp-direct's `''`; design 7(e)). What
 *   bounds its one `Runtime.evaluate` is the transport's business: the
 *   evaluator it gives.
 * - `canvas_screenshot` requires `canvas`, and `console` and `network`
 *   require `capture-buffers`; cdp-direct provides neither (v1 scope), so
 *   the registry refuses them there as `unsupported`, which cdp-direct maps
 *   to the text its `callCdpTool` always threw for them.
 */
import { buildCanvasScreenshotJs, type CanvasScreenshotOpts } from '../inpage/canvas.js';
import { buildSnapshotJs, buildStateJs, type SnapshotOpts } from '../inpage/builders.js';
import type { CaptureWatch } from '../session/page-driver.js';
import type { ToolOutcome } from './failure.js';
import type { ToolEntry } from './registry.js';
import type { CommonDeps } from './requirement.js';

type Params = Record<string, unknown>;

const optStr = (p: Params, key: string): string | undefined =>
  typeof p[key] === 'string' ? p[key] : undefined;

const result = (value: unknown): ToolOutcome => ({ ok: true, result: value });

/** Neither transport sends params for these. */
const noParams = (): Record<string, never> => ({});

/** The capture watch a transport that provides `capture-buffers` gives. */
function captureWatch({ captureBuffers }: CommonDeps): CaptureWatch {
  if (!captureBuffers) throw new Error('capture-buffers provided without a capture watch');
  return captureBuffers;
}

export const pingTool: ToolEntry<Record<string, never>, 'page'> = {
  name: 'ping',
  requires: ['page'],
  listed: true,
  coerce: { extension: noParams, 'cdp-direct': noParams },
  handler: async (deps) => {
    const { title, url } = await deps.page.info();
    return result({ title, url });
  },
};

function coerceSnapshot(p: Params): SnapshotOpts {
  return {
    within_selector: optStr(p, 'within_selector'),
    only_interactive: p.only_interactive === true,
    exclude: Array.isArray(p.exclude)
      ? p.exclude.filter((x): x is string => typeof x === 'string')
      : undefined,
    max_interactive: typeof p.max_interactive === 'number' ? p.max_interactive : undefined,
    since: optStr(p, 'since'),
    offset: typeof p.offset === 'object' && p.offset !== null ? p.offset : undefined,
    hide_password_values: p.hide_password_values === true,
  };
}

export const snapshotTool: ToolEntry<SnapshotOpts, 'evaluator'> = {
  name: 'snapshot',
  requires: ['evaluator'],
  listed: true,
  coerce: { extension: coerceSnapshot, 'cdp-direct': coerceSnapshot },
  handler: async (deps, params) => result(await deps.evaluator.evaluate(buildSnapshotJs(params))),
};

export const stateTool: ToolEntry<Record<string, never>, 'evaluator'> = {
  name: 'state',
  requires: ['evaluator'],
  listed: true,
  coerce: { extension: noParams, 'cdp-direct': noParams },
  handler: async (deps) => result(await deps.evaluator.evaluate(buildStateJs())),
};

export interface EvaluateParams {
  expression: string;
}

export const evaluateTool: ToolEntry<EvaluateParams, 'evaluator'> = {
  name: 'evaluate',
  requires: ['evaluator'],
  listed: true,
  coerce: {
    extension: (p) => ({
      expression: typeof p.expression === 'string' ? p.expression : String(p.expression),
    }),
    'cdp-direct': (p) => ({ expression: typeof p.expression === 'string' ? p.expression : '' }),
  },
  handler: async (deps, params) => result(await deps.evaluator.evaluate(params.expression)),
};

function coerceCanvasScreenshot(p: Params): CanvasScreenshotOpts {
  const selector = optStr(p, 'selector');
  const format = optStr(p, 'format') === 'jpeg' ? 'jpeg' : 'png';
  const regionRaw = p.region;
  let region: { x: number; y: number; w: number; h: number } | undefined;
  if (regionRaw && typeof regionRaw === 'object') {
    const r = regionRaw as Record<string, unknown>;
    if (
      typeof r.x === 'number' &&
      typeof r.y === 'number' &&
      typeof r.w === 'number' &&
      typeof r.h === 'number'
    ) {
      region = { x: r.x, y: r.y, w: r.w, h: r.h };
    }
  }
  return { selector, region, format };
}

export const canvasScreenshotTool: ToolEntry<CanvasScreenshotOpts, 'evaluator' | 'canvas'> = {
  name: 'canvas_screenshot',
  requires: ['evaluator', 'canvas'],
  listed: true,
  coerce: { extension: coerceCanvasScreenshot, 'cdp-direct': coerceCanvasScreenshot },
  handler: async (deps, params) =>
    result(await deps.evaluator.evaluate(buildCanvasScreenshotJs(params))),
};

export interface ConsoleParams {
  level?: string;
}

const coerceConsole = (p: Params): ConsoleParams => ({ level: optStr(p, 'level') });

export const consoleTool: ToolEntry<ConsoleParams, 'capture-buffers'> = {
  name: 'console',
  requires: ['capture-buffers'],
  listed: true,
  coerce: { extension: coerceConsole, 'cdp-direct': coerceConsole },
  handler: (deps, { level }) => {
    const entries = captureWatch(deps).consoleEntries();
    return Promise.resolve(result(level ? entries.filter((e) => e.level === level) : entries));
  },
};

export interface NetworkParams {
  url_filter?: string;
}

const coerceNetwork = (p: Params): NetworkParams => ({ url_filter: optStr(p, 'url_filter') });

export const networkTool: ToolEntry<NetworkParams, 'capture-buffers'> = {
  name: 'network',
  requires: ['capture-buffers'],
  listed: true,
  coerce: { extension: coerceNetwork, 'cdp-direct': coerceNetwork },
  handler: (deps, params) => {
    const filter = params.url_filter?.toLowerCase();
    const list = captureWatch(deps)
      .networkEntries()
      .filter((e) => (filter ? e.url.toLowerCase().includes(filter) : true));
    return Promise.resolve(result(list));
  },
};
