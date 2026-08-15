import { describe, expect, test } from 'vitest';
import {
  agentNameFor,
  buildRow,
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
