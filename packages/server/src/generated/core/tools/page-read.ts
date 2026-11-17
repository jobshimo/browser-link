// GENERATED from packages/core/src/tools/page-read.ts. Do not edit.
/**
 * Registry entries of the page read and capture tools (design 3.3, slice
 * 15): `ping`, `navigate`, `snapshot`, `state`, `screenshot`, `evaluate`,
 * `canvas_screenshot`, `console`, `network` and `network_body`. Each handler is the body its transport ran in
 * its own `case` before (`background.ts` `handleTool` and its `handle*`
 * functions, `cdp/transport.ts` `callCdpTool`), with the same result.
 *
 * - `ping` answers `{ title, url }` in that key order, from `PageInfo.info`.
 * - `navigate` arms the load wait before the navigation, cancels it when the
 *   navigation fails, and answers `PageInfo.info` as the transport gives it.
 *   Like `evaluate`, it keeps each transport's coercion of a missing string
 *   (the extension's `String(p[key])`, cdp-direct's `''`; design 7(e)).
 * - `evaluate` declares `commandTimeout: 'call-budget'`: a transport that
 *   bounds commands itself (cdp-direct) makes the call's budget the
 *   per-command timeout of the evaluator it gives.
 * - `network_body` requires `response-bodies`, which only the extension
 *   provides (v1 scope).
 * - `canvas_screenshot` requires `canvas`, and `console` and `network`
 *   require `capture-buffers`; cdp-direct provides none of these (v1 scope), so
 *   the registry refuses them there as `unsupported`, which cdp-direct maps
 *   to the text its `callCdpTool` always threw for them.
 */
import { buildCanvasScreenshotJs, type CanvasScreenshotOpts } from '../inpage/canvas.js';
import {
  buildElementRectJs,
  buildSnapshotJs,
  buildStateJs,
  type SnapshotOpts,
} from '../inpage/builders.js';
import type { CaptureWatch } from '../session/page-driver.js';
import { NAVIGATE_LOAD_TIMEOUT_MS } from '../session/load-wait.js';
import {
  runScreenshot,
  type ElementRectOutcome,
  type ScreenshotFormat,
  type ScreenshotMode,
} from '../support/screenshot.js';
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

export interface NavigateParams {
  url: string;
  wait_for_load: boolean;
}

export const navigateTool: ToolEntry<NavigateParams, 'navigator' | 'page'> = {
  name: 'navigate',
  requires: ['navigator', 'page'],
  listed: true,
  coerce: {
    extension: (p) => ({
      url: typeof p.url === 'string' ? p.url : String(p.url),
      wait_for_load: p.wait_for_load !== false,
    }),
    'cdp-direct': (p) => ({
      url: typeof p.url === 'string' ? p.url : '',
      wait_for_load: p.wait_for_load !== false,
    }),
  },
  handler: async ({ navigator, page }, { url, wait_for_load }) => {
    // Armed before the navigation is sent (see session/load-wait.ts).
    const loadWait = wait_for_load ? page.armLoadWait(NAVIGATE_LOAD_TIMEOUT_MS) : undefined;
    try {
      await navigator.navigate(url);
    } catch (err) {
      loadWait?.cancel();
      throw err;
    }
    if (loadWait) await loadWait.done;
    return result(await page.info());
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

export interface ScreenshotParams {
  mode: ScreenshotMode;
  selector?: string;
  format: ScreenshotFormat;
  quality?: number;
  maxDimension?: number;
}

function coerceScreenshot(p: Params): ScreenshotParams {
  return {
    mode: p.mode === 'full_page' || p.mode === 'element' ? p.mode : 'viewport',
    selector: optStr(p, 'selector'),
    format: p.format === 'jpeg' ? 'jpeg' : 'png',
    quality: typeof p.quality === 'number' ? p.quality : undefined,
    maxDimension: typeof p.max_dimension === 'number' ? p.max_dimension : undefined,
  };
}

export const screenshotTool: ToolEntry<ScreenshotParams, 'screen-capture' | 'evaluator'> = {
  name: 'screenshot',
  requires: ['screen-capture', 'evaluator'],
  listed: true,
  coerce: { extension: coerceScreenshot, 'cdp-direct': coerceScreenshot },
  handler: async (deps, params) =>
    result(
      await runScreenshot(
        {
          screen: deps['screen-capture'],
          resolveElementRect: (selector) =>
            deps.evaluator.evaluate<ElementRectOutcome>(buildElementRectJs({ selector })),
        },
        params,
      ),
    ),
};

export interface EvaluateParams {
  expression: string;
}

export const evaluateTool: ToolEntry<EvaluateParams, 'evaluator'> = {
  name: 'evaluate',
  requires: ['evaluator'],
  listed: true,
  commandTimeout: 'call-budget',
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

export interface NetworkBodyParams {
  request_id: string;
}

const coerceNetworkBody = (p: Params): NetworkBodyParams => ({
  request_id: typeof p.request_id === 'string' ? p.request_id : String(p.request_id),
});

export const networkBodyTool: ToolEntry<NetworkBodyParams, 'response-bodies'> = {
  name: 'network_body',
  requires: ['response-bodies'],
  listed: true,
  coerce: { extension: coerceNetworkBody, 'cdp-direct': coerceNetworkBody },
  handler: async (deps, params) => result(await deps['response-bodies'].body(params.request_id)),
};
