import { describe, expect, test } from 'vitest';
import {
  agentNameFor,
  buildActivityRow,
  buildRow,
  classifyFlag,
  extractFlowId,
  extractPayload,
  extractSelector,
  extractTabId,
  transportFor,
} from './extract.js';
import { handleBrowserTool, type BrowserToolDeps } from '../tools/browser-dispatch.js';
import type { ActivityInput } from './types.js';

const caller = { agent_id: 'a-1', pid: 4242, binary: 'node', label: 'claude-code' };

describe('extractSelector', () => {
  test.each([
    ['browser.click', { selector: '#submit' }, '#submit'],
    ['browser.type', { selector: '#search' }, '#search'],
    ['browser.press', { selector: '#form' }, '#form'],
    ['browser.wait_for', { selector: '.done' }, '.done'],
    // snapshot's selector argument has a different NAME — the table exists
    // precisely so this does not have to be remembered at 30 call sites.
    ['browser.snapshot', { within_selector: 'main' }, 'main'],
  ])('%s → %s', (tool, args, expected) => {
    expect(extractSelector(tool, args)).toBe(expected);
  });

  test('tools with no selector argument record none', () => {
    expect(extractSelector('browser.list_tabs', {})).toBeNull();
    expect(extractSelector('browser.evaluate', { expression: '1' })).toBeNull();
  });

  test('an empty string is not a selector', () => {
    expect(extractSelector('browser.click', { selector: '' })).toBeNull();
  });
});

describe('extractPayload', () => {
  test.each([
    ['browser.navigate', { url: 'https://x.com' }, 'https://x.com'],
    ['browser.type', { text: 'hunter2' }, 'hunter2'],
    ['browser.find', { text: 'Save' }, 'Save'],
    ['browser.evaluate', { expression: 'document.title' }, 'document.title'],
    ['browser.press', { key: 'Enter' }, 'Enter'],
  ])('%s carries its substance', (tool, args, expected) => {
    expect(extractPayload(tool, args)).toBe(expected);
  });

  test('knobs are not payloads — a snapshot cap would only add noise', () => {
    expect(extractPayload('browser.snapshot', { max_interactive: 50 })).toBeNull();
  });

  test('a flow is summarised by its step kinds, not inlined whole', () => {
    const steps = [{ find: {} }, { click: {} }, { type: {} }];
    expect(extractPayload('browser.flow', { steps })).toBe('3 steps: find → click → type');
  });

  test('a flow with unreadable steps still reports its length', () => {
    expect(extractPayload('browser.flow', { steps: [1, 2] })).toBe('2 steps');
  });

  test('a flow with no steps array records nothing rather than lying', () => {
    expect(extractPayload('browser.flow', {})).toBeNull();
  });
});

describe('screenshot trail', () => {
  test('records the element selector as the selector', () => {
    expect(extractSelector('browser.screenshot', { selector: '#card' })).toBe('#card');
  });
});

describe('transportFor', () => {
  test('cdp: ids are the cdp-direct transport', () => {
    expect(transportFor('cdp:TARGET-1')).toBe('cdp');
  });
  test('everything else reached the page through the extension', () => {
    expect(transportFor('tab_1')).toBe('extension');
  });
  test('a tabless tool records no transport rather than guessing', () => {
    expect(transportFor(null)).toBeNull();
  });
});

describe('agentNameFor', () => {
  test('prefers the self-declared label', () => {
    expect(agentNameFor(caller)).toBe('claude-code');
  });
  test('falls back to the binary when unlabelled', () => {
    expect(agentNameFor({ agent_id: 'a', pid: 1, binary: 'opencode' })).toBe('opencode');
  });
  test('an empty label does not shadow the binary', () => {
    expect(agentNameFor({ agent_id: 'a', pid: 1, binary: 'node', label: '' })).toBe('node');
  });
  test('no caller, no agent', () => {
    expect(agentNameFor(undefined)).toBeNull();
  });
});

describe('extractTabId / extractFlowId', () => {
  test('read their arguments when present', () => {
    expect(extractTabId({ tab_id: 'tab_3' })).toBe('tab_3');
    expect(extractFlowId({ flow_id: 'flow_9' })).toBe('flow_9');
  });
  test('tolerate junk arguments without throwing', () => {
    expect(extractTabId(null)).toBeNull();
    expect(extractTabId('nonsense')).toBeNull();
    expect(extractFlowId(42)).toBeNull();
  });
});

