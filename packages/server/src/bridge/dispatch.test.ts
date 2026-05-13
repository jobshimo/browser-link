import { beforeEach, describe, expect, test, vi } from 'vitest';

/* Mock only the leaf handlers — dispatch.ts is pure routing. Each handler
 * has its own dedicated test file; here we just verify that dispatch picks
 * the right one and folds the result into the MCP envelope correctly. */
vi.mock('../map/tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../map/tools.js')>();
  return { ...actual, handleMapTool: vi.fn() };
});

vi.mock('../tools/browser-dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/browser-dispatch.js')>();
  return { ...actual, handleBrowserTool: vi.fn() };
});

import { handleToolCall, handleToolsList, type DispatchDeps } from './dispatch.js';
import { handleMapTool } from '../map/tools.js';
import { handleBrowserTool, type BrowserToolDeps } from '../tools/browser-dispatch.js';
import type { AgentCaller } from '../tools/tab-claims.js';

const TEST_CALLER: AgentCaller = {
  agent_id: 'test',
  pid: 0,
  binary: 'vitest',
};

interface MakeDepsOverrides {
  browserTools?: BrowserToolDeps;
  /** Ergonomic shape for tests — passed through to the live-lookup function
   * that the production code expects. */
  disabledTools?: readonly string[];
}

function makeDeps(overrides: MakeDepsOverrides = {}): DispatchDeps {
  return {
    browserTools:
      overrides.browserTools ??
      ({
        listTabs: vi.fn(() => []),
        callBrowserTool: vi.fn(async () => undefined),
      } as BrowserToolDeps),
    disabledTools: () => overrides.disabledTools ?? [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleToolsList', () => {
  test('returns the union of browser and map tool definitions when nothing is disabled', () => {
    const result = handleToolsList(makeDeps());
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('browser.list_tabs');
    expect(names).toContain('browser.evaluate');
    expect(names).toContain('browser.map.recall');
    expect(names).toContain('browser.map.save');
  });

  test('filters out disabled tools', () => {
    const result = handleToolsList(
      makeDeps({ disabledTools: ['browser.evaluate', 'browser.map.forget'] }),
    );
    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain('browser.evaluate');
    expect(names).not.toContain('browser.map.forget');
    // The rest are still there.
    expect(names).toContain('browser.list_tabs');
    expect(names).toContain('browser.map.recall');
  });

  test('every tool exposes name, description and inputSchema', () => {
    const result = handleToolsList(makeDeps());
    for (const tool of result.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.inputSchema).toBe('object');
    }
  });

  test('returns the same definition objects regardless of disabledTools content', () => {
    const a = handleToolsList(makeDeps());
    const b = handleToolsList(makeDeps({ disabledTools: ['browser.evaluate'] }));
    const listTabsA = a.tools.find((t) => t.name === 'browser.list_tabs');
    const listTabsB = b.tools.find((t) => t.name === 'browser.list_tabs');
    expect(listTabsA).toEqual(listTabsB);
  });
});

describe('handleToolCall — routing', () => {
  test('routes a known browser tool to handleBrowserTool with the same args + deps.browserTools + caller', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue({ ok: true });
    const deps = makeDeps();
    await handleToolCall(
      { name: 'browser.ping', arguments: { tab_id: 't1' }, caller: TEST_CALLER },
      deps,
    );
    expect(handleBrowserTool).toHaveBeenCalledExactlyOnceWith(
      'browser.ping',
      { tab_id: 't1' },
      deps.browserTools,
      TEST_CALLER,
    );
    expect(handleMapTool).not.toHaveBeenCalled();
  });

  test('routes a known map tool to handleMapTool — async wraps the sync handler', async () => {
    vi.mocked(handleMapTool).mockReturnValue({ entries: [] });
    const deps = makeDeps();
    await handleToolCall(
      { name: 'browser.map.recall', arguments: { origin: 'https://x' }, caller: TEST_CALLER },
      deps,
    );
    expect(handleMapTool).toHaveBeenCalledExactlyOnceWith('browser.map.recall', {
      origin: 'https://x',
    });
    expect(handleBrowserTool).not.toHaveBeenCalled();
  });

  test('passes undefined arguments through unchanged', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue(undefined);
    const deps = makeDeps();
    await handleToolCall({ name: 'browser.list_tabs', caller: TEST_CALLER }, deps);
    expect(handleBrowserTool).toHaveBeenCalledWith(
      'browser.list_tabs',
      undefined,
      deps.browserTools,
      TEST_CALLER,
    );
  });
});

