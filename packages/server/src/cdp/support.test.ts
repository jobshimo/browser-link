import { describe, expect, test } from 'vitest';
import { TOOL_REGISTRY } from '../generated/core/tools/catalog.js';
import { cdpToolSupport } from '../generated/core/tools/registry.js';
import type { Requirement } from '../generated/core/tools/requirement.js';
import {
  CDP_DIRECT_PROVIDES,
  CDP_TOOL_SUPPORT,
  cdpUnsupportedToolError,
  isCdpToolSupported,
} from './support.js';

// The hand-written table as it stood at 1.4.23, before it was derived from
// the registry (design 3.3, revision 11), with the rows the parity program
// flipped (P1: drag, canvas_screenshot; P3: dialog_respond; P5: console,
// network, network_body) and without the
// hand-declared `wait_for_tab` row P7 removed (G11: the dispatcher answers
// `wait_for_tab` itself on both transports). The derived map must equal it.
const TABLE_AT_1_4_23: readonly (readonly [string, boolean])[] = [
  ['ping', true],
  ['navigate', true],
  ['snapshot', true],
  ['find', true],
  ['state', true],
  ['screenshot', true],
  ['click', true],
  ['type', true],
  ['press', true],
  ['evaluate', true],
  ['wait_for', true],
  ['flow', true],
  ['flow_status', true],
  ['flow_cancel', true],
  ['drag', true],
  ['console', true],
  ['network', true],
  ['network_body', true],
  ['canvas_screenshot', true],
  ['dialog_respond', true],
  ['set_permission', false],
  ['download', false],
];

describe('CDP_TOOL_SUPPORT is derived from the registry (design 3.3)', () => {
  test('equals the 1.4.23 table with the parity rows flipped and wait_for_tab gone: 22 tools', () => {
    expect(CDP_TOOL_SUPPORT.size).toBe(22);
    expect(CDP_TOOL_SUPPORT).toEqual(new Map(TABLE_AT_1_4_23));
    expect(Object.fromEntries(CDP_TOOL_SUPPORT)).toEqual(Object.fromEntries(TABLE_AT_1_4_23));
  });

  test('no row is hand-declared: every row comes from the registry, in the 1.4.23 relative order', () => {
    const derived = cdpToolSupport(TOOL_REGISTRY, CDP_DIRECT_PROVIDES);
    expect([...derived]).toEqual([...TABLE_AT_1_4_23]);
  });

  test('wait_for_tab has no row: it is dispatcher-only and never reaches a transport (P7, G11)', () => {
    expect(TOOL_REGISTRY.has('wait_for_tab')).toBe(false);
    expect(CDP_TOOL_SUPPORT.has('wait_for_tab')).toBe(false);
  });

  test('RED: declaring a capability on cdp-direct changes the snapshot', () => {
    const widened = new Set<Requirement>([...CDP_DIRECT_PROVIDES, 'content-settings']);
    const derived = new Map(cdpToolSupport(TOOL_REGISTRY, widened));
    expect(derived).not.toEqual(new Map(TABLE_AT_1_4_23));
    expect(derived.get('set_permission')).toBe(true);
  });
});

const SUPPORTED = [
  'ping',
  'navigate',
  'snapshot',
  'find',
  'state',
  'click',
  'type',
  'press',
  'evaluate',
  'wait_for',
  'flow',
  // Full parity for the flow lifecycle: the cdp-direct runner is
  // in-process, so status and cancel are if anything simpler there than
  // over the extension bridge. The popup kill switch is the one thing
  // with no cdp-direct equivalent (`browser-link cdp revoke` instead).
  'flow_status',
  'flow_cancel',
  // Raw CDP Page.getLayoutMetrics + Page.captureScreenshot: same two commands
  // the extension sends.
  'screenshot',
  // Parity program P1: the drag input and the CDP event wait were already on
  // cdp-direct, and a canvas screenshot rides the evaluator.
  'drag',
  'canvas_screenshot',
  // Parity program P3: the dial feeds the connection's pending dialog, so a
  // dialog the connection saw open is answered with Page.handleJavaScriptDialog.
  'dialog_respond',
  // Parity program P5: the dial enables Log and Network and feeds the
  // connection's capture buffers; bodies are read over the same connection.
  'console',
  'network',
  'network_body',
];

const UNSUPPORTED = [
  'set_permission',
  // Selector mode only — it needs the extension's chrome.downloads capture.
  // browser.download's url mode never reaches this wire tool: it rides
  // `evaluate`, which IS supported.
  'download',
];

describe('CDP_TOOL_SUPPORT / isCdpToolSupported', () => {
  test.each(SUPPORTED)('%s is supported', (tool) => {
    expect(isCdpToolSupported(tool)).toBe(true);
    expect(CDP_TOOL_SUPPORT.get(tool)).toBe(true);
  });

  test.each(UNSUPPORTED)('%s is explicitly NOT supported', (tool) => {
    expect(isCdpToolSupported(tool)).toBe(false);
    expect(CDP_TOOL_SUPPORT.get(tool)).toBe(false);
  });

  test('an unknown tool name is not supported', () => {
    expect(isCdpToolSupported('made_up_tool')).toBe(false);
    expect(CDP_TOOL_SUPPORT.get('made_up_tool')).toBeUndefined();
  });

  test('the table covers every tool checked here — nothing silently falls through', () => {
    for (const tool of [...SUPPORTED, ...UNSUPPORTED]) {
      expect(CDP_TOOL_SUPPORT.has(tool)).toBe(true);
    }
  });
});

describe('cdpUnsupportedToolError', () => {
  test('names the tool and points at the extension transport', () => {
    const err = cdpUnsupportedToolError('drag');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('browser.drag');
    expect(err.message).toMatch(/not supported over cdp-direct/i);
    expect(err.message).toMatch(/extension/i);
  });

  test("download's selector mode names both ways out: url mode and the extension transport", () => {
    expect(cdpUnsupportedToolError('download').message).toBe(
      'browser.download with a selector is not supported over cdp-direct: Chrome gives a DevTools client no way to hold a download until it is saved. Pass url instead (it works on cdp: tabs), or use a tab connected through the Chrome extension.',
    );
  });
});