describe('buildRow', () => {
  test('assembles a success row', () => {
    const row = buildRow({
      tool: 'browser.click',
      args: { tab_id: 'tab_1', selector: '#go' },
      caller,
      durationMs: 40,
      recordPayloads: true,
    });
    expect(row).toMatchObject({
      tool: 'browser.click',
      tabId: 'tab_1',
      transport: 'extension',
      selector: '#go',
      agent: 'claude-code',
      agentPid: 4242,
      outcome: 'ok',
      error: null,
      durationMs: 40,
    });
  });

  test('an error row keeps the message, not a stack', () => {
    const row = buildRow({
      tool: 'browser.click',
      args: { tab_id: 'tab_1' },
      caller,
      durationMs: 3,
      error: new Error('Element covered by .modal'),
      recordPayloads: true,
    });
    expect(row.outcome).toBe('error');
    expect(row.error).toBe('Element covered by .modal');
  });

  test('a non-Error throw is still describable', () => {
    const row = buildRow({
      tool: 'browser.click',
      args: {},
      caller,
      durationMs: 1,
      error: 'plain string',
      recordPayloads: true,
    });
    expect(row.error).toBe('plain string');
  });

  test('recordPayloads:false keeps the shape and drops only the text', () => {
    const row = buildRow({
      tool: 'browser.type',
      args: { tab_id: 'tab_1', selector: '#pw', text: 'hunter2' },
      caller,
      durationMs: 5,
      recordPayloads: false,
    });
    expect(row.payload).toBeNull();
    // Everything that makes the row auditable survives.
    expect(row.selector).toBe('#pw');
    expect(row.tool).toBe('browser.type');
    expect(row.agent).toBe('claude-code');
  });
});

/**
 * The decorator contract. These exercise `handleBrowserTool` itself rather
 * than the extractor, because the guarantee under test is that WRAPPING did
 * not change dispatch: same result, same throw, plus a row.
 */
describe('handleBrowserTool records without changing behaviour', () => {
  function depsWithSink(rows: ActivityInput[]): BrowserToolDeps {
    return {
      listTabs: () => [{ tab_id: 'tab_1', url: 'https://example.com/a', title: 'A' }],
      callBrowserTool: async () => ({ ok: true }),
      recordActivity: (row) => rows.push(row),
    } as unknown as BrowserToolDeps;
  }

  test('a successful call returns its result AND leaves one row', async () => {
    const rows: ActivityInput[] = [];
    const result = await handleBrowserTool('browser.list_tabs', {}, depsWithSink(rows), caller);
    expect(result).toBeDefined();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'browser.list_tabs', outcome: 'ok' });
  });

  test('a THROWN call still rethrows AND leaves an error row', async () => {
    const rows: ActivityInput[] = [];
    await expect(
      handleBrowserTool('browser.definitely_not_a_tool', {}, depsWithSink(rows), caller),
    ).rejects.toThrow();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('error');
  });

  test('the row is stamped with the tab URL, which only the dispatcher can see', async () => {
    const rows: ActivityInput[] = [];
    await handleBrowserTool('browser.list_tabs', { tab_id: 'tab_1' }, depsWithSink(rows), caller);
    expect(rows[0].url).toBe('https://example.com/a');
    expect(rows[0].title).toBe('A');
  });

  test('a throwing sink cannot break the call it is observing', async () => {
    const deps = {
      listTabs: () => [],
      recordActivity: () => {
        throw new Error('disk on fire');
      },
    } as unknown as BrowserToolDeps;
    await expect(handleBrowserTool('browser.list_tabs', {}, deps, caller)).resolves.toBeDefined();
  });

  test('with no sink wired, dispatch is untouched', async () => {
    const deps = { listTabs: () => [] } as unknown as BrowserToolDeps;
    await expect(handleBrowserTool('browser.list_tabs', {}, deps, caller)).resolves.toBeDefined();
  });
});

