import { describe, expect, test } from 'vitest';
import { CDP_TOOL_SUPPORT, cdpUnsupportedToolError, isCdpToolSupported } from './support.js';

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
