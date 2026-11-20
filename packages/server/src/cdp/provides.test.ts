// What cdp-direct provides to the tool registry (design 3.3). It provides
// `drag` and `canvas` (parity program P1: the drag input and the CDP event wait
// were already on cdp-direct, and a canvas screenshot rides the evaluator)
// and `dialog-input` (P3: the dial feeds the connection's pending dialog).
// It never enables the Network domain or keeps console messages, so it has no
// capture buffers and a `network_url` wait, `browser.console` and
// `browser.network` are refused; it does not provide `response-bodies`,
// `downloads` or `content-settings`, so `browser.network_body`,
// `browser.set_permission` and `browser.download` are refused. Declaring a capability outside that scope is a
// behavior change (7(e)), so this test pins the set.
import { describe, expect, test } from 'vitest';
import { TOOL_REGISTRY } from '../generated/core/tools/catalog.js';
import { dispatchTool } from '../generated/core/tools/registry.js';
import type { ToolDeps } from '../generated/core/tools/requirement.js';
import { systemClock } from './adapters/system-clock.js';
import { cdpToolResult } from './tool-outcome.js';
import { CDP_DIRECT_PROVIDES } from './transport.js';

describe('CDP_DIRECT_PROVIDES', () => {
  test('is the page ports, the CDP event wait and the flow services, with drag, canvas and dialog-input, without capture-buffers or response-bodies', () => {
    expect([...CDP_DIRECT_PROVIDES].sort()).toEqual([
      'canvas',
      'cdp-events',
      'dialog-input',
      'drag',
      'evaluator',
      'flow-cancel',
      'flows',
      'keyboard',
      'navigator',
      'page',
      'pointer',
      'screen-capture',
      'settler',
    ]);
  });

  test.each([
    ['console', ['capture-buffers']],
    ['network', ['capture-buffers']],
    ['network_body', ['response-bodies']],
    ['set_permission', ['content-settings']],
    ['download', ['downloads']],
    ['download_settle', ['downloads']],
  ])(
    'browser.%s on cdp-direct is refused with the unchanged unsupported text',
    async (tool, missing) => {
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
      expect(() => cdpToolResult(outcome)).toThrow(
        `browser.${tool} is not supported over cdp-direct in v1. Use a tab connected through the Chrome extension instead.`,
      );
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

  test('a network_url wait on cdp-direct is refused with the extension fallback text', async () => {
    const deps = { clock: systemClock } as unknown as ToolDeps;
    const outcome = await dispatchTool(
      TOOL_REGISTRY,
      CDP_DIRECT_PROVIDES,
      deps,
      'cdp-direct',
      'wait_for',
      {
        network_url: '/api',
      },
    );
    expect(outcome).toEqual({
      ok: false,
      failure: {
        kind: 'action',
        message:
          'wait_for: network_url mode is not supported over cdp-direct in v1 (no network buffering) — use a tab connected through the Chrome extension instead.',
      },
    });
  });
});