describe('handleToolCall — response envelope', () => {
  test('wraps the browser-tool result as a JSON-stringified text payload', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue({ ok: true, value: 42 });
    const out = await handleToolCall(
      { name: 'browser.ping', arguments: { tab_id: 't1' }, caller: TEST_CALLER },
      makeDeps(),
    );
    expect(out).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, value: 42 }, null, 2),
        },
      ],
    });
    expect(out.isError).toBeUndefined();
  });

  test('wraps a string handler result without re-stringifying it', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue('plain text payload');
    const out = await handleToolCall(
      { name: 'browser.ping', arguments: { tab_id: 't1' }, caller: TEST_CALLER },
      makeDeps(),
    );
    expect(out.content[0]?.text).toBe('plain text payload');
  });

  test('wraps the map-tool sync result through toolResponse', async () => {
    vi.mocked(handleMapTool).mockReturnValue({ apps: ['a', 'b'] });
    const out = await handleToolCall({ name: 'browser.map.apps', caller: TEST_CALLER }, makeDeps());
    expect(out.content[0]?.text).toBe(JSON.stringify({ apps: ['a', 'b'] }, null, 2));
  });
});

describe('handleToolCall — refusal and error handling', () => {
  test('refuses a disabled tool with a guidance message + isError flag', async () => {
    const deps = makeDeps({ disabledTools: ['browser.evaluate'] });
    const out = await handleToolCall(
      { name: 'browser.evaluate', arguments: {}, caller: TEST_CALLER },
      deps,
    );
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain('Error: Tool "browser.evaluate" is disabled');
    expect(out.content[0]?.text).toContain('browser-link tools enable browser.evaluate');
    expect(handleBrowserTool).not.toHaveBeenCalled();
    expect(handleMapTool).not.toHaveBeenCalled();
  });

  test('refuses an unknown tool with "Unknown tool: <name>"', async () => {
    const out = await handleToolCall({ name: 'totally.unknown', caller: TEST_CALLER }, makeDeps());
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toBe('Error: Unknown tool: totally.unknown');
    expect(handleBrowserTool).not.toHaveBeenCalled();
    expect(handleMapTool).not.toHaveBeenCalled();
  });

  test('converts a sync throw from a map tool into a toolError', async () => {
    vi.mocked(handleMapTool).mockImplementation(() => {
      throw new Error('sync boom');
    });
    const out = await handleToolCall(
      { name: 'browser.map.recall', arguments: {}, caller: TEST_CALLER },
      makeDeps(),
    );
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toBe('Error: sync boom');
  });

  test('converts an async rejection from a browser tool into a toolError', async () => {
    vi.mocked(handleBrowserTool).mockRejectedValue(new Error('async boom'));
    const out = await handleToolCall(
      { name: 'browser.ping', arguments: { tab_id: 't1' }, caller: TEST_CALLER },
      makeDeps(),
    );
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toBe('Error: async boom');
  });

  test('stringifies non-Error throws (some libraries throw plain strings)', async () => {
    vi.mocked(handleMapTool).mockImplementation(() => {
      throw 'just a bare string';
    });
    const out = await handleToolCall(
      { name: 'browser.map.recall', arguments: {}, caller: TEST_CALLER },
      makeDeps(),
    );
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toBe('Error: just a bare string');
  });

  test('returns the disabled-tool refusal even when the tool would otherwise dispatch — defence in depth', async () => {
    /* The catalogue exposed via tools/list filters disabled tools, but a
     * client that cached an old list could still send a tools/call for one.
     * dispatch.ts must refuse independently. */
    const deps = makeDeps({ disabledTools: ['browser.map.recall'] });
    const out = await handleToolCall(
      { name: 'browser.map.recall', arguments: { origin: 'x' }, caller: TEST_CALLER },
      deps,
    );
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain('disabled');
    expect(handleMapTool).not.toHaveBeenCalled();
  });
});
