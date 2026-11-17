import { describe, expect, test } from 'vitest';
import { TOOL_REGISTRY } from '../generated/core/tools/catalog.js';
import { cdpToolSupport } from '../generated/core/tools/registry.js';
import type { Requirement } from '../generated/core/tools/requirement.js';
import {
  CDP_DECLARED_SUPPORT,
  CDP_DIRECT_PROVIDES,
  CDP_TOOL_SUPPORT,
  cdpUnsupportedToolError,
  isCdpToolSupported,
} from './support.js';

// The hand-written table as it stood at 1.4.23, before it was derived from
// the registry (design 3.3, revision 11). The derived map must equal it.
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
  ['drag', false],
  ['console', false],
  ['network', false],
  ['network_body', false],
  ['canvas_screenshot', false],
  ['dialog_respond', false],
  ['set_permission', false],
  ['wait_for_tab', false],
  ['download', false],
];

const HAND_DECLARED = ['flow', 'flow_status', 'flow_cancel', 'wait_for_tab'];

describe('CDP_TOOL_SUPPORT is derived from the registry (design 3.3)', () => {
  test('equals the 1.4.23 table: the same 23 tools with the same values', () => {
    expect(CDP_TOOL_SUPPORT.size).toBe(23);
    expect(CDP_TOOL_SUPPORT).toEqual(new Map(TABLE_AT_1_4_23));
    expect(Object.fromEntries(CDP_TOOL_SUPPORT)).toEqual(Object.fromEntries(TABLE_AT_1_4_23));
  });

  test('four rows are hand-declared: the transport-owned flow tools and the dispatcher-only wait_for_tab', () => {
    expect([...CDP_DECLARED_SUPPORT.keys()]).toEqual(HAND_DECLARED);
    for (const tool of HAND_DECLARED) expect(TOOL_REGISTRY.has(tool)).toBe(false);
  });

  test('the other 19 rows come from the registry, in the 1.4.23 relative order', () => {
    const derived = cdpToolSupport(TOOL_REGISTRY, CDP_DIRECT_PROVIDES);
    expect([...derived]).toEqual(TABLE_AT_1_4_23.filter(([tool]) => !HAND_DECLARED.includes(tool)));
  });

  test('RED: declaring a capability on cdp-direct changes the snapshot', () => {
    const widened = new Set<Requirement>([...CDP_DIRECT_PROVIDES, 'drag']);
    const derived = new Map([...cdpToolSupport(TOOL_REGISTRY, widened), ...CDP_DECLARED_SUPPORT]);
    expect(derived).not.toEqual(new Map(TABLE_AT_1_4_23));
    expect(derived.get('drag')).toBe(true);
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
];

const UNSUPPORTED = [
  'drag',
  'console',
  'network',
  'network_body',
  'canvas_screenshot',
  'dialog_respond',
  'set_permission',
  'wait_for_tab',
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
});
