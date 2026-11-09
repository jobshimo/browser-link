import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/* Mock only the leaf handlers — dispatch.ts is pure routing. Each handler
 * has its own dedicated test file; here we just verify that dispatch picks
 * the right one and folds the result into the MCP envelope correctly. */
vi.mock('../map/tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../map/tools.js')>();
  return { ...actual, handleMapTool: vi.fn() };
});

vi.mock('../tools/browser-dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/browser-dispatch.js')>();
  return { ...actual, handleBrowserTool: vi.fn(), outdatedServerHint: vi.fn(() => null) };
});

import { handleToolCall, handleToolsList, type DispatchDeps } from './dispatch.js';
import { handleMapTool } from '../map/tools.js';
import {
  handleBrowserTool,
  outdatedServerHint,
  type BrowserToolDeps,
} from '../tools/browser-dispatch.js';
import type { AgentCaller } from '../tools/tab-claims.js';
import { BridgeEventLog } from './events.js';

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

describe('handleToolCall — screenshot image content', () => {
  test('browser.screenshot returns MCP image content plus a metadata text block without the base64', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue({
      ok: true,
      mode: 'full_page',
      format: 'jpeg',
      width: 10,
      height: 20,
      scale: 1,
      bytes: 3,
      image_b64: 'QUJD',
    });
    const res = await handleToolCall(
      { name: 'browser.screenshot', arguments: { tab_id: 'tab_1' }, caller: TEST_CALLER },
      makeDeps(),
    );
    expect(res.content).toHaveLength(2);
    expect(res.content[1]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' });
    const meta = JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(meta).toMatchObject({ ok: true, mode: 'full_page', width: 10, bytes: 3 });
    expect(meta).not.toHaveProperty('image_b64');
  });

  test('png maps to image/png', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue({ ok: true, format: 'png', image_b64: 'QUJD' });
    const res = await handleToolCall(
      { name: 'browser.screenshot', arguments: { tab_id: 'tab_1' }, caller: TEST_CALLER },
      makeDeps(),
    );
    expect(res.content[1]).toMatchObject({ mimeType: 'image/png' });
  });

  test('a result without image data stays a plain text response', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue({ ok: false, reason: 'x' });
    const res = await handleToolCall(
      { name: 'browser.screenshot', arguments: { tab_id: 'tab_1' }, caller: TEST_CALLER },
      makeDeps(),
    );
    expect(res.content).toHaveLength(1);
  });
});

describe('handleToolCall — empty list_tabs hint block', () => {
  function depsWithEvents(): DispatchDeps {
    const log = new BridgeEventLog();
    log.add('primary-elected', { pid: 1 });
    log.add('tab-registered', { tabId: 'tab_1', url: 'https://a.test/x' });
    log.add('tab-disconnected', { tabId: 'tab_1' });
    return makeDeps({
      browserTools: {
        listTabs: vi.fn(() => []),
        callBrowserTool: vi.fn(async () => undefined),
        recentEvents: (o) => log.recent(o),
      } as BrowserToolDeps,
    });
  }
  const call = { name: 'browser.list_tabs', arguments: {}, caller: TEST_CALLER };

  test('empty list: first block is the unchanged bare [] and a SECOND block carries the hint', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue([]);
    const res = await handleToolCall(call, depsWithEvents());
    expect(res.content).toHaveLength(2);
    expect((res.content[0] as { text: string }).text).toBe('[]');
    const hint = (res.content[1] as { text: string }).text;
    expect(hint.startsWith('hint: ')).toBe(true);
    expect(hint).toContain('tab_1 (https://a.test)');
  });

  test('non-empty list: a single block, exactly as before', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue([{ tab_id: 'tab_1' }]);
    const res = await handleToolCall(call, depsWithEvents());
    expect(res.content).toHaveLength(1);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual([{ tab_id: 'tab_1' }]);
  });

  test('empty list without an event log: single [] block, no hint', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue([]);
    const res = await handleToolCall(call, makeDeps());
    expect(res.content).toHaveLength(1);
    expect((res.content[0] as { text: string }).text).toBe('[]');
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

describe('handleToolCall — outdated-server hint on list_tabs (0.41.0)', () => {
  const call = { name: 'browser.list_tabs', arguments: {}, caller: TEST_CALLER };
  const OUTDATED = 'server running 0.40.0, installed 0.41.0: this server is outdated';

  afterEach(() => {
    vi.mocked(outdatedServerHint).mockReturnValue(null);
  });

  test('non-empty list with an outdated server: bare array first, hint second', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue([{ tab_id: 'tab_1' }]);
    vi.mocked(outdatedServerHint).mockReturnValue(OUTDATED);
    const res = await handleToolCall(call, makeDeps());
    expect(res.content).toHaveLength(2);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual([{ tab_id: 'tab_1' }]);
    expect((res.content[1] as { text: string }).text).toBe(`hint: ${OUTDATED}`);
  });

  test('non-empty list with a current server: single block, no hint (unchanged)', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue([{ tab_id: 'tab_1' }]);
    const res = await handleToolCall(call, makeDeps());
    expect(res.content).toHaveLength(1);
  });

  test('empty list without an event log but an outdated server: the hint still appears', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue([]);
    vi.mocked(outdatedServerHint).mockReturnValue(OUTDATED);
    const res = await handleToolCall(call, makeDeps());
    expect(res.content).toHaveLength(2);
    expect((res.content[1] as { text: string }).text).toBe(`hint: ${OUTDATED}`);
  });
});
