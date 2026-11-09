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
import { clearTypedValues, typedValues } from '../map/readers.js';
import type { ActivityInput } from '../activity/types.js';
import { markRulesDelivered, notePendingWork, peekSession, resetSessions } from '../map/session.js';

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
  // Every test except the S13 ones runs in a session that already got its
  // rules block, so their responses read exactly as before.
  resetSessions();
  markRulesDelivered(TEST_CALLER.agent_id);
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

describe('handleToolCall — map tools are recorded in the trail (0.45.0)', () => {
  function recordingDeps(recordActivity = vi.fn<(row: ActivityInput) => void>()): {
    deps: DispatchDeps;
    recordActivity: typeof recordActivity;
  } {
    const deps = makeDeps({
      browserTools: {
        listTabs: vi.fn(() => []),
        callBrowserTool: vi.fn(async () => undefined),
        recordActivity,
      } as BrowserToolDeps,
    });
    return { deps, recordActivity };
  }

  test('a successful map call leaves one ok row with its result size, response unchanged', async () => {
    vi.mocked(handleMapTool).mockReturnValue({ entries: [] });
    const { deps, recordActivity } = recordingDeps();
    const out = await handleToolCall(
      { name: 'browser.map.recall', arguments: { origin: 'https://x' }, caller: TEST_CALLER },
      deps,
    );
    expect(out).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ entries: [] }, null, 2) }],
    });
    expect(recordActivity).toHaveBeenCalledOnce();
    expect(recordActivity.mock.calls[0]?.[0]).toMatchObject({
      tool: 'browser.map.recall',
      outcome: 'ok',
      error: null,
      agentId: 'test',
      agent: 'vitest',
      resultBytes: Buffer.byteLength(JSON.stringify({ entries: [] })),
    });
  });

  test('a throwing map call leaves an error row and still answers with a toolError', async () => {
    vi.mocked(handleMapTool).mockImplementation(() => {
      throw new Error('sync boom');
    });
    const { deps, recordActivity } = recordingDeps();
    const out = await handleToolCall(
      { name: 'browser.map.save', arguments: {}, caller: TEST_CALLER },
      deps,
    );
    expect(out.isError).toBe(true);
    expect(recordActivity.mock.calls[0]?.[0]).toMatchObject({
      tool: 'browser.map.save',
      outcome: 'error',
      error: 'sync boom',
      resultBytes: null,
    });
  });

  test('a throwing sink cannot break the map call', async () => {
    vi.mocked(handleMapTool).mockReturnValue({ ok: true });
    const { deps } = recordingDeps(
      vi.fn(() => {
        throw new Error('disk on fire');
      }),
    );
    const out = await handleToolCall(
      { name: 'browser.map.apps', arguments: {}, caller: TEST_CALLER },
      deps,
    );
    expect(out.isError).toBeUndefined();
  });

  test('with no sink wired a map call records nothing and answers as before', async () => {
    vi.mocked(handleMapTool).mockReturnValue({ entries: [] });
    const out = await handleToolCall(
      { name: 'browser.map.recall', arguments: {}, caller: TEST_CALLER },
      makeDeps(),
    );
    expect(JSON.parse(out.content[0]?.text as string)).toEqual({ entries: [] });
  });

  test('the list_tabs hint still works with a sink wired', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue([]);
    const log = new BridgeEventLog();
    log.add('tab-registered', { tabId: 'tab_1', url: 'https://a.test/x' });
    log.add('tab-disconnected', { tabId: 'tab_1' });
    const res = await handleToolCall(
      { name: 'browser.list_tabs', arguments: {}, caller: TEST_CALLER },
      makeDeps({
        browserTools: {
          listTabs: vi.fn(() => []),
          callBrowserTool: vi.fn(async () => undefined),
          recentEvents: (o) => log.recent(o),
          recordActivity: vi.fn(),
        } as BrowserToolDeps,
      }),
    );
    expect(res.content).toHaveLength(2);
    expect((res.content[0] as { text: string }).text).toBe('[]');
  });
});

