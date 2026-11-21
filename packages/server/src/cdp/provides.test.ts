// What cdp-direct provides to the tool registry (design 3.3). It provides
// `drag` and `canvas` (parity program P1: the drag input and the CDP event wait
// were already on cdp-direct, and a canvas screenshot rides the evaluator)
// and `dialog-input` (P3: the dial feeds the connection's pending dialog),
// `capture-buffers` and `response-bodies` (P5: the dial enables Log and
// Network and feeds the connection's capture buffers) and `content-settings`
// (G10: Browser.setPermission on the tab's page connection, a temporary
// override). It does not provide `downloads`, so `browser.download`'s
// selector mode is refused. Declaring a capability outside that scope is a
// behavior change (7(e)), so this test pins the set.
import { describe, expect, test } from 'vitest';
import { TOOL_REGISTRY } from '../generated/core/tools/catalog.js';
import { dispatchTool } from '../generated/core/tools/registry.js';
import type { ToolDeps } from '../generated/core/tools/requirement.js';
import { systemClock } from './adapters/system-clock.js';
import { cdpToolResult } from './tool-outcome.js';
import { CDP_DIRECT_PROVIDES } from './transport.js';

/** The decided refusal of the `downloads` requirement (D17 option b, 2026-11-21). */
const DOWNLOADS_REFUSAL =
  'browser.download with a selector is not supported over cdp-direct: Chrome gives a DevTools client no way to hold a download until it is saved. Pass url instead (it works on cdp: tabs), or use a tab connected through the Chrome extension.';

describe('CDP_DIRECT_PROVIDES', () => {
  test('is the page ports, the CDP event wait and the flow services, with drag, canvas, dialog-input, capture-buffers, response-bodies and content-settings', () => {
    expect([...CDP_DIRECT_PROVIDES].sort()).toEqual([
      'canvas',
      'capture-buffers',
      'cdp-events',
      'content-settings',
      'dialog-input',
      'drag',
      'evaluator',
      'flow-cancel',
      'flows',
      'keyboard',
      'navigator',
      'page',
      'pointer',
      'response-bodies',
      'screen-capture',
      'settler',
    ]);
  });

  test.each([
    ['download', ['downloads'], DOWNLOADS_REFUSAL],
    ['download_settle', ['downloads'], DOWNLOADS_REFUSAL],
  ])(
    'browser.%s on cdp-direct is refused with its unsupported text',
    async (tool, missing, text) => {
      const deps = { clock: systemClock } as unknown as ToolDeps;
      const outcome = await dispatchTool(
        TOOL_REGISTRY,
        CDP_DIRECT_PROVIDES,
        deps,
        'cdp-direct',
        tool,
        {},
      );
      expect(outcome).toEqual({ ok: false, failure: { kind: 'unsupported', tool, missing } });
      expect(() => cdpToolResult(outcome)).toThrow(text);
    },
  );

  test('browser.drag on cdp-direct runs through the registry instead of being refused', async () => {
    const mouse: string[] = [];
    const deps = {
      clock: systemClock,
      evaluator: {
        evaluate: () =>
          Promise.resolve({
            from: { x: 1, y: 2, in_viewport: true },
            to: { x: 3, y: 4, in_viewport: true },
            draggable: false,
          }),
      },
      pointer: {
        mouse: (e: { type: string }) => {
          mouse.push(e.type);
          return Promise.resolve();
        },
      },
      drag: {},
      'cdp-events': {},
    } as unknown as ToolDeps;
    const outcome = await dispatchTool(
      TOOL_REGISTRY,
      CDP_DIRECT_PROVIDES,
      deps,
      'cdp-direct',
      'drag',
      { from_selector: '#card', to_selector: '#zone', duration_ms: 0 },
    );
    expect(outcome.ok).toBe(true);
    expect(mouse).toEqual(['mouseMoved', 'mousePressed', 'mouseMoved', 'mouseReleased']);
  });

  test('browser.canvas_screenshot on cdp-direct reads through the evaluator instead of being refused', async () => {
    const expressions: string[] = [];
    const deps = {
      clock: systemClock,
      evaluator: {
        evaluate: (expression: string) => {
          expressions.push(expression);
          return Promise.resolve({ ok: true, format: 'png', image_b64: 'AAAA' });
        },
      },
    } as unknown as ToolDeps;
    const outcome = await dispatchTool(
      TOOL_REGISTRY,
      CDP_DIRECT_PROVIDES,
      deps,
      'cdp-direct',
      'canvas_screenshot',
      {},
    );
    expect(outcome.ok).toBe(true);
    expect(expressions).toHaveLength(1);
  });

  test('browser.console, browser.network and a network_url wait read the capture watch instead of being refused (P5)', async () => {
    const entry = { timestamp: 1, level: 'log', text: 'hi', source: 'console' };
    const request = {
      request_id: 'r1',
      url: 'https://example.com/api',
      method: 'GET',
      started_at: 1,
      finished_at: 2,
    };
    const deps = {
      clock: systemClock,
      evaluator: { evaluate: () => Promise.resolve(true) },
      captureBuffers: {
        consoleEntries: () => [entry],
        networkEntries: () => [request],
        finishedUrls: () => [request.url],
      },
    } as unknown as ToolDeps;
    const run = (tool: string, params: Record<string, unknown>) =>
      dispatchTool(TOOL_REGISTRY, CDP_DIRECT_PROVIDES, deps, 'cdp-direct', tool, params);
    expect(await run('console', {})).toEqual({ ok: true, result: [entry] });
    expect(await run('network', {})).toEqual({ ok: true, result: [request] });
    expect(await run('wait_for', { network_url: '/api' })).toMatchObject({
      ok: true,
      result: { matched: true },
    });
  });
});