/** A resolved MCP tool response, exactly as `dispatchBrowserTool` returns it. */
function mcp(data: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

describe('classifyFlag — thrown errors', () => {
  test.each([
    [
      'Click would land on div.scroller, not on #go: scroll or expand its container, or target the element that receives clicks; force: true clicks there anyway',
      'retargeted',
    ],
    ['retargeted: click would land on an ancestor', 'retargeted'],
    ['ref-stale: e12 not found in document d3', 'ref-stale'],
    ['expectation not met: url_changed after 3000ms', 'expect-failed'],
    ["Tool 'browser.click' timed out after 30000ms", 'timeout'],
  ])('%s → %s', (message, flag) => {
    expect(classifyFlag('browser.click', {}, undefined, new Error(message))).toBe(flag);
  });

  test('an error that matches no rule carries no flag', () => {
    expect(classifyFlag('browser.click', {}, undefined, new Error('tab_id required'))).toBeNull();
  });

  test('an isError response is classified by its text like a throw', () => {
    const response = {
      content: [{ type: 'text', text: 'Error: expectation not met: text_appears after 2000ms' }],
      isError: true,
    };
    expect(classifyFlag('browser.click', {}, response, undefined)).toBe('expect-failed');
  });
});

describe('classifyFlag — resolved results', () => {
  test('wait_for matched:false → unmatched', () => {
    expect(classifyFlag('browser.wait_for', {}, mcp({ matched: false }), undefined)).toBe(
      'unmatched',
    );
  });

  test('find not-found → not-found', () => {
    expect(
      classifyFlag('browser.find', {}, mcp({ matched: false, reason: 'not-found' }), undefined),
    ).toBe('not-found');
  });

  test('find multiple-matches → multiple-matches', () => {
    expect(
      classifyFlag(
        'browser.find',
        {},
        mcp({ matched: false, reason: 'multiple-matches', candidates: [] }),
        undefined,
      ),
    ).toBe('multiple-matches');
  });

  test('flow stopped_by timeout → flow-timeout', () => {
    expect(
      classifyFlag(
        'browser.flow',
        {},
        mcp({ ok: true, stopped_by: 'timeout', steps_completed: 3 }),
        undefined,
      ),
    ).toBe('flow-timeout');
  });

  test.each(['timeout', 'interrupted'])('download state %s → download-timeout', (state) => {
    expect(classifyFlag('browser.download', {}, mcp({ state }), undefined)).toBe(
      'download-timeout',
    );
  });

  test('settle.settled false → unsettled', () => {
    expect(
      classifyFlag(
        'browser.click',
        {},
        mcp({ ok: true, settle: { settled: false, mutation_count: 40 } }),
        undefined,
      ),
    ).toBe('unsettled');
  });

  test('hit_element on a resolved click → hit-mismatch (only reported outside the target)', () => {
    expect(
      classifyFlag('browser.click', {}, mcp({ ok: true, hit_element: 'div.overlay' }), undefined),
    ).toBe('hit-mismatch');
  });

  test('a raw (unwrapped) result object is classified too', () => {
    expect(classifyFlag('browser.wait_for', {}, { matched: false }, undefined)).toBe('unmatched');
  });

  test('a clean result carries no flag', () => {
    expect(
      classifyFlag(
        'browser.click',
        {},
        mcp({ ok: true, settle: { settled: true, mutation_count: 2 } }),
        undefined,
      ),
    ).toBeNull();
    expect(classifyFlag('browser.find', {}, mcp({ matched: true }), undefined)).toBeNull();
  });

  test('unparseable or irrelevant results carry no flag and never throw', () => {
    expect(
      classifyFlag('browser.click', {}, { content: [{ type: 'text', text: '{nope' }] }, undefined),
    ).toBeNull();
    expect(classifyFlag('browser.list_tabs', {}, mcp([]), undefined)).toBeNull();
    expect(classifyFlag('browser.click', {}, null, undefined)).toBeNull();
  });
});

describe('buildActivityRow', () => {
  test('stores the flag from the result and the agent id', () => {
    const row = buildActivityRow(
      { tab_id: 'tab_1', selector: '.done' },
      {
        tool: 'browser.wait_for',
        caller,
        durationMs: 9,
        recordPayloads: true,
        result: mcp({ matched: false }),
        agentId: 'ipc-uuid-1',
      },
    );
    expect(row).toMatchObject({
      tool: 'browser.wait_for',
      selector: '.done',
      outcome: 'ok',
      flag: 'unmatched',
      agentId: 'ipc-uuid-1',
    });
  });

  test('stores the flag from a thrown error', () => {
    const row = buildActivityRow(
      { tab_id: 'tab_1', selector: '#go' },
      {
        tool: 'browser.click',
        caller,
        durationMs: 9,
        recordPayloads: true,
        error: new Error('ref-stale: e1 not found in document d1'),
      },
    );
    expect(row.outcome).toBe('error');
    expect(row.flag).toBe('ref-stale');
  });

  test("the agent id defaults to 'primary'", () => {
    const row = buildActivityRow(
      {},
      { tool: 'browser.list_tabs', caller, durationMs: 1, recordPayloads: true, agentId: null },
    );
    expect(row.agentId).toBe('primary');
  });

  test('the previous meta shape builds the same row as before, plus the defaults', () => {
    const args = { tab_id: 'tab_1', selector: '#pw', text: 'hunter2' };
    const meta = { tool: 'browser.type', caller, durationMs: 5, recordPayloads: true };
    const legacy = buildRow({ ...meta, args });
    const row = buildActivityRow(args, meta);
    expect(row).toEqual({ ...legacy, flag: null, agentId: 'primary' });
    expect(row).toMatchObject({
      tool: 'browser.type',
      tabId: 'tab_1',
      transport: 'extension',
      selector: '#pw',
      payload: 'hunter2',
      agent: 'claude-code',
      agentPid: 4242,
      outcome: 'ok',
      error: null,
      durationMs: 5,
      flowId: null,
    });
  });
});