describe('handleToolCall — typed values are remembered for the JS registry', () => {
  afterEach(() => clearTypedValues());

  test('browser.type text and flow type steps are remembered before dispatch', async () => {
    clearTypedValues();
    vi.mocked(handleBrowserTool).mockImplementation(async () => {
      // Remembered BEFORE the call runs, so an evaluate racing it is covered.
      expect(typedValues()).toContain('hunter22');
      return { ok: true };
    });
    await handleToolCall(
      {
        name: 'browser.type',
        arguments: { tab_id: 't1', selector: '#pw', text: 'hunter22' },
        caller: TEST_CALLER,
      },
      makeDeps(),
    );
    await handleToolCall(
      {
        name: 'browser.flow',
        arguments: { tab_id: 't1', steps: [{ type: { text: 'shrek' } }] },
        caller: TEST_CALLER,
      },
      makeDeps(),
    ).catch(() => undefined);
    expect(typedValues()).toEqual(['hunter22', 'shrek']);
  });

  test('a disabled browser.type remembers nothing', async () => {
    clearTypedValues();
    await handleToolCall(
      { name: 'browser.type', arguments: { text: 'secret-ish' }, caller: TEST_CALLER },
      makeDeps({ disabledTools: ['browser.type'] }),
    );
    expect(typedValues()).toEqual([]);
  });
});

