import { describe, expect, test, vi } from 'vitest';
import {
  type BrowserToolDeps,
  handleBrowserTool,
  isBrowserTool,
} from './browser-dispatch.js';

function makeDeps(overrides: Partial<BrowserToolDeps> = {}): BrowserToolDeps {
  return {
    listTabs: vi.fn(() => []),
    callBrowserTool: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('isBrowserTool', () => {
  test('recognises every browser.* tool we ship', () => {
    for (const name of [
      'browser.list_tabs',
      'browser.ping',
      'browser.navigate',
      'browser.snapshot',
      'browser.click',
      'browser.type',
      'browser.evaluate',
      'browser.console',
      'browser.network',
      'browser.network_body',
    ]) {
      expect(isBrowserTool(name)).toBe(true);
    }
  });

  test('rejects unrelated tool names', () => {
    expect(isBrowserTool('browser.map.recall')).toBe(false);
    expect(isBrowserTool('something.else')).toBe(false);
  });
});

describe('handleBrowserTool', () => {
  test('list_tabs delegates to deps.listTabs without touching the bridge', async () => {
    const deps = makeDeps({
      listTabs: vi.fn(() => [{ tab_id: 'tab_1', url: 'http://x', title: 't' }]),
    });
    const out = await handleBrowserTool('browser.list_tabs', {}, deps);
    expect(deps.listTabs).toHaveBeenCalledOnce();
    expect(out).toEqual([{ tab_id: 'tab_1', url: 'http://x', title: 't' }]);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('ping forwards the tab_id to the bridge', async () => {
    const deps = makeDeps({ callBrowserTool: vi.fn(async () => ({ ok: true })) });
    await handleBrowserTool('browser.ping', { tab_id: 'tab_1' }, deps);
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'ping', {});
  });

  test('navigate defaults wait_for_load to true and uses the long timeout', async () => {
    const deps = makeDeps({ callBrowserTool: vi.fn(async () => undefined) });
    await handleBrowserTool(
      'browser.navigate',
      { tab_id: 'tab_1', url: 'http://example.com' },
      deps,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'navigate',
      { url: 'http://example.com', wait_for_load: true },
      30_000,
    );
  });

  test('type passes selector, text and clear defaulting to false', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.type',
      { tab_id: 'tab_1', selector: '#x', text: 'hi' },
      deps,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'type', {
      selector: '#x',
      text: 'hi',
      clear: false,
    });
  });

  test('rejects when tab_id is missing on a tool that requires it', async () => {
    const deps = makeDeps();
    await expect(handleBrowserTool('browser.ping', {}, deps)).rejects.toThrow(/tab_id required/);
  });

  test('throws on unknown tool names', async () => {
    const deps = makeDeps();
    await expect(handleBrowserTool('browser.does_not_exist', {}, deps)).rejects.toThrow(
      /Unknown browser tool/,
    );
  });
});