describe('handleToolCall — knowledge-loop session (S9, S13)', () => {
  const FRESH: AgentCaller = { agent_id: 'fresh-session', pid: 1, binary: 'vitest' };
  const tabs = [{ tab_id: 't1', url: 'https://app.test/list', title: 'A' }];
  const deps = (): DispatchDeps =>
    makeDeps({
      browserTools: {
        listTabs: vi.fn(() => tabs),
        callBrowserTool: vi.fn(async () => undefined),
      } as BrowserToolDeps,
    });
  const texts = (res: { content: { type: string; text?: string }[] }): string[] =>
    res.content.map((c) => c.text ?? '');
  const RULES = 'browser-link rules:';

  test('the first browser call of a session carries the rules as a second block, once', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue({ ok: true });
    const first = await handleToolCall(
      { name: 'browser.snapshot', arguments: { tab_id: 't1' }, caller: FRESH },
      deps(),
    );
    expect(first.content).toHaveLength(2);
    expect(JSON.parse(texts(first)[0])).toEqual({ ok: true });
    expect(texts(first)[1].startsWith(`${RULES}\n`)).toBe(true);
    expect(texts(first)[1].length).toBeGreaterThan(RULES.length + 1);
    const second = await handleToolCall(
      { name: 'browser.snapshot', arguments: { tab_id: 't1' }, caller: FRESH },
      deps(),
    );
    expect(second.content).toHaveLength(1);
  });

  test('browser.manual and map tools count as the first call; each session gets its own', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue('manual text');
    const manual = await handleToolCall(
      { name: 'browser.manual', arguments: {}, caller: FRESH },
      deps(),
    );
    expect(texts(manual)[0]).toBe('manual text');
    expect(texts(manual)[1].startsWith(RULES)).toBe(true);
    vi.mocked(handleMapTool).mockReturnValue({ apps: [] });
    const other: AgentCaller = { agent_id: 'other-session', pid: 2, binary: 'vitest' };
    const map = await handleToolCall({ name: 'browser.map.apps', caller: other }, deps());
    expect(map.content).toHaveLength(2);
  });

  test('a failing first call still delivers the rules after the error', async () => {
    vi.mocked(handleBrowserTool).mockRejectedValue(new Error('boom'));
    const res = await handleToolCall(
      { name: 'browser.click', arguments: { tab_id: 't1' }, caller: FRESH },
      deps(),
    );
    expect(res.isError).toBe(true);
    expect(texts(res)[0]).toBe('Error: boom');
    expect(texts(res)[1].startsWith(RULES)).toBe(true);
  });

  test('list_tabs keeps its hint block and the rules come last', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValue([]);
    const events = new BridgeEventLog();
    const res = await handleToolCall(
      { name: 'browser.list_tabs', caller: FRESH },
      makeDeps({
        browserTools: {
          listTabs: vi.fn(() => []),
          callBrowserTool: vi.fn(async () => undefined),
          recentEvents: (opts) => events.recent(opts),
        } as BrowserToolDeps,
      }),
    );
    expect(texts(res)).toHaveLength(3);
    expect(texts(res)[0]).toBe('[]');
    expect(texts(res)[1].startsWith('hint: ')).toBe(true);
    expect(texts(res)[2].startsWith(RULES)).toBe(true);
  });

  test('pending_wrap_up appears only after a successful evaluate or flow, on object results only', async () => {
    vi.mocked(handleBrowserTool).mockResolvedValueOnce({ ok: true });
    const before = await handleToolCall(
      { name: 'browser.click', arguments: { tab_id: 't1' }, caller: TEST_CALLER },
      deps(),
    );
    expect(JSON.parse(texts(before)[0])).toEqual({ ok: true });

    vi.mocked(handleBrowserTool).mockResolvedValueOnce(42);
    const evalRes = await handleToolCall(
      {
        name: 'browser.evaluate',
        arguments: { tab_id: 't1', expression: '42' },
        caller: TEST_CALLER,
      },
      deps(),
    );
    // A raw value is never decorated.
    expect(texts(evalRes)[0]).toBe('42');
    expect(peekSession(TEST_CALLER.agent_id)?.pendingWrapUp).toBe(1);

    vi.mocked(handleBrowserTool).mockResolvedValueOnce({ ok: true });
    const after = await handleToolCall(
      { name: 'browser.click', arguments: { tab_id: 't1' }, caller: TEST_CALLER },
      deps(),
    );
    expect(JSON.parse(texts(after)[0])).toEqual({ ok: true, pending_wrap_up: 1 });
    expect(after.content).toHaveLength(1);

    vi.mocked(handleBrowserTool).mockResolvedValueOnce({ ok: true, steps_completed: 1 });
    const flowRes = await handleToolCall(
      { name: 'browser.flow', arguments: { tab_id: 't1', steps: [] }, caller: TEST_CALLER },
      deps(),
    );
    expect(JSON.parse(texts(flowRes)[0])).toEqual({
      ok: true,
      steps_completed: 1,
      pending_wrap_up: 2,
    });

    vi.mocked(handleBrowserTool).mockResolvedValueOnce([{ tab_id: 't1' }]);
    const list = await handleToolCall({ name: 'browser.list_tabs', caller: TEST_CALLER }, deps());
    expect(JSON.parse(texts(list)[0])).toEqual([{ tab_id: 't1' }]);
  });

  test('a failed evaluate, a dry run and a failed flow add no pending work', async () => {
    vi.mocked(handleBrowserTool).mockRejectedValueOnce(new Error('ReferenceError'));
    await handleToolCall(
      {
        name: 'browser.evaluate',
        arguments: { tab_id: 't1', expression: 'x' },
        caller: TEST_CALLER,
      },
      deps(),
    );
    vi.mocked(handleBrowserTool).mockResolvedValueOnce({ ok: true, dry_run: true });
    await handleToolCall(
      {
        name: 'browser.flow',
        arguments: { tab_id: 't1', steps: [], dry_run: true },
        caller: TEST_CALLER,
      },
      deps(),
    );
    vi.mocked(handleBrowserTool).mockResolvedValueOnce({ ok: false, failed_step: 0 });
    await handleToolCall(
      { name: 'browser.flow', arguments: { tab_id: 't1', steps: [] }, caller: TEST_CALLER },
      deps(),
    );
    expect(peekSession(TEST_CALLER.agent_id)?.pendingWrapUp).toBe(0);
  });

  test('map tool object results carry pending_wrap_up too', async () => {
    notePendingWork(TEST_CALLER.agent_id);
    vi.mocked(handleMapTool).mockReturnValue({ apps: [] });
    const res = await handleToolCall({ name: 'browser.map.apps', caller: TEST_CALLER }, deps());
    expect(JSON.parse(texts(res)[0])).toEqual({ apps: [], pending_wrap_up: 1 });
  });

  test('the origin of the tab used and every typed or filled value are kept on the session', async () => {
    clearTypedValues();
    vi.mocked(handleBrowserTool).mockResolvedValue({ ok: true });
    await handleToolCall(
      {
        name: 'browser.type',
        arguments: { tab_id: 't1', selector: '#q', text: 'acme corp' },
        caller: TEST_CALLER,
      },
      deps(),
    );
    await handleToolCall(
      {
        name: 'browser.read',
        arguments: { tab_id: 't1', name: 'client-row', values: { CLIENT: 'Juan' } },
        caller: TEST_CALLER,
      },
      deps(),
    );
    const session = peekSession(TEST_CALLER.agent_id)!;
    expect([...session.origins]).toEqual(['https://app.test']);
    expect(session.typedValues).toEqual(['acme corp', 'Juan']);
    expect(typedValues()).toEqual(['acme corp', 'Juan']);
    clearTypedValues();
  });

  test('a disabled tool neither delivers the rules nor starts a session', async () => {
    const res = await handleToolCall(
      { name: 'browser.click', arguments: {}, caller: FRESH },
      makeDeps({ disabledTools: ['browser.click'] }),
    );
    expect(res.content).toHaveLength(1);
    expect(peekSession(FRESH.agent_id)).toBeUndefined();
  });
});
