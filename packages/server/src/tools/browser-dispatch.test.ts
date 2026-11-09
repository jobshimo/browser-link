import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeActivityDb, getActivityDb } from '../activity/db.js';
import { record as recordActivityRow } from '../activity/queries.js';
import { listFeedback } from '../activity/feedback.js';
import { closeDb as closeMapDb, getDb as getMapDb } from '../map/db.js';
import { listFlows, resolveLearnerApp, saveFlow } from '../map/queries.js';
import {
  clearTypedValues,
  getReader,
  rememberTypedValue,
  setReaderStatus,
  setReaderTemplate,
  upsertReader,
} from '../map/readers.js';
import { notePendingWork, peekSession, resetSessions } from '../map/session.js';
import {
  type BrowserToolDeps,
  handleBrowserTool,
  isBrowserTool,
  outdatedServerHint,
  validateFlowSteps,
} from './browser-dispatch.js';
import { VERSION } from '../version.js';
import { saveConfig } from '../config.js';
import { BridgeEventLog } from '../bridge/events.js';
import { TabClaimRegistry, type AgentCaller } from './tab-claims.js';
import { BROWSER_TOOL_DEFINITIONS } from './browser-definitions.js';

function makeDeps(overrides: Partial<BrowserToolDeps> = {}): BrowserToolDeps {
  return {
    listTabs: vi.fn(() => []),
    callBrowserTool: vi.fn(async () => undefined),
    ...overrides,
  };
}

const TEST_CALLER: AgentCaller = {
  agent_id: 'test-caller',
  pid: 0,
  binary: 'node',
};

describe('isBrowserTool', () => {
  test('recognises every browser.* tool we ship', () => {
    for (const name of [
      'browser.list_tabs',
      'browser.ping',
      'browser.navigate',
      'browser.snapshot',
      'browser.find',
      'browser.state',
      'browser.canvas_screenshot',
      'browser.screenshot',
      'browser.click',
      'browser.type',
      'browser.press',
      'browser.drag',
      'browser.flow',
      'browser.flow_status',
      'browser.flow_cancel',
      'browser.evaluate',
      'browser.console',
      'browser.network',
      'browser.network_body',
      'browser.wait_for',
      'browser.wait_for_tab',
      'browser.dialog_respond',
      'browser.set_permission',
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
    const out = await handleBrowserTool('browser.list_tabs', {}, deps, TEST_CALLER);
    expect(deps.listTabs).toHaveBeenCalledOnce();
    expect(out).toEqual([
      {
        tab_id: 'tab_1',
        url: 'http://x',
        title: 't',
        claimed_by: null,
        claimed_by_me: false,
      },
    ]);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('ping forwards the tab_id to the bridge', async () => {
    const deps = makeDeps({ callBrowserTool: vi.fn(async () => ({ ok: true })) });
    await handleBrowserTool('browser.ping', { tab_id: 'tab_1' }, deps, TEST_CALLER);
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'ping', {});
  });

  test('navigate defaults wait_for_load to true and uses the long timeout', async () => {
    const deps = makeDeps({ callBrowserTool: vi.fn(async () => undefined) });
    await handleBrowserTool(
      'browser.navigate',
      { tab_id: 'tab_1', url: 'http://example.com' },
      deps,
      TEST_CALLER,
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
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'type',
      {
        selector: '#x',
        text: 'hi',
        clear: false,
        settle_ms: undefined,
        settle_timeout_ms: undefined,
      },
      expect.any(Number),
    );
  });

  test('type forwards settle_ms / settle_timeout_ms and computes the bridge timeout from them', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.type',
      { tab_id: 'tab_1', selector: '#x', text: 'hi', settle_ms: 300, settle_timeout_ms: 4000 },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'type',
      expect.objectContaining({ settle_ms: 300, settle_timeout_ms: 4000 }),
      // With today's constants this equals the 15s floor for every legal
      // settle_timeout_ms (max 10s + 5s overhead == floor) — the formula is
      // asserted so the budget stays correct if either constant moves.
      Math.max(15_000, 4000 + 5_000),
    );
  });

  test('drag forwards selector endpoints and tunables to the bridge', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.drag',
      {
        tab_id: 'tab_1',
        from_selector: '#a',
        to_selector: '#b',
        duration_ms: 2000,
        hold_before_release_ms: 50,
      },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'drag',
      {
        from_selector: '#a',
        from_x: undefined,
        from_y: undefined,
        to_selector: '#b',
        to_x: undefined,
        to_y: undefined,
        duration_ms: 2000,
        hold_before_move_ms: undefined,
        hold_before_release_ms: 50,
      },
      Math.max(15_000, 2000 + 50 + 10_000),
    );
  });

  test('drag accepts coordinate endpoints when no selector is available', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.drag',
      { tab_id: 'tab_1', from_x: 10, from_y: 20, to_x: 100, to_y: 200 },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'drag',
      expect.objectContaining({ from_x: 10, from_y: 20, to_x: 100, to_y: 200 }),
      expect.any(Number),
    );
  });

  test('wait_for forwards selector mode parameters to the bridge', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.wait_for',
      {
        tab_id: 'tab_1',
        selector: '[data-testid=ready]',
        condition: 'visible',
        timeout_ms: 3000,
        poll_interval_ms: 200,
      },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'wait_for',
      expect.objectContaining({
        selector: '[data-testid=ready]',
        condition: 'visible',
        timeout_ms: 3000,
        poll_interval_ms: 200,
      }),
      // Floor 15s OR timeout + 5s, whichever is greater.
      Math.max(15_000, 3000 + 5_000),
    );
  });

  test('wait_for accepts expression mode', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.wait_for',
      { tab_id: 'tab_1', expression: 'window.__ready === true' },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'wait_for',
      expect.objectContaining({ expression: 'window.__ready === true' }),
      expect.any(Number),
    );
  });

  test('wait_for accepts network_url mode', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.wait_for',
      { tab_id: 'tab_1', network_url: '/api/items' },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'wait_for',
      expect.objectContaining({ network_url: '/api/items' }),
      expect.any(Number),
    );
  });

  test('wait_for rejects when zero or multiple target modes are provided', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool('browser.wait_for', { tab_id: 'tab_1' }, deps, TEST_CALLER),
    ).rejects.toThrow(/exactly one of selector, expression, network_url/);
    await expect(
      handleBrowserTool(
        'browser.wait_for',
        { tab_id: 'tab_1', selector: '#x', expression: 'y' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/exactly one of/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('wait_for rejects an unknown condition value', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.wait_for',
        { tab_id: 'tab_1', selector: '#x', condition: 'bogus' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/condition must be one of visible \| hidden \| attached \| detached/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('wait_for bypasses claim enforcement (read tool)', async () => {
    const deps = makeDepsWithClaims();
    // Another agent claims tab_1
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A);
    // B can still wait_for on it because reads bypass claims
    await handleBrowserTool('browser.wait_for', { tab_id: 'tab_1', selector: '#x' }, deps, B);
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'wait_for',
      expect.objectContaining({ selector: '#x' }),
      expect.any(Number),
    );
  });

  test('wait_for_tab rejects when opened_from is missing', async () => {
    const deps = makeDeps();
    await expect(handleBrowserTool('browser.wait_for_tab', {}, deps, TEST_CALLER)).rejects.toThrow(
      /opened_from required/,
    );
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('wait_for_tab returns events-unavailable when no subscribe hook is wired', async () => {
    const deps = makeDeps();
    const out = await handleBrowserTool(
      'browser.wait_for_tab',
      { opened_from: 'tab_1' },
      deps,
      TEST_CALLER,
    );
    expect(out).toEqual({
      matched: false,
      elapsed_ms: 0,
      reason: 'events-unavailable',
    });
  });

  test('wait_for_tab resolves when a matching tab-created event arrives and auto-claims it', async () => {
    const log = new BridgeEventLog();
    const claims = new TabClaimRegistry({ nowMs: () => 2_000_000 });
    const deps: BrowserToolDeps = {
      listTabs: vi.fn(() => []),
      callBrowserTool: vi.fn(async () => ({ ok: true })),
      subscribeEvents: (fn, options) => log.subscribe(fn, options),
      tabClaims: claims,
    };
    // Fire the tab-created event after the listener is registered.
    setTimeout(() => {
      log.add('tab-created', {
        tab_id: 'tab_99',
        opened_from: 'tab_1',
        url: 'https://example.com/x',
      });
    }, 50);
    const out = (await handleBrowserTool(
      'browser.wait_for_tab',
      { opened_from: 'tab_1', timeout_ms: 2000 },
      deps,
      A,
    )) as { matched: boolean; tab_id?: string; claimed?: boolean };
    expect(out.matched).toBe(true);
    expect(out.tab_id).toBe('tab_99');
    expect(out.claimed).toBe(true);
    expect(claims.getClaim('tab_99')?.agent_id).toBe(A.agent_id);
  });

  test('wait_for_tab replays a tab-created event that landed milliseconds before the call', async () => {
    const log = new BridgeEventLog();
    // Event lands BEFORE wait_for_tab subscribes — the race that look-back / replay solves.
    log.add('tab-created', {
      tab_id: 'tab_99',
      opened_from: 'tab_1',
      url: 'https://example.com/x',
    });
    const claims = new TabClaimRegistry({ nowMs: () => 2_000_000 });
    const deps: BrowserToolDeps = {
      listTabs: vi.fn(() => []),
      callBrowserTool: vi.fn(async () => ({ ok: true })),
      subscribeEvents: (fn, options) => log.subscribe(fn, options),
      tabClaims: claims,
    };
    const out = (await handleBrowserTool(
      'browser.wait_for_tab',
      { opened_from: 'tab_1', timeout_ms: 2000 },
      deps,
      A,
    )) as { matched: boolean; tab_id?: string };
    expect(out.matched).toBe(true);
    expect(out.tab_id).toBe('tab_99');
  });

  test('wait_for_tab times out when no matching event arrives', async () => {
    const log = new BridgeEventLog();
    // Pre-existing unrelated event — should NOT cause a false match.
    log.add('tab-created', {
      tab_id: 'tab_other',
      opened_from: 'tab_OTHER',
      url: 'https://x.com',
    });
    const deps: BrowserToolDeps = {
      listTabs: vi.fn(() => []),
      callBrowserTool: vi.fn(async () => undefined),
      subscribeEvents: (fn, options) => log.subscribe(fn, options),
      tabClaims: new TabClaimRegistry({ nowMs: () => 1_000_000 }),
    };
    const out = (await handleBrowserTool(
      'browser.wait_for_tab',
      { opened_from: 'tab_1', timeout_ms: 200 },
      deps,
      TEST_CALLER,
    )) as { matched: boolean; reason?: string };
    expect(out.matched).toBe(false);
    expect(out.reason).toBe('timeout');
  });

  test('dialog_respond forwards accept/prompt_text to the bridge', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.dialog_respond',
      { tab_id: 'tab_1', accept: true, prompt_text: 'hello' },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'dialog_respond', {
      accept: true,
      prompt_text: 'hello',
    });
  });

  test('dialog_respond rejects when accept is not a boolean', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.dialog_respond',
        { tab_id: 'tab_1', accept: 'yes' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/accept must be a boolean/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('dialog_respond bypasses claim enforcement (frozen tab unblocking)', async () => {
    const deps = makeDepsWithClaims();
    // A holds the claim
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A);
    // B can still respond to a dialog so the tab unfreezes
    await handleBrowserTool('browser.dialog_respond', { tab_id: 'tab_1', accept: false }, deps, B);
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'dialog_respond', {
      accept: false,
      prompt_text: undefined,
    });
  });

  test('set_permission forwards origin/name/state to the bridge', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.set_permission',
      {
        tab_id: 'tab_1',
        origin: 'https://example.com',
        name: 'geolocation',
        state: 'granted',
      },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'set_permission', {
      origin: 'https://example.com',
      name: 'geolocation',
      state: 'granted',
    });
  });

  test('set_permission rejects unknown state', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.set_permission',
        {
          tab_id: 'tab_1',
          origin: 'https://x.com',
          name: 'geolocation',
          state: 'maybe',
        },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/state must be one of granted \| denied \| prompt/);
  });

  test('set_permission rejects when origin or name is missing', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.set_permission',
        { tab_id: 'tab_1', name: 'geolocation', state: 'granted' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/origin required/);
    await expect(
      handleBrowserTool(
        'browser.set_permission',
        { tab_id: 'tab_1', origin: 'https://x.com', state: 'granted' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/name required/);
  });

  test('drag rejects when neither selector nor coords are provided for an endpoint', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool('browser.drag', { tab_id: 'tab_1', to_selector: '#b' }, deps, TEST_CALLER),
    ).rejects.toThrow(/from_selector or both from_x and from_y/);
    await expect(
      handleBrowserTool(
        'browser.drag',
        { tab_id: 'tab_1', from_selector: '#a' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/to_selector or both to_x and to_y/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('rejects when tab_id is missing on a tool that requires it', async () => {
    const deps = makeDeps();
    await expect(handleBrowserTool('browser.ping', {}, deps, TEST_CALLER)).rejects.toThrow(
      /tab_id required/,
    );
  });

  test('throws on unknown tool names', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool('browser.does_not_exist', {}, deps, TEST_CALLER),
    ).rejects.toThrow(/Unknown browser tool/);
  });
});

describe('isBrowserTool recognises the claim/release/my_tabs surface', () => {
  test('every claim-related tool is registered', () => {
    expect(isBrowserTool('browser.claim_tab')).toBe(true);
    expect(isBrowserTool('browser.release_tab')).toBe(true);
    expect(isBrowserTool('browser.my_tabs')).toBe(true);
  });
});

const A: AgentCaller = { agent_id: 'sess-A', pid: 1001, binary: 'node', label: 'claude-code' };
const B: AgentCaller = { agent_id: 'sess-B', pid: 1002, binary: 'node', label: 'opencode' };

function makeDepsWithClaims(): BrowserToolDeps {
  return {
    listTabs: vi.fn(() => [
      { tab_id: 'tab_1', url: 'http://a', title: 'A' },
      { tab_id: 'tab_2', url: 'http://b', title: 'B' },
    ]),
    callBrowserTool: vi.fn(async () => ({ ok: true })),
    tabClaims: new TabClaimRegistry({ nowMs: () => 1_000_000 }),
  };
}

describe('list_tabs enrichment', () => {
  test('returns claimed_by:null and claimed_by_me:false when no claim exists', async () => {
    const deps = makeDepsWithClaims();
    const tabs = (await handleBrowserTool('browser.list_tabs', {}, deps, A)) as Array<{
      tab_id: string;
      claimed_by: unknown;
      claimed_by_me: boolean;
    }>;
    expect(tabs).toHaveLength(2);
    for (const t of tabs) {
      expect(t.claimed_by).toBeNull();
      expect(t.claimed_by_me).toBe(false);
    }
  });

  test('returns claimed_by populated and claimed_by_me=true for the owner', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A);
    const tabs = (await handleBrowserTool('browser.list_tabs', {}, deps, A)) as Array<{
      tab_id: string;
      claimed_by: { agent_id: string; label?: string } | null;
      claimed_by_me: boolean;
    }>;
    const tab1 = tabs.find((t) => t.tab_id === 'tab_1')!;
    expect(tab1.claimed_by).not.toBeNull();
    expect(tab1.claimed_by!.agent_id).toBe('sess-A');
    expect(tab1.claimed_by!.label).toBe('claude-code');
    expect(tab1.claimed_by_me).toBe(true);
  });

  test('claimed_by_me is false when the claim belongs to another agent', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A);
    const tabs = (await handleBrowserTool('browser.list_tabs', {}, deps, B)) as Array<{
      tab_id: string;
      claimed_by_me: boolean;
    }>;
    expect(tabs.find((t) => t.tab_id === 'tab_1')!.claimed_by_me).toBe(false);
  });
});

describe('list_tabs — map hint enrichment (v0.20.0)', () => {
  test('omits the map field entirely when getMapHints is not wired up', async () => {
    const deps = makeDeps({
      listTabs: vi.fn(() => [{ tab_id: 'tab_1', url: 'http://a', title: 'A' }]),
    });
    const tabs = (await handleBrowserTool('browser.list_tabs', {}, deps, TEST_CALLER)) as Array<
      Record<string, unknown>
    >;
    expect(tabs[0]).not.toHaveProperty('map');
  });

  test('omits the map field when getMapHints returns nothing for the tab origin', async () => {
    const deps = makeDeps({
      listTabs: vi.fn(() => [{ tab_id: 'tab_1', url: 'http://a', title: 'A' }]),
      getMapHints: vi.fn(() => new Map()),
    });
    const tabs = (await handleBrowserTool('browser.list_tabs', {}, deps, TEST_CALLER)) as Array<
      Record<string, unknown>
    >;
    expect(tabs[0]).not.toHaveProperty('map');
  });

  test('attaches the map field when getMapHints has data for the tab origin', async () => {
    const getMapHints = vi.fn(
      () => new Map([['http://a', { app_key: 'my-app', entries: 3, flows: 1 }]]),
    );
    const deps = makeDeps({
      listTabs: vi.fn(() => [
        { tab_id: 'tab_1', url: 'http://a/page', title: 'A' },
        { tab_id: 'tab_2', url: 'http://b/page', title: 'B' },
      ]),
      getMapHints,
    });
    const tabs = (await handleBrowserTool('browser.list_tabs', {}, deps, TEST_CALLER)) as Array<
      Record<string, unknown>
    >;
    expect(tabs.find((t) => t.tab_id === 'tab_1')).toMatchObject({
      map: { app_key: 'my-app', entries: 3, flows: 1 },
    });
    expect(tabs.find((t) => t.tab_id === 'tab_2')).not.toHaveProperty('map');
    // Called ONCE with every DISTINCT ORIGIN (scheme://host:port, not the
    // full URL with path) — the batching this field exists to prove.
    expect(getMapHints).toHaveBeenCalledTimes(1);
    expect(getMapHints).toHaveBeenCalledWith(['http://a', 'http://b']);
  });

  test('resolves hints for every distinct origin in one call, regardless of tab count', async () => {
    const getMapHints = vi.fn(
      () => new Map([['http://a', { app_key: 'my-app', entries: 1, flows: 0 }]]),
    );
    const deps = makeDeps({
      listTabs: vi.fn(() => [
        { tab_id: 'tab_1', url: 'http://a/one', title: 'A1' },
        { tab_id: 'tab_2', url: 'http://a/two', title: 'A2' },
        { tab_id: 'tab_3', url: 'http://a/three', title: 'A3' },
      ]),
      getMapHints,
    });
    const tabs = (await handleBrowserTool('browser.list_tabs', {}, deps, TEST_CALLER)) as Array<
      Record<string, unknown>
    >;
    expect(getMapHints).toHaveBeenCalledTimes(1);
    expect(getMapHints).toHaveBeenCalledWith(['http://a']);
    for (const tab of tabs) {
      expect(tab).toMatchObject({ map: { app_key: 'my-app', entries: 1, flows: 0 } });
    }
  });

  test('never throws and just omits map for a tab whose url does not parse', async () => {
    const deps = makeDeps({
      listTabs: vi.fn(() => [{ tab_id: 'tab_1', url: '', title: 'blank' }]),
      getMapHints: vi.fn(() => new Map([['http://a', { app_key: 'x', entries: 1, flows: 0 }]])),
    });
    const tabs = (await handleBrowserTool('browser.list_tabs', {}, deps, TEST_CALLER)) as Array<
      Record<string, unknown>
    >;
    expect(tabs[0]).not.toHaveProperty('map');
  });
});

describe('claim_tab / release_tab / my_tabs', () => {
  test('claim_tab returns the new claim with created=true', async () => {
    const deps = makeDepsWithClaims();
    const out = (await handleBrowserTool(
      'browser.claim_tab',
      { tab_id: 'tab_1', label: 'override' },
      deps,
      A,
    )) as { ok: true; created: boolean; claim: { agent_id: string; label?: string } };
    expect(out.ok).toBe(true);
    expect(out.created).toBe(true);
    expect(out.claim.agent_id).toBe('sess-A');
    expect(out.claim.label).toBe('override');
  });

  test('claim_tab on a held tab reports conflict and exposes the existing claim', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A);
    const out = (await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, B)) as {
      ok: false;
      reason: string;
      existing: { agent_id: string };
    };
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('conflict');
    expect(out.existing.agent_id).toBe('sess-A');
  });

  test('release_tab succeeds for the owner and refuses non-owners', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A);
    const refused = (await handleBrowserTool(
      'browser.release_tab',
      { tab_id: 'tab_1' },
      deps,
      B,
    )) as { ok: false; reason: string };
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('not-owner');

    const released = (await handleBrowserTool(
      'browser.release_tab',
      { tab_id: 'tab_1' },
      deps,
      A,
    )) as { ok: true };
    expect(released.ok).toBe(true);
  });

  test('my_tabs lists only the caller’s claims', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A);
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_2' }, deps, B);
    const mine = (await handleBrowserTool('browser.my_tabs', {}, deps, A)) as {
      claims: Array<{ tab_id: string }>;
    };
    expect(mine.claims.map((c) => c.tab_id)).toEqual(['tab_1']);
  });

  test('when no registry is wired, claim returns unsupported and release/my_tabs degrade gracefully', async () => {
    const deps: BrowserToolDeps = {
      listTabs: vi.fn(() => []),
      callBrowserTool: vi.fn(async () => undefined),
    };
    const claim = (await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A)) as {
      ok: false;
      reason: string;
    };
    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe('unsupported');
    const release = (await handleBrowserTool(
      'browser.release_tab',
      { tab_id: 'tab_1' },
      deps,
      A,
    )) as { ok: true };
    expect(release.ok).toBe(true);
    const mine = (await handleBrowserTool('browser.my_tabs', {}, deps, A)) as {
      claims: unknown[];
    };
    expect(mine.claims).toEqual([]);
  });
});

describe('action-tool claim enforcement', () => {
  test('click auto-claims a free tab for the caller', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.click', { tab_id: 'tab_1', selector: '#go' }, deps, A);
    expect(deps.tabClaims!.getClaim('tab_1')?.agent_id).toBe('sess-A');
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'click',
      {
        selector: '#go',
        force: false,
        settle_ms: undefined,
        settle_timeout_ms: undefined,
      },
      expect.any(Number),
    );
  });

  test('click forwards force:true when the caller opts out of the occlusion guard', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool(
      'browser.click',
      { tab_id: 'tab_1', selector: '#go', force: true },
      deps,
      A,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'click',
      expect.objectContaining({ selector: '#go', force: true }),
      expect.any(Number),
    );
  });

  test('click forwards settle_ms / settle_timeout_ms and computes the bridge timeout from them', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool(
      'browser.click',
      { tab_id: 'tab_1', selector: '#go', settle_ms: 500, settle_timeout_ms: 8000 },
      deps,
      A,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'click',
      expect.objectContaining({ settle_ms: 500, settle_timeout_ms: 8000 }),
      // Equals the 15s floor with today's constants — see the invariant
      // note on actionTimeoutWithSettle.
      Math.max(15_000, 8000 + 5_000),
    );
  });

  test('click timeout floors at 15s even when settle_timeout_ms is small or absent', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.click', { tab_id: 'tab_1', selector: '#go' }, deps, A);
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'click', expect.any(Object), 15_000);
  });

  test('click clamps settle_timeout_ms above the 10s ceiling before computing the bridge timeout', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool(
      'browser.click',
      { tab_id: 'tab_1', selector: '#go', settle_timeout_ms: 999_999 },
      deps,
      A,
    );
    // Clamped to 10_000 before the +5_000 overhead is added — NOT
    // Math.max(15_000, 999_999 + 5_000).
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'click', expect.any(Object), 15_000);
  });

  describe('expect', () => {
    const EXPECT = { url_changed: true, selector_appears: '#done', timeout_ms: 4000 };

    test('click forwards expect to the extension and leaves the 15s floor for a short window', async () => {
      const deps = makeDepsWithClaims();
      await handleBrowserTool(
        'browser.click',
        { tab_id: 'tab_1', selector: '#go', expect: EXPECT },
        deps,
        A,
      );
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'click',
        expect.objectContaining({ expect: EXPECT }),
        // default settle 2s + 4s expect + 5s overhead = 11s -> floor
        15_000,
      );
    });

    test('the bridge timeout covers the worst-case settle PLUS the expect window', async () => {
      const deps = makeDepsWithClaims();
      await handleBrowserTool(
        'browser.click',
        {
          tab_id: 'tab_1',
          selector: '#go',
          settle_timeout_ms: 10_000,
          expect: { url_changed: true, timeout_ms: 10_000 },
        },
        deps,
        A,
      );
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'click',
        expect.any(Object),
        10_000 + 10_000 + 5_000,
      );
    });

    test('type and press forward expect too', async () => {
      const deps = makeDeps();
      await handleBrowserTool(
        'browser.type',
        { tab_id: 'tab_1', selector: '#x', text: 'hi', expect: { text_appears: 'hi' } },
        deps,
        TEST_CALLER,
      );
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'type',
        expect.objectContaining({ expect: { text_appears: 'hi' } }),
        expect.any(Number),
      );
      await handleBrowserTool(
        'browser.press',
        { tab_id: 'tab_1', key: 'Enter', expect: { selector_disappears: '.modal' } },
        deps,
        TEST_CALLER,
      );
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'press',
        expect.objectContaining({ expect: { selector_disappears: '.modal' } }),
        expect.any(Number),
      );
    });

    test.each([
      ['a non-object', 'nope', /expect must be an object/],
      ['an array', [], /expect must be an object/],
      ['an empty object', {}, /at least one of url_changed \| selector_appears/],
      ['only url_changed:false', { url_changed: false }, /at least one of/],
      [
        'a non-boolean url_changed',
        { url_changed: 'yes' },
        /expect\.url_changed must be a boolean/,
      ],
      [
        'an empty selector',
        { selector_appears: '' },
        /expect\.selector_appears must be a non-empty string/,
      ],
      [
        'a numeric selector_disappears',
        { selector_disappears: 3 },
        /expect\.selector_disappears must be a non-empty string/,
      ],
      [
        'a non-string text_appears',
        { text_appears: false },
        /expect\.text_appears must be a non-empty string/,
      ],
      [
        'a zero timeout',
        { url_changed: true, timeout_ms: 0 },
        /expect\.timeout_ms must be a number between 1 and 10000/,
      ],
      [
        'an oversized timeout',
        { url_changed: true, timeout_ms: 10_001 },
        /expect\.timeout_ms must be a number between 1 and 10000/,
      ],
      ['an unknown key', { url_changed: true, bogus: 1 }, /expect\.bogus is not a known key/],
    ])('click rejects %s without calling the bridge', async (_label, bad, message) => {
      const deps = makeDepsWithClaims();
      await expect(
        handleBrowserTool(
          'browser.click',
          { tab_id: 'tab_1', selector: '#go', expect: bad },
          deps,
          A,
        ),
      ).rejects.toThrow(message);
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    });

    test('press and type reject a malformed expect with their own prefix', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.press',
          { tab_id: 'tab_1', key: 'Enter', expect: {} },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(/^browser\.press: expect/);
      await expect(
        handleBrowserTool(
          'browser.type',
          { tab_id: 'tab_1', selector: '#x', text: 'a', expect: 5 },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(/^browser\.type: expect/);
    });
  });

  test('click is rejected when another agent already owns the tab, and the bridge is never called', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A);
    (deps.callBrowserTool as ReturnType<typeof vi.fn>).mockClear();
    await expect(
      handleBrowserTool('browser.click', { tab_id: 'tab_1', selector: '#go' }, deps, B),
    ).rejects.toThrow(/in use by another agent/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('snapshot (read) bypasses claim enforcement', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A);
    await handleBrowserTool('browser.snapshot', { tab_id: 'tab_1' }, deps, B);
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'snapshot', {});
  });

  test('drag auto-claims a free tab and is rejected when another agent owns it', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool(
      'browser.drag',
      { tab_id: 'tab_1', from_selector: '#a', to_selector: '#b' },
      deps,
      A,
    );
    expect(deps.tabClaims!.getClaim('tab_1')?.agent_id).toBe('sess-A');

    (deps.callBrowserTool as ReturnType<typeof vi.fn>).mockClear();
    await expect(
      handleBrowserTool(
        'browser.drag',
        { tab_id: 'tab_1', from_selector: '#a', to_selector: '#b' },
        deps,
        B,
      ),
    ).rejects.toThrow(/in use by another agent/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('snapshot forwards filter args verbatim to the bridge', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.snapshot',
      {
        tab_id: 'tab_1',
        within_selector: 'main',
        only_interactive: true,
        exclude: ['nav', 'footer'],
        max_interactive: 50,
      },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'snapshot', {
      within_selector: 'main',
      only_interactive: true,
      exclude: ['nav', 'footer'],
      max_interactive: 50,
    });
  });

  test('snapshot drops non-string entries from exclude defensively', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.snapshot',
      { tab_id: 'tab_1', exclude: ['nav', 42, null, 'footer'] },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'snapshot',
      expect.objectContaining({ exclude: ['nav', 'footer'] }),
    );
  });

  test('snapshot forwards a string since to the bridge', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.snapshot',
      { tab_id: 'tab_1', since: 's3', max_interactive: 20 },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'snapshot',
      expect.objectContaining({ since: 's3', max_interactive: 20 }),
    );
  });

  test('snapshot drops a non-string or over-long since defensively, like exclude entries', async () => {
    for (const since of [42, null, { id: 's1' }, 's'.repeat(65)]) {
      const deps = makeDeps();
      await handleBrowserTool('browser.snapshot', { tab_id: 'tab_1', since }, deps, TEST_CALLER);
      const forwarded = (deps.callBrowserTool as ReturnType<typeof vi.fn>).mock
        .calls[0][2] as Record<string, unknown>;
      expect(forwarded.since).toBeUndefined();
    }
    const deps = makeDeps();
    const atLimit = 's'.repeat(64);
    await handleBrowserTool(
      'browser.snapshot',
      { tab_id: 'tab_1', since: atLimit },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'snapshot',
      expect.objectContaining({ since: atLimit }),
    );
  });
  test('snapshot with no args forwards undefined filters (legacy call site)', async () => {
    const deps = makeDeps();
    await handleBrowserTool('browser.snapshot', { tab_id: 'tab_1' }, deps, TEST_CALLER);
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'snapshot', {
      within_selector: undefined,
      only_interactive: undefined,
      exclude: undefined,
      max_interactive: undefined,
    });
  });

  test('find forwards text + role + exact to the bridge', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.find',
      { tab_id: 'tab_1', text: 'Save changes', role: 'button', exact: true },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'find', {
      text: 'Save changes',
      role: 'button',
      exact: true,
    });
  });

  test('find defaults exact to false and omits role when absent', async () => {
    const deps = makeDeps();
    await handleBrowserTool('browser.find', { tab_id: 'tab_1', text: 'Cancel' }, deps, TEST_CALLER);
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'find', {
      text: 'Cancel',
      role: undefined,
      exact: false,
    });
  });

  test('find rejects empty or missing text without hitting the bridge', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool('browser.find', { tab_id: 'tab_1' }, deps, TEST_CALLER),
    ).rejects.toThrow(/text required/);
    await expect(
      handleBrowserTool('browser.find', { tab_id: 'tab_1', text: '' }, deps, TEST_CALLER),
    ).rejects.toThrow(/text required/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('find rejects an unknown role value', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.find',
        { tab_id: 'tab_1', text: 'Save', role: 'banana' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/role must be one of/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('state forwards to the bridge with no params beyond tab_id', async () => {
    const deps = makeDeps();
    await handleBrowserTool('browser.state', { tab_id: 'tab_1' }, deps, TEST_CALLER);
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'state', {});
  });

  test('state bypasses claim enforcement (read tool — multiple agents can read state)', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A);
    await handleBrowserTool('browser.state', { tab_id: 'tab_1' }, deps, B);
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'state', {});
  });

  test('canvas_screenshot forwards selector + region + format when provided', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.canvas_screenshot',
      {
        tab_id: 'tab_1',
        selector: '#qtcanvas',
        region: { x: 0, y: 0, w: 320, h: 240 },
        format: 'jpeg',
      },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'canvas_screenshot', {
      selector: '#qtcanvas',
      region: { x: 0, y: 0, w: 320, h: 240 },
      format: 'jpeg',
    });
  });

  test('canvas_screenshot omits optional fields when absent', async () => {
    const deps = makeDeps();
    await handleBrowserTool('browser.canvas_screenshot', { tab_id: 'tab_1' }, deps, TEST_CALLER);
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'canvas_screenshot', {
      selector: undefined,
      region: undefined,
      format: undefined,
    });
  });

  test('canvas_screenshot rejects non-string selector', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.canvas_screenshot',
        { tab_id: 'tab_1', selector: 42 },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/selector must be a string/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('canvas_screenshot rejects an unknown format value', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.canvas_screenshot',
        { tab_id: 'tab_1', format: 'webp' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/format must be "png" or "jpeg"/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('canvas_screenshot rejects region with missing fields', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.canvas_screenshot',
        { tab_id: 'tab_1', region: { x: 0, y: 0, w: 10 } },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/region\.h must be a finite number/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('canvas_screenshot rejects region with non-positive width or height', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.canvas_screenshot',
        { tab_id: 'tab_1', region: { x: 0, y: 0, w: 0, h: 100 } },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/region\.w and region\.h must be > 0/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('canvas_screenshot bypasses claim enforcement (read tool — multiple agents can capture the same tab)', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A);
    // B can still capture even though A holds the claim.
    await handleBrowserTool('browser.canvas_screenshot', { tab_id: 'tab_1' }, deps, B);
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'canvas_screenshot',
      expect.any(Object),
    );
  });

  test('screenshot defaults to viewport / png and forwards only set fields', async () => {
    const deps = makeDeps();
    await handleBrowserTool('browser.screenshot', { tab_id: 'tab_1' }, deps, TEST_CALLER);
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'screenshot',
      {
        mode: 'viewport',
        selector: undefined,
        format: 'png',
        quality: undefined,
        max_dimension: undefined,
      },
      expect.any(Number),
    );
  });

  test('screenshot forwards element mode arguments', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.screenshot',
      {
        tab_id: 'tab_1',
        mode: 'element',
        selector: '#card',
        format: 'jpeg',
        quality: 60,
        max_dimension: 2000,
      },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'screenshot',
      { mode: 'element', selector: '#card', format: 'jpeg', quality: 60, max_dimension: 2000 },
      expect.any(Number),
    );
  });

  test.each([
    [{ mode: 'fullpage' }, /mode must be/],
    [{ mode: 'element' }, /selector is required/],
    [{ mode: 'viewport', selector: '#x' }, /selector is only valid with mode "element"/],
    [{ selector: 5, mode: 'element' }, /selector must be a string/],
    [{ format: 'webp' }, /format must be "png" or "jpeg"/],
    [{ format: 'jpeg', quality: 101 }, /quality must be an integer between 0 and 100/],
    [{ quality: 1.5 }, /quality must be an integer between 0 and 100/],
    [{ max_dimension: 10 }, /max_dimension must be an integer between 100 and 16000/],
    [{ max_dimension: 'big' }, /max_dimension must be an integer between 100 and 16000/],
  ])('screenshot rejects invalid args %j', async (extra, message) => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool('browser.screenshot', { tab_id: 'tab_1', ...extra }, deps, TEST_CALLER),
    ).rejects.toThrow(message);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('screenshot bypasses claim enforcement (read tool)', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A);
    await handleBrowserTool('browser.screenshot', { tab_id: 'tab_1' }, deps, B);
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'screenshot',
      expect.any(Object),
      expect.any(Number),
    );
  });

  test('find bypasses claim enforcement (read tool — multiple agents can search the same tab)', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A);
    // B can still call find on the tab A holds.
    await handleBrowserTool('browser.find', { tab_id: 'tab_1', text: 'Save' }, deps, B);
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'find',
      expect.objectContaining({ text: 'Save' }),
    );
  });
});

describe('browser.press dispatch', () => {
  test('forwards key with modifiers defaulting to an empty array', async () => {
    const deps = makeDeps();
    await handleBrowserTool('browser.press', { tab_id: 'tab_1', key: 'Enter' }, deps, TEST_CALLER);
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'press',
      {
        key: 'Enter',
        modifiers: [],
        selector: undefined,
        settle_ms: undefined,
        settle_timeout_ms: undefined,
      },
      expect.any(Number),
    );
  });

  test('forwards modifiers and selector when provided', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.press',
      { tab_id: 'tab_1', key: 'a', modifiers: ['Control'], selector: '#editor' },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'press',
      expect.objectContaining({
        key: 'a',
        modifiers: ['Control'],
        selector: '#editor',
      }),
      expect.any(Number),
    );
  });

  test('auto-claims a free tab for the caller (action tool)', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.press', { tab_id: 'tab_1', key: 'Enter' }, deps, A);
    expect(deps.tabClaims!.getClaim('tab_1')?.agent_id).toBe('sess-A');
  });

  test('is rejected when another agent already owns the tab, and the bridge is never called', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A);
    (deps.callBrowserTool as ReturnType<typeof vi.fn>).mockClear();
    await expect(
      handleBrowserTool('browser.press', { tab_id: 'tab_1', key: 'Enter' }, deps, B),
    ).rejects.toThrow(/in use by another agent/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('rejects a missing or empty key without hitting the bridge', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool('browser.press', { tab_id: 'tab_1' }, deps, TEST_CALLER),
    ).rejects.toThrow(/key required/);
    await expect(
      handleBrowserTool('browser.press', { tab_id: 'tab_1', key: '' }, deps, TEST_CALLER),
    ).rejects.toThrow(/key required/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('rejects an invalid modifiers entry', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.press',
        { tab_id: 'tab_1', key: 'a', modifiers: ['Banana'] },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/modifiers must be an array of Alt \| Control \| Meta \| Shift/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('rejects modifiers that is not an array', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.press',
        { tab_id: 'tab_1', key: 'a', modifiers: 'Control' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/modifiers must be an array/);
  });

  test('rejects a non-string selector', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.press',
        { tab_id: 'tab_1', key: 'a', selector: 42 },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/selector must be a string/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('forwards settle_ms / settle_timeout_ms and computes the bridge timeout from them', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.press',
      { tab_id: 'tab_1', key: 'Enter', settle_ms: 200, settle_timeout_ms: 6000 },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'press',
      expect.objectContaining({ settle_ms: 200, settle_timeout_ms: 6000 }),
      // Equals the 15s floor with today's constants — see the invariant
      // note on actionTimeoutWithSettle.
      Math.max(15_000, 6000 + 5_000),
    );
  });

  test('timeout floors at 15s when settle_timeout_ms is absent', async () => {
    const deps = makeDeps();
    await handleBrowserTool('browser.press', { tab_id: 'tab_1', key: 'Enter' }, deps, TEST_CALLER);
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'press', expect.any(Object), 15_000);
  });
});

describe('browser.flow dispatch', () => {
  test('forwards a valid steps array unchanged, along with the tab_id', async () => {
    const deps = makeDeps();
    const steps = [
      { find: { text: 'GIF', role: 'button' } },
      { click: {} },
      { wait_for: { selector: '[data-testid=picker]', condition: 'visible' } },
      { type: { text: 'shrek' } },
      { press: { key: 'Enter' } },
    ];
    await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'flow',
      { steps, flow_id: expect.any(String), deadline_ms: expect.any(Number) },
      expect.any(Number),
    );
  });

  test('auto-claims a free tab for the caller (action tool)', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps: [{ press: { key: 'Enter' } }] },
      deps,
      A,
    );
    expect(deps.tabClaims!.getClaim('tab_1')?.agent_id).toBe('sess-A');
  });

  test('is rejected when another agent already owns the tab, and the bridge is never called', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool('browser.claim_tab', { tab_id: 'tab_1' }, deps, A);
    (deps.callBrowserTool as ReturnType<typeof vi.fn>).mockClear();
    await expect(
      handleBrowserTool(
        'browser.flow',
        { tab_id: 'tab_1', steps: [{ press: { key: 'Enter' } }] },
        deps,
        B,
      ),
    ).rejects.toThrow(/in use by another agent/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  describe('validation', () => {
    test('rejects a missing steps array without hitting the bridge', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool('browser.flow', { tab_id: 'tab_1' }, deps, TEST_CALLER),
      ).rejects.toThrow(/steps must be a non-empty array/);
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    });

    test('rejects an empty steps array', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps: [] }, deps, TEST_CALLER),
      ).rejects.toThrow(/steps must be a non-empty array/);
    });

    test('rejects more than 20 steps', async () => {
      const deps = makeDeps();
      const steps = Array.from({ length: 21 }, () => ({ press: { key: 'Enter' } }));
      await expect(
        handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER),
      ).rejects.toThrow(/at most 20 steps allowed, got 21/);
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    });

    test('accepts exactly 20 steps', async () => {
      const deps = makeDeps();
      const steps = Array.from({ length: 20 }, () => ({ press: { key: 'Enter' } }));
      await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        { steps, flow_id: expect.any(String), deadline_ms: expect.any(Number) },
        expect.any(Number),
      );
    });

    test('rejects a step with an unknown kind', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ navigate: { url: 'https://example.com' } }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(
        /must have exactly one of find \| click \| type \| press \| wait_for \| drag/,
      );
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    });

    test('rejects a step naming more than one kind', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ find: { text: 'GIF' }, click: {} }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(
        /must have exactly one of find \| click \| type \| press \| wait_for \| drag/,
      );
    });

    test('rejects a find step with no text', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ find: {} }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(/find.text is required/);
    });

    test('rejects a press step with no key', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ press: {} }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(/press.key is required/);
    });

    test('rejects a type step with no text', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ type: { selector: '#x' } }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(/type.text is required/);
    });

    test('rejects a click step with no selector and no preceding find', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ click: {} }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(/no preceding find to supply an implicit target/);
    });

    test('accepts a click step with no selector when a find precedes it', async () => {
      const deps = makeDeps();
      const steps = [{ find: { text: 'GIF' } }, { click: {} }];
      await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        { steps, flow_id: expect.any(String), deadline_ms: expect.any(Number) },
        expect.any(Number),
      );
    });

    test('accepts a click step with its own explicit selector and no find at all', async () => {
      const deps = makeDeps();
      const steps = [{ click: { selector: '#go' } }];
      await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        { steps, flow_id: expect.any(String), deadline_ms: expect.any(Number) },
        expect.any(Number),
      );
    });

    test('accepts type/press steps with no selector and no preceding find', async () => {
      const deps = makeDeps();
      const steps = [{ type: { text: 'shrek' } }, { press: { key: 'Enter' } }];
      await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        { steps, flow_id: expect.any(String), deadline_ms: expect.any(Number) },
        expect.any(Number),
      );
    });

    test('rejects a step carrying extra unrecognized keys next to a valid kind', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ find: { text: 'GIF' }, mystery: 1 }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(
        /must have exactly one of find \| click \| type \| press \| wait_for \| drag/,
      );
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    });

    test('rejects a find step with an invalid role', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ find: { text: 'GIF', role: 'banana' } }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(
        /find.role must be one of button \| link \| textbox \| checkbox \| tab \| menuitem/,
      );
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    });

    test('rejects an empty wait_for step (no mode at all)', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ wait_for: {} }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(/wait_for requires exactly one of selector \| expression \| network_url/);
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    });

    test('rejects a wait_for step naming more than one mode', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ wait_for: { selector: '#x', expression: '1' } }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(/wait_for requires exactly one of selector \| expression \| network_url/);
    });

    test('rejects a wait_for step with an invalid condition', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ wait_for: { selector: '#x', condition: 'banana' } }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(
        /wait_for.condition must be one of visible \| hidden \| attached \| detached/,
      );
    });

    test('rejects a wait_for step with a non-numeric timeout_ms', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ wait_for: { selector: '#x', timeout_ms: 'fast' } }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(/wait_for.timeout_ms must be a finite number/);
    });

    test('accepts each single wait_for mode: selector, expression, network_url', async () => {
      for (const body of [
        { selector: '#x', condition: 'visible' },
        { expression: 'window.ready === true' },
        { network_url: '/api/search' },
      ]) {
        const deps = makeDeps();
        const steps = [{ wait_for: body }];
        await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
        expect(deps.callBrowserTool).toHaveBeenCalledWith(
          'tab_1',
          'flow',
          { steps, flow_id: expect.any(String), deadline_ms: expect.any(Number) },
          expect.any(Number),
        );
      }
    });

    test('accepts drag steps with selector endpoints, coordinate endpoints, or a mix', async () => {
      for (const body of [
        { from_selector: '#card', to_selector: '#slot' },
        { from_x: 10, from_y: 20, to_x: 300, to_y: 40 },
        { from_selector: '#card', to_x: 300, to_y: 40, duration_ms: 500 },
      ]) {
        const deps = makeDeps();
        const steps = [{ drag: body }];
        await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
        expect(deps.callBrowserTool).toHaveBeenCalledWith(
          'tab_1',
          'flow',
          { steps, flow_id: expect.any(String), deadline_ms: expect.any(Number) },
          expect.any(Number),
        );
      }
    });

    test('rejects a drag step missing its source endpoint (no implicit-target fallback)', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          // A preceding find must NOT rescue the drag — drag stays out of
          // the implicit-target chain, unlike a selector-less click.
          {
            tab_id: 'tab_1',
            steps: [{ find: { text: 'Card' } }, { drag: { to_selector: '#slot' } }],
          },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(/drag requires from_selector or both from_x and from_y/);
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    });

    test('rejects a drag step missing its destination endpoint', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ drag: { from_selector: '#card', to_x: 300 } }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(/drag requires to_selector or both to_x and to_y/);
    });

    test('rejects a drag step with a non-numeric coordinate', async () => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          {
            tab_id: 'tab_1',
            steps: [{ drag: { from_x: 'left', from_y: 20, to_selector: '#slot' } }],
          },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(/drag.from_x must be a finite number/);
    });
  });

  describe('timeout budget', () => {
    // Budget model constants (see browser-dispatch.ts):
    //   base overhead 2_000, per-step slack 500,
    //   settle-enabled action step 2_000 + 500 = 2_500,
    //   settle-disabled action step (settle_ms: 0) 500,
    //   find step 500,
    //   wait_for step min(timeout_ms, 30_000) + 500 (default timeout 5_000).

    test('floors at 15s for a single short step', async () => {
      const deps = makeDeps();
      // 2_000 + 2_500 = 4_500 — below the shared action floor.
      await handleBrowserTool(
        'browser.flow',
        { tab_id: 'tab_1', steps: [{ press: { key: 'Enter' } }] },
        deps,
        TEST_CALLER,
      );
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        expect.any(Object),
        15_000,
      );
    });

    test('a find + 3 action steps still sits under the floor', async () => {
      const deps = makeDeps();
      // 2_000 + 500 + 3 * 2_500 = 10_000 → floored to 15_000.
      await handleBrowserTool(
        'browser.flow',
        {
          tab_id: 'tab_1',
          steps: [
            { find: { text: 'GIF' } },
            { click: {} },
            { type: { text: 'shrek' } },
            { press: { key: 'Enter' } },
          ],
        },
        deps,
        TEST_CALLER,
      );
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        expect.any(Object),
        15_000,
      );
    });

    test('an action step with expect adds its expect window to the budget', async () => {
      const deps = makeDeps();
      // 2_000 + 4 * (2_000 + 500 + 10_000) = 52_000 — the expect window is
      // charged in full, like a wait_for, because an unmet expectation
      // spends all of it.
      const steps = Array.from({ length: 4 }, () => ({
        click: { selector: '#next', expect: { url_changed: true, timeout_ms: 10_000 } },
      }));
      await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        expect.any(Object),
        52_000,
      );
    });

    test('REJECTS up front a flow whose expect windows push the budget past the ceiling', async () => {
      const deps = makeDeps();
      const steps = Array.from({ length: 5 }, () => ({
        click: { selector: '#next', expect: { url_changed: true, timeout_ms: 10_000 } },
      }));
      await expect(
        handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER),
      ).rejects.toThrow(/worst-case budget 65s exceeds the 60s ceiling/);
    });

    test('default expect window (3s) is charged when timeout_ms is omitted', async () => {
      const deps = makeDeps();
      // 2_000 + (2_000 + 500 + 3_000) = 7_500 -> floored
      await handleBrowserTool(
        'browser.flow',
        {
          tab_id: 'tab_1',
          steps: Array.from({ length: 8 }, () => ({
            press: { key: 'a', expect: { text_appears: 'x' } },
          })),
        },
        deps,
        TEST_CALLER,
      );
      // 2_000 + 8 * 5_500 = 46_000
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        expect.any(Object),
        46_000,
      );
    });

    test.each([
      ['click', { selector: '#a', expect: {} }],
      ['type', { text: 'a', expect: { url_changed: 'x' } }],
      ['press', { key: 'a', expect: { timeout_ms: 5, url_changed: true, extra: 1 } }],
    ])('a malformed expect on a %s step is rejected with the step index', async (kind, body) => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ press: { key: 'Tab' } }, { [kind]: body }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(new RegExp(`step 1: ${kind}\\.expect`));
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    });

    test('wait_for steps contribute their own timeout_ms + slack to the sum', async () => {
      const deps = makeDeps();
      // 2_000 + 5 * (10_000 + 500) = 54_500 — the enforced timeout IS the
      // truthful worst case, not a capped substitute for it.
      const steps = Array.from({ length: 5 }, () => ({
        wait_for: { selector: '#x', timeout_ms: 10_000 },
      }));
      await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        expect.any(Object),
        54_500,
      );
    });

    test('a full 20-step flow of action steps with DEFAULT settle fits under the ceiling', async () => {
      const deps = makeDeps();
      // 2_000 + 20 * 2_500 = 52_000 ≤ 60_000 — the documented "up to 20
      // steps" promise holds with default settle; the rejection only bites
      // genuinely long wait_for-heavy flows.
      const steps = Array.from({ length: 20 }, () => ({ press: { key: 'Enter' } }));
      await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        expect.any(Object),
        52_000,
      );
    });

    test('settle_ms:0 action steps cost only the per-step slack', async () => {
      const deps = makeDeps();
      // 2_000 + 20 * 500 = 12_000 → floored to 15_000.
      const steps = Array.from({ length: 20 }, () => ({
        press: { key: 'Enter', settle_ms: 0 },
      }));
      await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        expect.any(Object),
        15_000,
      );
    });

    test('REJECTS a flow whose truthful worst case exceeds the 60s ceiling (two 30s waits)', async () => {
      const deps = makeDeps();
      // 2_000 + 2 * (30_000 + 500) = 63_000 > 60_000. Silently enforcing a
      // 60s bridge timeout here would drop the response of a flow the
      // extension is still executing — an agent retry could then duplicate
      // the actions. Reject up front instead.
      const steps = Array.from({ length: 2 }, () => ({
        wait_for: { selector: '#x', timeout_ms: 30_000 },
      }));
      await expect(
        handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER),
      ).rejects.toThrow(/worst-case budget 63s exceeds the 60s ceiling/);
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    });

    test('REJECTS a full 20-step flow of long waits with the computed budget in the error', async () => {
      const deps = makeDeps();
      // 2_000 + 20 * 30_500 = 612_000 — far over the ceiling.
      const steps = Array.from({ length: 20 }, () => ({
        wait_for: { selector: '#x', timeout_ms: 30_000 },
      }));
      await expect(
        handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER),
      ).rejects.toThrow(
        /worst-case budget 612s exceeds the 60s ceiling — run it with detach: true \(its own budget, up to 30 minutes\), reduce wait_for timeout_ms or sleep\.ms values, or split the flow/,
      );
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    });

    test('a sleep step contributes its FULL ms to the budget, plus slack', async () => {
      const deps = makeDeps();
      // 2_000 + (10_000 + 500) = 12_500 → floored to the 15s action floor.
      // Unlike a wait_for timeout (a ceiling it usually returns under), a
      // sleep is always spent in full, so the budget charges all of it.
      const steps = [{ sleep: { ms: 10_000 } }];
      await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        expect.any(Object),
        15_000,
      );
    });

    test('sleep steps push a flow over the ceiling and get it rejected up front', async () => {
      const deps = makeDeps();
      // 2_000 + 2 * (30_000 + 500) = 63_000 > 60_000 — same arithmetic the
      // two-30s-waits case proves, reached through sleeps instead.
      const steps = [{ sleep: { ms: 30_000 } }, { sleep: { ms: 30_000 } }];
      await expect(
        handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER),
      ).rejects.toThrow(/worst-case budget 63s exceeds the 60s ceiling/);
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    });

    test('accepts sleep.ms at the inclusive 30000 boundary', async () => {
      const deps = makeDeps();
      // Boundary proof lives here rather than in runFlow's suite: this path
      // validates without actually sleeping for 30 seconds.
      await handleBrowserTool(
        'browser.flow',
        { tab_id: 'tab_1', steps: [{ sleep: { ms: 30_000 } }] },
        deps,
        TEST_CALLER,
      );
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        expect.any(Object),
        32_500,
      );
    });

    test.each([
      ['zero', 0],
      ['negative', -1],
      ['non-integer', 12.5],
      ['over the ceiling', 30_001],
    ])('REJECTS sleep.ms %s before dispatching anything', async (_label, ms) => {
      const deps = makeDeps();
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ sleep: { ms } }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(/step 0: sleep\.ms must be an integer between 1 and 30000/);
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    });

    test('a sleep step does not satisfy a later selector-less click', async () => {
      const deps = makeDeps();
      // sleep names no element, so it can never supply an implicit target.
      await expect(
        handleBrowserTool(
          'browser.flow',
          { tab_id: 'tab_1', steps: [{ sleep: { ms: 10 } }, { click: {} }] },
          deps,
          TEST_CALLER,
        ),
      ).rejects.toThrow(/step 1: click has no selector and no preceding find/);
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    });

    test('a drag step contributes its duration_ms plus holds to the sum', async () => {
      const deps = makeDeps();
      // 2_000 + (20_000 + 5_000 + 5_000 + 500) = 32_500 — the drag's own
      // movement/hold budget is modeled truthfully, not settle-based.
      const steps = [
        {
          drag: {
            from_selector: '#card',
            to_selector: '#slot',
            duration_ms: 20_000,
            hold_before_move_ms: 5_000,
            hold_before_release_ms: 5_000,
          },
        },
      ];
      await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        expect.any(Object),
        32_500,
      );
    });

    test('a default drag step costs 1_500 + slack and sits under the floor', async () => {
      const deps = makeDeps();
      // 2_000 + (1_500 + 500) = 4_000 → floored to 15_000.
      const steps = [{ drag: { from_selector: '#card', to_selector: '#slot' } }];
      await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        expect.any(Object),
        15_000,
      );
    });

    test('a drag hold above the 10s extension cap is clamped before summing', async () => {
      const deps = makeDeps();
      // 2_000 + (1_500 + min(999_999, 10_000) + 500) = 14_000 → floored to
      // 15_000 — NOT rejected, and NOT 999_999-based.
      const steps = [
        { drag: { from_selector: '#a', to_selector: '#b', hold_before_release_ms: 999_999 } },
      ];
      await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        expect.any(Object),
        15_000,
      );
    });

    test('REJECTS a flow of long drags whose truthful worst case exceeds the ceiling', async () => {
      const deps = makeDeps();
      // 2_000 + 2 * (40_000 + 500) = 83_000 > 60_000.
      const steps = Array.from({ length: 2 }, () => ({
        drag: { from_selector: '#a', to_selector: '#b', duration_ms: 40_000 },
      }));
      await expect(
        handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER),
      ).rejects.toThrow(/worst-case budget 83s exceeds the 60s ceiling/);
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    });

    test('a wait_for timeout_ms above 30s is clamped before summing', async () => {
      const deps = makeDeps();
      await handleBrowserTool(
        'browser.flow',
        { tab_id: 'tab_1', steps: [{ wait_for: { selector: '#x', timeout_ms: 999_999 } }] },
        deps,
        TEST_CALLER,
      );
      // Clamped to 30_000 (the extension enforces the same cap) + 500 slack
      // + 2_000 base = 32_500 — NOT rejected, and NOT 999_999-based.
      expect(deps.callBrowserTool).toHaveBeenCalledWith(
        'tab_1',
        'flow',
        expect.any(Object),
        32_500,
      );
    });
  });
});

describe('browser.flow schema shape', () => {
  const def = BROWSER_TOOL_DEFINITIONS.find((d) => d.name === 'browser.flow');

  test('requires tab_id; steps or a saved flow name (knowledge-loop S11)', () => {
    expect(def).toBeDefined();
    const schema = def!.inputSchema as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['tab_id']);
    expect(schema.properties.name).toBeDefined();
    expect(schema.properties.values).toBeDefined();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.tab_id).toBeDefined();
    expect(schema.properties.steps).toBeDefined();
  });

  test('steps is an array capped at 20 items, each a oneOf of the 8 step kinds', () => {
    const stepsSchema = (
      def!.inputSchema as {
        properties: { steps: { type: string; minItems: number; maxItems: number; items: unknown } };
      }
    ).properties.steps;
    expect(stepsSchema.type).toBe('array');
    expect(stepsSchema.minItems).toBe(1);
    expect(stepsSchema.maxItems).toBe(20);
    const oneOf = (stepsSchema.items as { oneOf: { required: string[] }[] }).oneOf;
    expect(oneOf).toHaveLength(8);
    expect(oneOf.map((v) => v.required[0]).sort()).toEqual([
      'click',
      'drag',
      'find',
      'press',
      'repeat',
      'sleep',
      'type',
      'wait_for',
    ]);
  });

  test('the sleep variant declares the 1..30000 integer bound in the schema itself', () => {
    // The bound is enforced three times over — MCP schema, validateFlowSteps,
    // and runFlow — because the IPC/proxy path in multi-agent mode reaches
    // the dispatcher without schema validation. This asserts the first one.
    const oneOf = (
      def!.inputSchema as {
        properties: { steps: { items: { oneOf: Record<string, unknown>[] } } };
      }
    ).properties.steps.items.oneOf;
    const sleepVariant = oneOf.find((v) => (v.required as string[])[0] === 'sleep');
    expect(sleepVariant).toBeDefined();
    const ms = (
      sleepVariant!.properties as {
        sleep: { properties: { ms: { type: string; minimum: number; maximum: number } } };
      }
    ).sleep.properties.ms;
    expect(ms.type).toBe('integer');
    expect(ms.minimum).toBe(1);
    expect(ms.maximum).toBe(30000);
  });

  test('every step variant declares additionalProperties:false at both levels', () => {
    const oneOf = (
      def!.inputSchema as {
        properties: { steps: { items: { oneOf: Record<string, unknown>[] } } };
      }
    ).properties.steps.items.oneOf;
    for (const variant of oneOf) {
      expect(variant.additionalProperties).toBe(false);
      const key = (variant.required as unknown as string[])[0];
      const body = (variant.properties as Record<string, { additionalProperties: boolean }>)[key];
      expect(body.additionalProperties).toBe(false);
    }
  });

  test('has a doc block teaching the find-then-implicit-target pattern', () => {
    expect(def!.doc).toBeDefined();
    expect(def!.doc!.example).toContain('find');
    expect(def!.doc!.example).toContain('press');
    expect(def!.description).toMatch(/implicit target/i);
  });

  test('the wait_for variant enforces exactly one mode via oneOf required combos', () => {
    const oneOf = (
      def!.inputSchema as {
        properties: { steps: { items: { oneOf: Record<string, unknown>[] } } };
      }
    ).properties.steps.items.oneOf;
    const waitVariant = oneOf.find((v) => (v.required as string[])[0] === 'wait_for')!;
    const body = (waitVariant.properties as Record<string, { oneOf?: { required: string[] }[] }>)
      .wait_for;
    expect(body.oneOf).toBeDefined();
    expect(body.oneOf!.map((c) => c.required[0]).sort()).toEqual([
      'expression',
      'network_url',
      'ref',
      'selector',
    ]);
  });
});

describe('browser.evaluate dispatch', () => {
  test('forwards the expression with NO timeout arg when timeout_ms is omitted — bridge default unchanged', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.evaluate',
      { tab_id: 'tab_1', expression: '1+1' },
      deps,
      TEST_CALLER,
    );
    // Exactly three args — the bridge's own default (15s) applies, the
    // byte-identical pre-timeout_ms call shape.
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'evaluate', { expression: '1+1' });
  });

  test('timeout_ms above the floor is forwarded as the bridge budget', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.evaluate',
      { tab_id: 'tab_1', expression: 'walkSlides()', timeout_ms: 30_000 },
      deps,
      TEST_CALLER,
    );
    // The timeout is a bridge-side budget only — the wire params stay
    // { expression }, nothing new travels to the extension.
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'evaluate',
      { expression: 'walkSlides()' },
      30_000,
    );
  });

  test('timeout_ms clamps to the 60s parking ceiling', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.evaluate',
      { tab_id: 'tab_1', expression: 'x', timeout_ms: 999_999 },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'evaluate',
      { expression: 'x' },
      60_000,
    );
  });

  test('timeout_ms below the 15s action floor behaves like the default (widen-only)', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.evaluate',
      { tab_id: 'tab_1', expression: 'x', timeout_ms: 500 },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'evaluate',
      { expression: 'x' },
      15_000,
    );
  });

  test('a non-finite timeout_ms falls back to the omitted-arg call shape', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.evaluate',
      { tab_id: 'tab_1', expression: 'x', timeout_ms: Number.NaN },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'evaluate', { expression: 'x' });
  });

  test('timeout_ms reaches callCdpTool for a cdp: tab', async () => {
    const callCdpTool = vi.fn(async () => 42);
    const deps = makeDeps({ cdpGate: () => ({ ok: true as const }), callCdpTool });
    await handleBrowserTool(
      'browser.evaluate',
      { tab_id: 'cdp:ABC', expression: '6*7', timeout_ms: 45_000 },
      deps,
      TEST_CALLER,
    );
    expect(callCdpTool).toHaveBeenCalledWith('cdp:ABC', 'evaluate', { expression: '6*7' }, 45_000);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });
});

describe('browser.evaluate schema shape', () => {
  const def = BROWSER_TOOL_DEFINITIONS.find((d) => d.name === 'browser.evaluate');

  test('timeout_ms is an optional number — tab_id and expression stay the only required properties', () => {
    expect(def).toBeDefined();
    const schema = def!.inputSchema as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { type?: string }>;
    };
    expect(schema.required).toEqual(['tab_id', 'expression']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.timeout_ms?.type).toBe('number');
  });

  test('documents the default and the cap where an agent reading the schema sees them', () => {
    expect(def!.description).toContain('15000');
    expect(def!.description).toContain('60000');
  });
});

describe('cdp-direct routing', () => {
  const OK_GATE = { ok: true as const };
  const FAIL_GATE = {
    ok: false as const,
    error:
      'cdp-direct is disabled. The user can enable it with: browser-link config set cdp-direct.enabled true',
  };

  test('an extension tab_id never touches callCdpTool/cdpGate — byte-equivalent path', async () => {
    const cdpGate = vi.fn(() => OK_GATE);
    const callCdpTool = vi.fn(async () => ({ ok: true }));
    const deps = makeDeps({ cdpGate, callCdpTool });
    await handleBrowserTool('browser.ping', { tab_id: 'tab_1' }, deps, TEST_CALLER);
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'ping', {});
    expect(callCdpTool).not.toHaveBeenCalled();
    expect(cdpGate).not.toHaveBeenCalled();
  });

  test('a supported tool on a cdp: tab routes to callCdpTool, not callBrowserTool', async () => {
    const callCdpTool = vi.fn(async () => ({ title: 't', url: 'https://x' }));
    const deps = makeDeps({ cdpGate: () => OK_GATE, callCdpTool });
    const out = await handleBrowserTool('browser.ping', { tab_id: 'cdp:ABC' }, deps, TEST_CALLER);
    expect(callCdpTool).toHaveBeenCalledWith('cdp:ABC', 'ping', {});
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
    expect(out).toEqual({ title: 't', url: 'https://x' });
  });

  test('click on a cdp: tab routes through the claim registry AND callCdpTool', async () => {
    const callCdpTool = vi.fn(async () => ({ clicked: '#a', tag: 'button' }));
    const tabClaims = new TabClaimRegistry({ onEvent: () => {} });
    const deps = makeDeps({ cdpGate: () => OK_GATE, callCdpTool, tabClaims });
    await handleBrowserTool(
      'browser.click',
      { tab_id: 'cdp:ABC', selector: '#a' },
      deps,
      TEST_CALLER,
    );
    expect(callCdpTool).toHaveBeenCalledWith(
      'cdp:ABC',
      'click',
      expect.objectContaining({ selector: '#a' }),
      expect.any(Number),
    );
    expect(tabClaims.getClaim('cdp:ABC')?.agent_id).toBe(TEST_CALLER.agent_id);
  });

  test('a cdp: tab surfaces the exact gate error and never reaches callCdpTool', async () => {
    const callCdpTool = vi.fn(async () => ({}));
    const deps = makeDeps({ cdpGate: () => FAIL_GATE, callCdpTool });
    await expect(
      handleBrowserTool('browser.ping', { tab_id: 'cdp:ABC' }, deps, TEST_CALLER),
    ).rejects.toThrow(FAIL_GATE.error);
    expect(callCdpTool).not.toHaveBeenCalled();
  });

  test('no cdpGate wired at all treats every cdp: tab as unreachable', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool('browser.ping', { tab_id: 'cdp:ABC' }, deps, TEST_CALLER),
    ).rejects.toThrow(/cdp-direct is not available/i);
  });

  test('an out-of-v1-scope tool on a cdp: tab is rejected before callCdpTool runs', async () => {
    const callCdpTool = vi.fn(async () => ({}));
    const deps = makeDeps({ cdpGate: () => OK_GATE, callCdpTool });
    await expect(
      handleBrowserTool(
        'browser.drag',
        { tab_id: 'cdp:ABC', to_x: 1, to_y: 1, from_x: 0, from_y: 0 },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/browser.drag is not supported over cdp-direct/i);
    expect(callCdpTool).not.toHaveBeenCalled();
  });

  test('browser.console on a cdp: tab is rejected the same way', async () => {
    const deps = makeDeps({ cdpGate: () => OK_GATE, callCdpTool: vi.fn(async () => ({})) });
    await expect(
      handleBrowserTool('browser.console', { tab_id: 'cdp:ABC' }, deps, TEST_CALLER),
    ).rejects.toThrow(/browser.console is not supported over cdp-direct/i);
  });

  test('list_tabs merges deps.listCdpTabs() results after extension tabs', async () => {
    const deps = makeDeps({
      listTabs: vi.fn(() => [{ tab_id: 'tab_1', url: 'https://ext.example', title: 'ext' }]),
      listCdpTabs: vi.fn(async () => [
        { tab_id: 'cdp:XYZ', url: 'https://cdp.example', title: 'cdp', transport: 'cdp' as const },
      ]),
    });
    const out = await handleBrowserTool('browser.list_tabs', {}, deps, TEST_CALLER);
    expect(out).toEqual([
      {
        tab_id: 'tab_1',
        url: 'https://ext.example',
        title: 'ext',
        claimed_by: null,
        claimed_by_me: false,
      },
      {
        tab_id: 'cdp:XYZ',
        url: 'https://cdp.example',
        title: 'cdp',
        transport: 'cdp',
        claimed_by: null,
        claimed_by_me: false,
      },
    ]);
  });

  test('list_tabs without listCdpTabs wired behaves exactly as before (no transport key anywhere)', async () => {
    const deps = makeDeps({
      listTabs: vi.fn(() => [{ tab_id: 'tab_1', url: 'https://ext.example', title: 'ext' }]),
    });
    const out = await handleBrowserTool('browser.list_tabs', {}, deps, TEST_CALLER);
    expect(out).toEqual([
      {
        tab_id: 'tab_1',
        url: 'https://ext.example',
        title: 'ext',
        claimed_by: null,
        claimed_by_me: false,
      },
    ]);
  });

  test('wait_for_tab gates on a cdp: opened_from before touching subscribeEvents', async () => {
    const subscribeEvents = vi.fn();
    const deps = makeDeps({ cdpGate: () => FAIL_GATE, subscribeEvents });
    await expect(
      handleBrowserTool('browser.wait_for_tab', { opened_from: 'cdp:ABC' }, deps, TEST_CALLER),
    ).rejects.toThrow(FAIL_GATE.error);
    expect(subscribeEvents).not.toHaveBeenCalled();
  });

  test('wait_for_tab on a granted cdp: opened_from reports the v1 limitation', async () => {
    const subscribeEvents = vi.fn();
    const deps = makeDeps({ cdpGate: () => OK_GATE, subscribeEvents });
    await expect(
      handleBrowserTool('browser.wait_for_tab', { opened_from: 'cdp:ABC' }, deps, TEST_CALLER),
    ).rejects.toThrow(/browser.wait_for_tab is not supported over cdp-direct/i);
    expect(subscribeEvents).not.toHaveBeenCalled();
  });

  test('wait_for_tab on an extension opened_from is unaffected by cdp-direct', async () => {
    const deps = makeDeps({
      cdpGate: () => FAIL_GATE,
      subscribeEvents: vi.fn(() => () => {}),
    });
    // Should not throw the cdp gate error — it should proceed to the normal
    // subscribe/timeout path (resolved via the timeout since no event fires).
    const result = (await handleBrowserTool(
      'browser.wait_for_tab',
      { opened_from: 'tab_1', timeout_ms: 10 },
      deps,
      TEST_CALLER,
    )) as { matched: boolean; reason?: string };
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('timeout');
  });
});

describe('browser.flow repeat validation + budget', () => {
  test('budget is max_iterations x (inner steps + delay), base overhead charged once', async () => {
    const deps = makeDeps();
    // inner click = settle 2_000 + slack 500 = 2_500.
    // per iteration = 2_500 + delay 250 = 2_750.
    // total = base 2_000 + 10 * 2_750 = 29_500.
    const steps = [
      {
        repeat: {
          steps: [{ click: { selector: '#row button' } }],
          max_iterations: 10,
          delay_ms: 250,
        },
      },
    ];
    await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'flow', expect.any(Object), 29_500);
  });

  test('a while_found condition adds its own probe round trip per iteration', async () => {
    const deps = makeDeps();
    // Same as above plus 500ms of probe slack per iteration:
    // per iteration = 2_500 + 250 + 500 = 3_250 → 2_000 + 10 * 3_250 = 34_500.
    const steps = [
      {
        repeat: {
          steps: [{ click: { selector: '#row button' } }],
          max_iterations: 10,
          delay_ms: 250,
          while_found: '.row',
        },
      },
    ];
    await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'flow', expect.any(Object), 34_500);
  });

  test('REJECTS a repeat whose projected worst case blows the 60s ceiling', async () => {
    const deps = makeDeps();
    // The whole safety argument for shipping repeat before cancellation:
    // max_iterations is mandatory, so the worst case stays computable and
    // the existing up-front rejection still bounds every flow.
    const steps = [{ repeat: { steps: [{ click: { selector: '#row' } }], max_iterations: 100 } }];
    await expect(
      handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER),
    ).rejects.toThrow(/worst-case budget \d+s exceeds the 60s ceiling/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('REJECTS a nested repeat', async () => {
    const deps = makeDeps();
    const steps = [
      {
        repeat: {
          steps: [{ repeat: { steps: [{ press: { key: 'a' } }], max_iterations: 2 } }],
          max_iterations: 2,
        },
      },
    ];
    await expect(
      handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER),
    ).rejects.toThrow(/nesting is not supported/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('inner steps count toward the same 20-step ceiling as outer ones', async () => {
    const deps = makeDeps();
    const steps = [
      { press: { key: 'a', settle_ms: 0 } },
      {
        repeat: {
          steps: Array.from({ length: 20 }, () => ({ press: { key: 'b', settle_ms: 0 } })),
          max_iterations: 1,
        },
      },
    ];
    await expect(
      handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER),
    ).rejects.toThrow(/at most 20 steps allowed \(a repeat's inner steps count too\), got 22/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', undefined],
    ['zero', 0],
    ['non-integer', 2.5],
    ['over the 500 cap', 501],
  ])('REJECTS repeat.max_iterations %s', async (_label, max) => {
    const deps = makeDeps();
    const steps = [{ repeat: { steps: [{ press: { key: 'a' } }], max_iterations: max } }];
    await expect(
      handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER),
    ).rejects.toThrow(/repeat\.max_iterations is required/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('REJECTS an out-of-range repeat.delay_ms', async () => {
    const deps = makeDeps();
    const steps = [
      { repeat: { steps: [{ press: { key: 'a' } }], max_iterations: 2, delay_ms: 30_001 } },
    ];
    await expect(
      handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER),
    ).rejects.toThrow(/repeat\.delay_ms must be an integer between 0 and 30000/);
  });

  test('inner steps get the identical per-kind rules (a bad inner sleep is caught)', async () => {
    const deps = makeDeps();
    const steps = [{ repeat: { steps: [{ sleep: { ms: 0 } }], max_iterations: 2 } }];
    await expect(
      handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER),
    ).rejects.toThrow(/repeat\.steps → step 0: sleep\.ms must be an integer/);
  });

  test('a repeat does not supply an implicit target to a later outer click', async () => {
    const deps = makeDeps();
    const steps = [
      { repeat: { steps: [{ find: { text: 'Row' } }], max_iterations: 2 } },
      { click: {} },
    ];
    await expect(
      handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER),
    ).rejects.toThrow(/step 1: click has no selector and no preceding find/);
  });
});

describe('browser.flow dry_run', () => {
  test('forwards dry_run:true and uses the plain action floor, not the work budget', async () => {
    const deps = makeDeps();
    const steps = [
      { repeat: { steps: [{ click: { selector: '#row' } }], max_iterations: 10, delay_ms: 250 } },
    ];
    await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps, dry_run: true },
      deps,
      TEST_CALLER,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith(
      'tab_1',
      'flow',
      expect.objectContaining({ dry_run: true }),
      15_000,
    );
  });

  test.each([
    ['omitted', undefined],
    ['the string "true"', 'true'],
    ['1', 1],
    ['false', false],
  ])('does NOT enter dry-run mode when dry_run is %s', async (_label, value) => {
    const deps = makeDeps();
    const steps = [{ press: { key: 'a', settle_ms: 0 } }];
    const args: Record<string, unknown> = { tab_id: 'tab_1', steps };
    if (value !== undefined) args.dry_run = value;
    await handleBrowserTool('browser.flow', args, deps, TEST_CALLER);
    const sent = deps.callBrowserTool.mock.calls[0][2] as Record<string, unknown>;
    // A dry run that silently became a real run would be the worst
    // possible failure of this flag — only the exact boolean opts in.
    expect(sent.dry_run).toBeUndefined();
  });
});

describe('browser.flow repeat — the iteration ceilings the docs promise', () => {
  // These lock the exact numbers published in the README table, DECISIONS
  // §13 and the agent-instructions BULK WORK section. v0.25.0 shipped a
  // claim of "~200 iterations per call" that was wrong by 4x; documented
  // arithmetic must be executable so it cannot drift again.
  const body = (settleZero: boolean) => ({
    click: { selector: '#row', ...(settleZero ? { settle_ms: 0 } : {}) },
  });
  const repeatStep = (max: number, settleZero: boolean, throttled: boolean) => [
    {
      repeat: {
        steps: [body(settleZero)],
        max_iterations: max,
        ...(throttled ? { while_found: '.row', delay_ms: 250 } : {}),
      },
    },
  ];

  test.each([
    ['1 click, default settle', 23, 24, false, false],
    ['1 click, settle_ms:0', 116, 117, true, false],
    ['1 click, settle_ms:0 + while_found + delay 250', 46, 47, true, true],
  ])('%s → %i fits, %i is rejected', async (_label, fits, rejected, settleZero, throttled) => {
    const okDeps = makeDeps();
    await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps: repeatStep(fits, settleZero, throttled) },
      okDeps,
      TEST_CALLER,
    );
    expect(okDeps.callBrowserTool).toHaveBeenCalled();

    const badDeps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.flow',
        { tab_id: 'tab_1', steps: repeatStep(rejected, settleZero, throttled) },
        badDeps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/exceeds the 60s ceiling/);
    expect(badDeps.callBrowserTool).not.toHaveBeenCalled();
  });
});

describe('browser.flow identity (flow_id)', () => {
  /** Deps whose flow call answers with a given result, so the dispatcher's
   * own decoration of that result is observable. */
  function makeFlowDeps(result: unknown): BrowserToolDeps {
    const deps = makeDeps();
    (deps.callBrowserTool as ReturnType<typeof vi.fn>).mockResolvedValue(result);
    return deps;
  }

  test('mints an opaque id and forwards it to the transport with the steps', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps: [{ press: { key: 'Enter' } }] },
      deps,
      TEST_CALLER,
    );
    const params = (deps.callBrowserTool as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(typeof params.flow_id).toBe('string');
    expect(params.flow_id.length).toBeGreaterThan(0);
  });

  test('returns the same id on the flow result', async () => {
    const deps = makeFlowDeps({ ok: true, steps_completed: 1, results: [{ ok: true }] });
    const result = (await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps: [{ press: { key: 'Enter' } }] },
      deps,
      TEST_CALLER,
    )) as { flow_id: string; ok: boolean };
    const sent = (deps.callBrowserTool as ReturnType<typeof vi.fn>).mock.calls[0][2];

    expect(result.flow_id).toBe(sent.flow_id);
    // Everything else about the success shape is untouched.
    expect(result).toMatchObject({ ok: true, steps_completed: 1 });
  });

  test('includes the id in the fail-fast error payload too', async () => {
    // The failure payload is exactly when an agent needs to know WHICH run
    // it is looking at.
    const deps = makeFlowDeps({
      ok: false,
      failed_step: 1,
      step_kind: 'click',
      error: 'Element not found: #go',
      steps_completed: 1,
      recovery_snapshot: null,
    });
    const result = (await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps: [{ press: { key: 'Enter' } }, { click: { selector: '#go' } }] },
      deps,
      TEST_CALLER,
    )) as { flow_id: string; ok: boolean; failed_step: number };

    expect(result.ok).toBe(false);
    expect(result.failed_step).toBe(1);
    expect(typeof result.flow_id).toBe('string');
  });

  test('includes the id on a cancelled flow', async () => {
    const deps = makeFlowDeps({
      ok: true,
      stopped_by: 'cancelled',
      steps_completed: 1,
      results: [{ ok: true }],
    });
    const result = (await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps: [{ press: { key: 'a' } }, { press: { key: 'b' } }] },
      deps,
      TEST_CALLER,
    )) as { flow_id: string; stopped_by: string };

    expect(result.stopped_by).toBe('cancelled');
    expect(typeof result.flow_id).toBe('string');
  });

  test('every call gets its own id', async () => {
    const deps = makeDeps();
    const args = { tab_id: 'tab_1', steps: [{ press: { key: 'Enter' } }] };
    await handleBrowserTool('browser.flow', args, deps, TEST_CALLER);
    await handleBrowserTool('browser.flow', args, deps, TEST_CALLER);
    const calls = (deps.callBrowserTool as ReturnType<typeof vi.fn>).mock.calls;

    expect(calls[0][2].flow_id).not.toBe(calls[1][2].flow_id);
  });

  test('a dry run is identified too — the id is per CALL, not per dispatch', async () => {
    const deps = makeFlowDeps({ ok: true, steps_completed: 0, results: [], dry_run: true });
    const result = (await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps: [{ press: { key: 'Enter' } }], dry_run: true },
      deps,
      TEST_CALLER,
    )) as { flow_id: string; dry_run: boolean };

    expect(result.dry_run).toBe(true);
    expect(typeof result.flow_id).toBe('string');
  });

  test('a non-object transport result passes through untouched rather than being wrapped', async () => {
    const deps = makeFlowDeps('unexpected');
    const result = await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps: [{ press: { key: 'Enter' } }] },
      deps,
      TEST_CALLER,
    );
    expect(result).toBe('unexpected');
  });
});

describe('detached execution + the flow lifecycle tools', () => {
  /** A dispatcher whose transport echoes whatever the extension would
   * answer for the ONE call this test makes. */
  function makeFlowDeps(
    result: unknown,
    overrides: Partial<BrowserToolDeps> = {},
  ): BrowserToolDeps {
    const deps = makeDeps(overrides);
    (deps.callBrowserTool as ReturnType<typeof vi.fn>).mockResolvedValue(result);
    return deps;
  }

  const DETACH_ACK = { detached: true, started_at: 1_000, steps: 2, expires_at: 1_801_000 };

  test('detach returns the ack immediately, stamped with the flow_id', async () => {
    const deps = makeFlowDeps(DETACH_ACK);
    const result = (await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps: [{ press: { key: 'Enter' } }], detach: true },
      deps,
      TEST_CALLER,
    )) as { flow_id: string; detached: boolean };

    expect(result.detached).toBe(true);
    expect(result.flow_id).toMatch(/^flow_/);
    // The whole point: nothing waits for the run, so the call is budgeted
    // at the plain action floor rather than at the flow's worst case.
    const [, , params, timeoutMs] = (deps.callBrowserTool as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, Record<string, unknown>, number];
    expect(params.detach).toBe(true);
    expect(params.flow_id).toBe(result.flow_id);
    expect(timeoutMs).toBe(15_000);
  });

  test('detach is opt-in by the exact boolean — anything else runs in the foreground', async () => {
    for (const detach of ['true', 1, {}, null]) {
      const deps = makeFlowDeps({ ok: true, steps_completed: 1, results: [] });
      await handleBrowserTool(
        'browser.flow',
        { tab_id: 'tab_1', steps: [{ press: { key: 'Enter' } }], detach },
        deps,
        TEST_CALLER,
      );
      const params = (deps.callBrowserTool as ReturnType<typeof vi.fn>).mock.calls[0][2] as Record<
        string,
        unknown
      >;
      expect(params.detach).toBeUndefined();
    }
  });

  test('a flow over the 60s ceiling is accepted with detach and still rejected without it', async () => {
    // 2_000 + 20 * 30_500 = 612_000ms — ten minutes, comfortably inside the
    // detached ceiling and ten times over the synchronous one.
    const steps = Array.from({ length: 20 }, () => ({
      wait_for: { selector: '#x', timeout_ms: 30_000 },
    }));

    const rejecting = makeDeps();
    await expect(
      handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, rejecting, TEST_CALLER),
    ).rejects.toThrow(/exceeds the 60s ceiling/);
    expect(rejecting.callBrowserTool).not.toHaveBeenCalled();

    const detaching = makeFlowDeps(DETACH_ACK);
    await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps, detach: true },
      detaching,
      TEST_CALLER,
    );
    expect(detaching.callBrowserTool).toHaveBeenCalledTimes(1);
  });

  test('the detached ceiling is a real ceiling, not an absence of one', async () => {
    // A repeat whose worst case runs past 30 minutes is rejected up front
    // exactly as an over-60s foreground flow is: `max_iterations` stays
    // mandatory precisely so this stays computable.
    const steps = [
      {
        repeat: {
          steps: [{ wait_for: { selector: '#x', timeout_ms: 30_000 } }],
          max_iterations: 100,
        },
      },
    ];
    const deps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.flow',
        { tab_id: 'tab_1', steps, detach: true },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/exceeds the 1800s ceiling — reduce max_iterations/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('dry_run projects a flow that could only run detached, and says so', async () => {
    // The v0.25.0 behaviour rejected this before projecting anything, which
    // made the one question dry_run exists to answer unanswerable for
    // exactly the runs where it matters most.
    const steps = Array.from({ length: 20 }, () => ({
      wait_for: { selector: '#x', timeout_ms: 30_000 },
    }));
    const deps = makeFlowDeps({ ok: true, steps_completed: 0, results: [], dry_run: true });
    const result = (await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps, dry_run: true },
      deps,
      TEST_CALLER,
    )) as { dry_run: boolean; budget_ms: number; requires_detach: boolean };

    expect(result.dry_run).toBe(true);
    expect(result.budget_ms).toBe(612_000);
    expect(result.requires_detach).toBe(true);
    // Still a dry run: the transport is told to project, never to detach.
    const params = (deps.callBrowserTool as ReturnType<typeof vi.fn>).mock.calls[0][2] as Record<
      string,
      unknown
    >;
    expect(params.dry_run).toBe(true);
    expect(params.detach).toBeUndefined();
  });

  test('a flow that fits the 60s cap reports requires_detach:false', async () => {
    const deps = makeFlowDeps({ ok: true, steps_completed: 0, results: [], dry_run: true });
    const result = (await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps: [{ press: { key: 'Enter' } }], dry_run: true },
      deps,
      TEST_CALLER,
    )) as { requires_detach: boolean };
    expect(result.requires_detach).toBe(false);
  });

  test('dry_run wins over detach — projecting is never a background run', async () => {
    const deps = makeFlowDeps({ ok: true, steps_completed: 0, results: [], dry_run: true });
    await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps: [{ press: { key: 'Enter' } }], dry_run: true, detach: true },
      deps,
      TEST_CALLER,
    );
    const params = (deps.callBrowserTool as ReturnType<typeof vi.fn>).mock.calls[0][2] as Record<
      string,
      unknown
    >;
    expect(params.dry_run).toBe(true);
    expect(params.detach).toBeUndefined();
  });

  test('flow_status forwards the id and comes back stamped with flow_id + tab_id', async () => {
    const deps = makeFlowDeps({
      flow_id: 'flow_abc',
      state: 'completed',
      detached: true,
      steps_completed: 3,
      manifest: [{ ok: true }, { ok: true }, { ok: true }],
    });
    const result = (await handleBrowserTool(
      'browser.flow_status',
      { tab_id: 'tab_1', flow_id: 'flow_abc' },
      deps,
      TEST_CALLER,
    )) as { flow_id: string; tab_id: string; state: string; manifest: unknown[] };

    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'flow_status', {
      flow_id: 'flow_abc',
    });
    expect(result.tab_id).toBe('tab_1');
    expect(result.flow_id).toBe('flow_abc');
    expect(result.state).toBe('completed');
    expect(result.manifest).toHaveLength(3);
  });

  test('flow_status is a READ — it never touches the claim registry', async () => {
    const claims = new TabClaimRegistry();
    claims.claim('tab_1', { agent_id: 'someone-else', pid: 1, binary: 'node' });
    const deps = makeFlowDeps(
      { flow_id: 'flow_abc', state: 'running', detached: true },
      { tabClaims: claims },
    );
    await expect(
      handleBrowserTool(
        'browser.flow_status',
        { tab_id: 'tab_1', flow_id: 'flow_abc' },
        deps,
        TEST_CALLER,
      ),
    ).resolves.toBeDefined();
  });

  test('flow_cancel sends the out-of-band cancel frame, then reads the state back', async () => {
    const cancelFlow = vi.fn();
    const deps = makeFlowDeps(
      { flow_id: 'flow_abc', state: 'running', detached: true, cancelling: true },
      { cancelFlow },
    );
    const result = (await handleBrowserTool(
      'browser.flow_cancel',
      { tab_id: 'tab_1', flow_id: 'flow_abc' },
      deps,
      TEST_CALLER,
    )) as { cancel_requested: boolean; state: string; cancelling: boolean; tab_id: string };

    expect(cancelFlow).toHaveBeenCalledWith('tab_1', 'flow_abc');
    // The frame is NOT a tool.request — the only call on that channel is
    // the status read that follows it.
    expect(deps.callBrowserTool).toHaveBeenCalledTimes(1);
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'flow_status', {
      flow_id: 'flow_abc',
    });
    expect(result.cancel_requested).toBe(true);
    expect(result.cancelling).toBe(true);
    expect(result.tab_id).toBe('tab_1');
  });

  test('flow_cancel is NOT claim-guarded — a kill switch cannot need ownership', async () => {
    const claims = new TabClaimRegistry();
    claims.claim('tab_1', { agent_id: 'someone-else', pid: 1, binary: 'node' });
    const cancelFlow = vi.fn();
    const deps = makeFlowDeps(
      { flow_id: 'flow_abc', state: 'cancelled', detached: true },
      { tabClaims: claims, cancelFlow },
    );
    await expect(
      handleBrowserTool(
        'browser.flow_cancel',
        { tab_id: 'tab_1', flow_id: 'flow_abc' },
        deps,
        TEST_CALLER,
      ),
    ).resolves.toMatchObject({ state: 'cancelled', cancel_requested: true });
    expect(cancelFlow).toHaveBeenCalled();
  });

  test('cancelling an unknown id is a clean no-op reported as unknown, never an error', async () => {
    const cancelFlow = vi.fn();
    const deps = makeFlowDeps(
      { flow_id: 'flow_nope', state: 'unknown', detached: false },
      { cancelFlow },
    );
    await expect(
      handleBrowserTool(
        'browser.flow_cancel',
        { tab_id: 'tab_1', flow_id: 'flow_nope' },
        deps,
        TEST_CALLER,
      ),
    ).resolves.toMatchObject({ state: 'unknown', cancel_requested: true });
  });

  test('flow_cancel says so plainly when no cancel channel is wired', async () => {
    const deps = makeFlowDeps({ state: 'running' });
    await expect(
      handleBrowserTool(
        'browser.flow_cancel',
        { tab_id: 'tab_1', flow_id: 'flow_abc' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/extension bridge is not wired/);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('both tools require a flow_id, named per tool', async () => {
    const deps = makeDeps({ cancelFlow: vi.fn() });
    await expect(
      handleBrowserTool('browser.flow_status', { tab_id: 'tab_1' }, deps, TEST_CALLER),
    ).rejects.toThrow('browser.flow_status: flow_id required');
    await expect(
      handleBrowserTool('browser.flow_cancel', { tab_id: 'tab_1', flow_id: '' }, deps, TEST_CALLER),
    ).rejects.toThrow('browser.flow_cancel: flow_id required');
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('on a cdp: tab, flow_cancel goes over the in-process route with no cancel frame', async () => {
    const cancelFlow = vi.fn();
    const callCdpTool = vi.fn().mockResolvedValue({ flow_id: 'flow_abc', state: 'cancelled' });
    const deps = makeDeps({
      cancelFlow,
      callCdpTool,
      cdpGate: () => ({ ok: true }),
    });
    const result = (await handleBrowserTool(
      'browser.flow_cancel',
      { tab_id: 'cdp:TARGET-1', flow_id: 'flow_abc' },
      deps,
      TEST_CALLER,
    )) as { state: string; cancel_requested: boolean; tab_id: string };

    expect(callCdpTool).toHaveBeenCalledWith('cdp:TARGET-1', 'flow_cancel', {
      flow_id: 'flow_abc',
    });
    expect(cancelFlow).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      state: 'cancelled',
      cancel_requested: true,
      tab_id: 'cdp:TARGET-1',
    });
  });

  test('both tools are in v1 cdp-direct scope', async () => {
    const callCdpTool = vi.fn().mockResolvedValue({ state: 'running' });
    const deps = makeDeps({ callCdpTool, cdpGate: () => ({ ok: true }) });
    await expect(
      handleBrowserTool(
        'browser.flow_status',
        { tab_id: 'cdp:TARGET-1', flow_id: 'flow_abc' },
        deps,
        TEST_CALLER,
      ),
    ).resolves.toBeDefined();
    expect(callCdpTool).toHaveBeenCalledWith('cdp:TARGET-1', 'flow_status', {
      flow_id: 'flow_abc',
    });
  });

  test('the cdp-direct gate still guards both — a revoked grant is not a lifecycle bypass', async () => {
    const deps = makeDeps({
      callCdpTool: vi.fn(),
      cdpGate: () => ({ ok: false, error: 'cdp-direct is disabled' }),
      cancelFlow: vi.fn(),
    });
    for (const tool of ['browser.flow_status', 'browser.flow_cancel']) {
      await expect(
        handleBrowserTool(tool, { tab_id: 'cdp:T', flow_id: 'flow_abc' }, deps, TEST_CALLER),
      ).rejects.toThrow('cdp-direct is disabled');
    }
    expect(deps.callCdpTool).not.toHaveBeenCalled();
  });
});

describe('flow lifecycle schema shapes', () => {
  test('flow_status and flow_cancel both require tab_id + flow_id and take nothing else', () => {
    for (const name of ['browser.flow_status', 'browser.flow_cancel']) {
      const def = BROWSER_TOOL_DEFINITIONS.find((d) => d.name === name);
      expect(def, `${name} must be declared`).toBeDefined();
      const schema = def!.inputSchema as {
        required: string[];
        additionalProperties: boolean;
        properties: Record<string, unknown>;
      };
      expect(schema.required).toEqual(['tab_id', 'flow_id']);
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties).sort()).toEqual(['flow_id', 'tab_id']);
    }
  });

  test('browser.flow declares detach as a boolean alongside dry_run', () => {
    const def = BROWSER_TOOL_DEFINITIONS.find((d) => d.name === 'browser.flow');
    const schema = def!.inputSchema as {
      properties: Record<string, { type?: string; description?: string }>;
    };
    expect(schema.properties.detach?.type).toBe('boolean');
    // The one-per-tab rule and the polling handoff are the two things an
    // agent must know before it reaches for this flag; both belong where
    // it reads the schema, not only in the prose.
    expect(schema.properties.detach?.description).toMatch(/ONE detached flow per tab/);
    expect(schema.properties.detach?.description).toMatch(/browser\.flow_status/);
  });
});

describe('browser.download', () => {
  const okFetch = {
    state: 'complete',
    status: 200,
    mime: 'text/csv',
    content_disposition: null,
    final_url: 'https://x.test/files/report.csv',
    bytes: 3,
    data_b64: Buffer.from('a,b').toString('base64'),
  };

  function downloadDeps(overrides: Partial<BrowserToolDeps> = {}) {
    const saveDownload = vi.fn(
      (filename: string, data: Buffer) => `/dl/${filename}:${data.length}`,
    );
    const emitEvent = vi.fn();
    const deps = makeDeps({
      callBrowserTool: vi.fn(async (_tab: string, tool: string) =>
        tool === 'evaluate' ? okFetch : undefined,
      ),
      saveDownload,
      emitEvent,
      ...overrides,
    });
    return { deps, saveDownload, emitEvent };
  }

  test('is a known browser tool with a definition', () => {
    expect(isBrowserTool('browser.download')).toBe(true);
    expect(BROWSER_TOOL_DEFINITIONS.some((d) => d.name === 'browser.download')).toBe(true);
  });

  test('url mode fetches in the page and writes the file through saveDownload', async () => {
    const { deps, saveDownload } = downloadDeps();
    const out = await handleBrowserTool(
      'browser.download',
      { tab_id: 'tab_1', url: 'https://x.test/files/report.csv' },
      deps,
      TEST_CALLER,
    );
    const calls = (deps.callBrowserTool as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('tab_1');
    expect(calls[0][1]).toBe('evaluate');
    expect((calls[0][2] as { expression: string }).expression).toContain(
      JSON.stringify('https://x.test/files/report.csv'),
    );
    expect(saveDownload).toHaveBeenCalledWith('report.csv', Buffer.from('a,b'));
    expect(out).toEqual({
      ok: true,
      state: 'complete',
      path: '/dl/report.csv:3',
      filename: 'report.csv',
      bytes: 3,
      mime: 'text/csv',
      url: 'https://x.test/files/report.csv',
    });
  });

  test('a requested filename wins', async () => {
    const { deps, saveDownload } = downloadDeps();
    await handleBrowserTool(
      'browser.download',
      { tab_id: 'tab_1', url: 'https://x.test/files/report.csv', filename: 'q3.csv' },
      deps,
      TEST_CALLER,
    );
    expect(saveDownload).toHaveBeenCalledWith('q3.csv', expect.any(Buffer));
  });

  test('selector mode captures the download the click starts, then fetches its URL', async () => {
    const callBrowserTool = vi.fn(async (_tab: string, tool: string) => {
      if (tool === 'download') {
        return {
          state: 'captured',
          url: 'https://x.test/export?id=7',
          filename: 'Export 7.xlsx',
          mime: 'application/vnd.ms-excel',
        };
      }
      return { ...okFetch, final_url: 'https://x.test/export?id=7' };
    });
    const { deps, saveDownload } = downloadDeps({ callBrowserTool });
    const out = (await handleBrowserTool(
      'browser.download',
      { tab_id: 'tab_1', selector: '#export', timeout_ms: 5000 },
      deps,
      TEST_CALLER,
    )) as { filename: string; state: string };
    expect(callBrowserTool.mock.calls[0][1]).toBe('download');
    expect(callBrowserTool.mock.calls[0][2]).toEqual({ selector: '#export', timeout_ms: 5000 });
    expect(callBrowserTool.mock.calls[1][1]).toBe('evaluate');
    expect((callBrowserTool.mock.calls[1][2] as { expression: string }).expression).toContain(
      JSON.stringify('https://x.test/export?id=7'),
    );
    expect(saveDownload).toHaveBeenCalledWith('Export 7.xlsx', expect.any(Buffer));
    expect(out.state).toBe('complete');
  });

  test('selector mode with no download within the timeout returns a timeout result, never nothing', async () => {
    const callBrowserTool = vi.fn(async () => ({ state: 'timeout' }));
    const { deps, saveDownload } = downloadDeps({ callBrowserTool });
    const out = await handleBrowserTool(
      'browser.download',
      { tab_id: 'tab_1', selector: '#export', timeout_ms: 1000 },
      deps,
      TEST_CALLER,
    );
    expect(callBrowserTool).toHaveBeenCalledOnce();
    expect(saveDownload).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      ok: false,
      state: 'timeout',
      path: null,
      bytes: 0,
      error: expect.stringMatching(/1000ms/),
    });
  });

  test('a timed-out fetch reports partial bytes', async () => {
    const { deps } = downloadDeps({
      callBrowserTool: vi.fn(async () => ({
        state: 'timeout',
        bytes: 4096,
        mime: 'application/zip',
        final_url: 'https://x.test/big.zip',
        error: 'timed out after 30000ms',
      })),
    });
    const out = await handleBrowserTool(
      'browser.download',
      { tab_id: 'tab_1', url: 'https://x.test/big.zip' },
      deps,
      TEST_CALLER,
    );
    expect(out).toMatchObject({ ok: false, state: 'timeout', bytes: 4096, filename: 'big.zip' });
  });

  test('emits download-started and download-finished bridge events', async () => {
    const { deps, emitEvent } = downloadDeps();
    await handleBrowserTool(
      'browser.download',
      { tab_id: 'tab_1', url: 'https://x.test/files/report.csv' },
      deps,
      TEST_CALLER,
    );
    expect(emitEvent).toHaveBeenNthCalledWith(1, 'download-started', {
      tab_id: 'tab_1',
      mode: 'url',
    });
    expect(emitEvent).toHaveBeenNthCalledWith(2, 'download-finished', {
      tab_id: 'tab_1',
      state: 'complete',
      filename: 'report.csv',
      bytes: 3,
      path: '/dl/report.csv:3',
    });
  });

  test('a throwing transport still closes the event pair with an interrupted download-finished', async () => {
    const { deps, emitEvent } = downloadDeps({
      callBrowserTool: vi.fn(async () => {
        throw new Error('another browser.download is already waiting');
      }),
    });
    await expect(
      handleBrowserTool(
        'browser.download',
        { tab_id: 'tab_1', selector: '#export' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/already waiting/);
    expect(emitEvent).toHaveBeenCalledTimes(2);
    expect(emitEvent).toHaveBeenNthCalledWith(2, 'download-finished', {
      tab_id: 'tab_1',
      state: 'interrupted',
      filename: null,
      bytes: 0,
      error: 'another browser.download is already waiting',
    });
  });

  test('a claim conflict also gets exactly one download-finished', async () => {
    const tabClaims = new TabClaimRegistry();
    tabClaims.claim('tab_1', { agent_id: 'other', pid: 1, binary: 'x' });
    const { deps, emitEvent } = downloadDeps({ tabClaims });
    await expect(
      handleBrowserTool(
        'browser.download',
        { tab_id: 'tab_1', url: 'https://x.test/a' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/other/);
    const kinds = emitEvent.mock.calls.map((c) => c[0] as string);
    expect(kinds).toEqual(['download-started', 'download-finished']);
  });

  describe('one shared timeout budget across capture and fetch', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    test('the fetch only gets what the capture left over', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const callBrowserTool = vi.fn(async (_tab: string, tool: string) => {
        if (tool === 'download') {
          vi.setSystemTime(1_004_000); // the click-to-download wait took 4s
          return { state: 'captured', url: 'https://x.test/f.csv', filename: 'f.csv' };
        }
        return okFetch;
      });
      const { deps } = downloadDeps({ callBrowserTool });
      await handleBrowserTool(
        'browser.download',
        { tab_id: 'tab_1', selector: '#export', timeout_ms: 10_000 },
        deps,
        TEST_CALLER,
      );
      const [captureCall, fetchCall] = callBrowserTool.mock.calls as unknown as [
        unknown[],
        unknown[],
      ];
      expect(captureCall[3]).toBe(10_000 + 10_000);
      expect((fetchCall[2] as { expression: string }).expression).toContain(
        'const timeoutMs = 6000;',
      );
      expect(fetchCall[3]).toBe(6_000 + 10_000);
    });

    test('a capture that used the whole budget returns timeout with the URL, without fetching', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const callBrowserTool = vi.fn(async () => {
        vi.setSystemTime(1_010_000);
        return { state: 'captured', url: 'https://x.test/f.csv', filename: 'f.csv' };
      });
      const { deps, saveDownload } = downloadDeps({ callBrowserTool });
      const out = await handleBrowserTool(
        'browser.download',
        { tab_id: 'tab_1', selector: '#export', timeout_ms: 10_000 },
        deps,
        TEST_CALLER,
      );
      expect(callBrowserTool).toHaveBeenCalledOnce();
      expect(saveDownload).not.toHaveBeenCalled();
      expect(out).toMatchObject({
        ok: false,
        state: 'timeout',
        url: 'https://x.test/f.csv',
        filename: 'f.csv',
      });
    });
  });

  test('the schema states the shared budget and the real worst case', () => {
    const def = BROWSER_TOOL_DEFINITIONS.find((d) => d.name === 'browser.download');
    const schema = def?.inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    expect(schema.properties.timeout_ms?.description).toMatch(/shared/i);
    expect(schema.properties.timeout_ms?.description).toMatch(/worst case/i);
  });

  test.each([
    [{ tab_id: 'tab_1' }, /exactly one of selector, url/],
    [{ tab_id: 'tab_1', selector: '#a', url: 'https://x.test/a' }, /exactly one of selector, url/],
    [{ tab_id: 'tab_1', url: 'javascript:alert(1)' }, /http\(s\), blob: or data:/],
    [{ tab_id: 'tab_1', url: 'file:///etc/passwd' }, /http\(s\), blob: or data:/],
    [{ tab_id: 'tab_1', url: 'https://x.test/a', filename: '../a.txt' }, /filename/],
  ])('rejects invalid args %j', async (args, message) => {
    const { deps } = downloadDeps();
    await expect(handleBrowserTool('browser.download', args, deps, TEST_CALLER)).rejects.toThrow(
      message,
    );
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('fails plainly when no download directory is wired', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.download',
        { tab_id: 'tab_1', url: 'https://x.test/a' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/not available/);
  });

  test('respects another agent holding the tab claim', async () => {
    const tabClaims = new TabClaimRegistry();
    tabClaims.claim('tab_1', { agent_id: 'other', pid: 1, binary: 'x' });
    const { deps } = downloadDeps({ tabClaims });
    await expect(
      handleBrowserTool(
        'browser.download',
        { tab_id: 'tab_1', url: 'https://x.test/a' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/other/);
  });

  test('url mode works on a cdp: tab (in-page fetch rides the supported evaluate path)', async () => {
    const callCdpTool = vi.fn(async () => okFetch);
    const { deps } = downloadDeps({ cdpGate: () => ({ ok: true as const }), callCdpTool });
    const out = (await handleBrowserTool(
      'browser.download',
      { tab_id: 'cdp:ABC', url: 'https://x.test/files/report.csv' },
      deps,
      TEST_CALLER,
    )) as { ok: boolean };
    expect(callCdpTool.mock.calls[0][1]).toBe('evaluate');
    expect(out.ok).toBe(true);
  });

  test('selector mode on a cdp: tab fails with the unsupported-over-cdp-direct error', async () => {
    const callCdpTool = vi.fn(async () => okFetch);
    const { deps } = downloadDeps({ cdpGate: () => ({ ok: true as const }), callCdpTool });
    await expect(
      handleBrowserTool(
        'browser.download',
        { tab_id: 'cdp:ABC', selector: '#export' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/not supported over cdp-direct/);
    expect(callCdpTool).not.toHaveBeenCalled();
  });
});

describe('ref as a target (spec v4 §6.3) — dispatch validation', () => {
  const tab = { tab_id: 'tab_1' };
  const call = (name: string, args: Record<string, unknown>, deps = makeDeps()) =>
    handleBrowserTool(name, { ...tab, ...args }, deps, TEST_CALLER);
  const forwarded = (deps: BrowserToolDeps): Record<string, unknown> =>
    (deps.callBrowserTool as ReturnType<typeof vi.fn>).mock.calls[0][2] as Record<string, unknown>;

  test('click forwards ref and needs exactly one of selector or ref', async () => {
    const deps = makeDeps();
    await call('browser.click', { ref: 'k3x9ab:e12' }, deps);
    expect(forwarded(deps)).toMatchObject({ ref: 'k3x9ab:e12' });
    expect(forwarded(deps).selector).toBeUndefined();
    await expect(call('browser.click', {})).rejects.toThrow(
      'browser.click needs exactly one of selector or ref',
    );
    await expect(call('browser.click', { selector: '#a', ref: 'k3x9ab:e1' })).rejects.toThrow(
      'browser.click needs exactly one of selector or ref',
    );
  });

  test('click by selector still forwards no ref key', async () => {
    const deps = makeDeps();
    await call('browser.click', { selector: '#go' }, deps);
    expect(forwarded(deps)).toMatchObject({ selector: '#go', force: false });
    expect(forwarded(deps)).not.toHaveProperty('ref');
  });

  test('type forwards ref and needs exactly one of selector or ref', async () => {
    const deps = makeDeps();
    await call('browser.type', { ref: 'k3x9ab:e3', text: 'hi' }, deps);
    expect(forwarded(deps)).toMatchObject({ ref: 'k3x9ab:e3', text: 'hi' });
    await expect(call('browser.type', { text: 'hi' })).rejects.toThrow(
      'browser.type needs exactly one of selector or ref',
    );
    await expect(
      call('browser.type', { selector: '#a', ref: 'k3x9ab:e1', text: 'hi' }),
    ).rejects.toThrow('browser.type needs exactly one of selector or ref');
    const bySelector = makeDeps();
    await call('browser.type', { selector: '#q', text: 'hi' }, bySelector);
    expect(forwarded(bySelector)).not.toHaveProperty('ref');
  });

  test('press forwards ref; ref and selector are exclusive', async () => {
    const deps = makeDeps();
    await call('browser.press', { key: 'Enter', ref: 'k3x9ab:e4' }, deps);
    expect(forwarded(deps)).toMatchObject({ key: 'Enter', ref: 'k3x9ab:e4' });
    await expect(
      call('browser.press', { key: 'Enter', ref: 'k3x9ab:e4', selector: '#a' }),
    ).rejects.toThrow('browser.press accepts at most one of selector or ref');
  });

  test('wait_for accepts ref as a mode, with condition', async () => {
    const deps = makeDeps();
    await call('browser.wait_for', { ref: 'k3x9ab:e5', condition: 'detached' }, deps);
    expect(forwarded(deps)).toMatchObject({ ref: 'k3x9ab:e5', condition: 'detached' });
    await expect(call('browser.wait_for', { ref: 'k3x9ab:e5', selector: '#a' })).rejects.toThrow(
      /exactly one of selector, expression, network_url, ref/,
    );
    await expect(call('browser.wait_for', { ref: 'k3x9ab:e5', condition: 'gone' })).rejects.toThrow(
      /condition must be one of visible \| hidden \| attached \| detached/,
    );
  });

  test('find needs text unless ref is given, and forwards ref', async () => {
    const deps = makeDeps();
    await call('browser.find', { ref: 'k3x9ab:e6' }, deps);
    expect(forwarded(deps)).toEqual({ ref: 'k3x9ab:e6' });
    await expect(call('browser.find', {})).rejects.toThrow('browser.find: text required');
    const byText = makeDeps();
    await call('browser.find', { text: 'Save' }, byText);
    expect(forwarded(byText)).toEqual({ text: 'Save', role: undefined, exact: false });
  });

  test.each([
    ['browser.click', {}],
    ['browser.type', { text: 'x' }],
    ['browser.press', { key: 'Enter' }],
    ['browser.wait_for', {}],
    ['browser.find', {}],
  ])('%s rejects a ref that is not <doc_tag>:e<digits> or too long', async (name, extra) => {
    for (const ref of [
      '12',
      'e',
      'e12',
      'e1x',
      'E1',
      '',
      7,
      ':e1',
      'k3x9ab:e',
      'k3x9ab:E1',
      'K3X9AB:e1',
      'k3x9ab-e1',
      'k3x9ab:e1x',
      'a'.repeat(17) + ':e1',
      'k3x9ab:e' + '1'.repeat(64),
    ]) {
      await expect(call(name, { ...extra, ref })).rejects.toThrow(
        `${name}: ref must be an element ref like "k3x9ab:e12"`,
      );
    }
  });

  test('find rejects a ref combined with text, role or exact', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ text: 'Save' }, 'browser.find needs exactly one of text, ref or key'],
      [{ role: 'button' }, 'browser.find: role and exact apply to text mode only'],
      [{ exact: true }, 'browser.find: role and exact apply to text mode only'],
    ];
    for (const [extra, error] of cases) {
      const deps = makeDeps();
      await expect(call('browser.find', { ref: 'k3x9ab:e6', ...extra }, deps)).rejects.toThrow(
        error,
      );
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    }
  });

  test('find forwards text with role and exact', async () => {
    const deps = makeDeps();
    await call('browser.find', { text: 'Save', role: 'button', exact: true }, deps);
    expect(forwarded(deps)).toEqual({ text: 'Save', role: 'button', exact: true });
  });

  describe('validateFlowSteps', () => {
    test('click, type, press and wait_for steps accept ref', () => {
      expect(
        validateFlowSteps([
          { click: { ref: 'k3x9ab:e1' } },
          { type: { ref: 'k3x9ab:e2', text: 'x' } },
          { press: { ref: 'k3x9ab:e2', key: 'Enter' } },
          { wait_for: { ref: 'k3x9ab:e1', condition: 'detached' } },
        ]).ok,
      ).toBe(true);
    });

    test('a step with both selector and ref is rejected', () => {
      for (const step of [
        { click: { selector: '#a', ref: 'k3x9ab:e1' } },
        { type: { selector: '#a', ref: 'k3x9ab:e1', text: 'x' } },
        { press: { selector: '#a', ref: 'k3x9ab:e1', key: 'Enter' } },
      ]) {
        const kind = Object.keys(step)[0];
        expect(validateFlowSteps([step])).toEqual({
          ok: false,
          error: `step 0: ${kind} accepts at most one of selector or ref`,
        });
      }
      expect(validateFlowSteps([{ wait_for: { selector: '#a', ref: 'k3x9ab:e1' } }])).toEqual({
        ok: false,
        error: 'step 0: wait_for requires exactly one of selector | expression | network_url | ref',
      });
    });

    test('a malformed step ref is rejected', () => {
      expect(validateFlowSteps([{ click: { ref: 'button' } }])).toEqual({
        ok: false,
        error:
          'step 0: click.ref must be an element ref like "k3x9ab:e12" (a document tag of 1-16 lowercase letters or digits, ":e" and digits, at most 64 characters)',
      });
    });

    test('a find step carrying ref or key is rejected', () => {
      for (const extra of [{ ref: 'k3x9ab:e1' }, { key: { role: 'button', name: 'Go' } }]) {
        expect(validateFlowSteps([{ find: { text: 'Go', ...extra } }, { click: {} }])).toEqual({
          ok: false,
          error: 'step 0: find steps take text (and role, exact) only',
        });
      }
    });

    test('selector-only steps validate exactly as before', () => {
      expect(validateFlowSteps([{ find: { text: 'Go' } }, { click: {} }]).ok).toBe(true);
      expect(validateFlowSteps([{ click: { selector: '#a' } }]).ok).toBe(true);
      expect(validateFlowSteps([{ click: {} }])).toEqual({
        ok: false,
        error: 'step 0: click has no selector and no preceding find to supply an implicit target',
      });
    });
  });
});

describe('find by semantic key (spec v4 §6.3, S3) — dispatch validation', () => {
  const tab = { tab_id: 'tab_1' };
  const call = (name: string, args: Record<string, unknown>, deps = makeDeps()) =>
    handleBrowserTool(name, { ...tab, ...args }, deps, TEST_CALLER);
  const forwarded = (deps: BrowserToolDeps): Record<string, unknown> =>
    (deps.callBrowserTool as ReturnType<typeof vi.fn>).mock.calls[0][2] as Record<string, unknown>;
  const KEY = {
    role: 'button',
    name: 'Save',
    path: [
      { tag: 'body', index: 1 },
      { tag: 'button', index: 2 },
    ],
  };

  test('a valid key is forwarded alone, with or without path', async () => {
    const deps = makeDeps();
    await call('browser.find', { key: KEY }, deps);
    expect(forwarded(deps)).toEqual({ key: KEY });
    const bare = makeDeps();
    await call('browser.find', { key: { role: 'button', name: 'Save' } }, bare);
    expect(forwarded(bare)).toEqual({ key: { role: 'button', name: 'Save' } });
  });

  test('key rejects role and exact', async () => {
    for (const extra of [{ role: 'button' }, { exact: true }]) {
      const deps = makeDeps();
      await expect(call('browser.find', { key: KEY, ...extra }, deps)).rejects.toThrow(
        'browser.find: role and exact apply to text mode only',
      );
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    }
  });

  test('key is exclusive with text and ref', async () => {
    for (const extra of [{ text: 'Save' }, { ref: 'k3x9ab:e3' }]) {
      const deps = makeDeps();
      await expect(call('browser.find', { key: KEY, ...extra }, deps)).rejects.toThrow(
        'browser.find needs exactly one of text, ref or key',
      );
      expect(deps.callBrowserTool).not.toHaveBeenCalled();
    }
  });

  test.each([
    ['not an object', 'button'],
    ['missing role', { name: 'Save' }],
    ['empty role', { role: '', name: 'Save' }],
    ['missing name', { role: 'button' }],
    ['a name over 200 chars', { role: 'button', name: 'x'.repeat(201) }],
    ['an empty path', { role: 'button', name: 'Save', path: [] }],
    [
      'a path of 9 steps',
      {
        role: 'button',
        name: 'Save',
        path: Array.from({ length: 9 }, () => ({ tag: 'div', index: 1 })),
      },
    ],
    ['a step without tag', { role: 'button', name: 'Save', path: [{ index: 1 }] }],
    ['a fractional index', { role: 'button', name: 'Save', path: [{ tag: 'div', index: 1.5 }] }],
    ['an unknown field', { role: 'button', name: 'Save', extra: 1 }],
  ])('a malformed key (%s) is rejected before the bridge', async (_label, key) => {
    const deps = makeDeps();
    await expect(call('browser.find', { key }, deps)).rejects.toThrow(/^browser\.find: key /);
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('text mode and ref mode forward exactly what they did before', async () => {
    const byText = makeDeps();
    await call('browser.find', { text: 'Save', role: 'button' }, byText);
    expect(forwarded(byText)).toEqual({ text: 'Save', role: 'button', exact: false });
    const byRef = makeDeps();
    await call('browser.find', { ref: 'k3x9ab:e6' }, byRef);
    expect(forwarded(byRef)).toEqual({ ref: 'k3x9ab:e6' });
    await expect(call('browser.find', {})).rejects.toThrow('browser.find: text required');
  });

  test('the find schema declares key with role and name required', () => {
    const find = BROWSER_TOOL_DEFINITIONS.find((d) => d.name === 'browser.find')!;
    const props = (find.inputSchema as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(props.key).toMatchObject({ type: 'object', required: ['role', 'name'] });
    expect(find.description).toContain('`key`');
  });
});

describe('browser.manual (server-only, never touches a tab)', () => {
  const STATUSES = [
    { id: 'claude', displayName: 'Claude Code', state: { kind: 'installed', version: '0.30.0' } },
    {
      id: 'opencode',
      displayName: 'OpenCode',
      state: { kind: 'installed-outdated', version: '0.29.0' },
    },
    { id: 'copilot', displayName: 'GitHub Copilot CLI', state: { kind: 'no-file' } },
  ] as const;

  function manualDeps(): BrowserToolDeps {
    return makeDeps({
      listTabs: vi.fn(() => {
        throw new Error('browser.manual must not list tabs');
      }),
      callBrowserTool: vi.fn(() => Promise.reject(new Error('browser.manual must not route'))),
      instructionsStatus: () => STATUSES.map((s) => ({ ...s, state: { ...s.state } })),
    });
  }

  async function manual(args: unknown, deps = manualDeps()): Promise<string> {
    const out = await handleBrowserTool('browser.manual', args, deps, TEST_CALLER);
    expect(typeof out).toBe('string');
    return out as string;
  }

  test('is a recognised browser tool with a definition and a doc', () => {
    expect(isBrowserTool('browser.manual')).toBe(true);
    const def = BROWSER_TOOL_DEFINITIONS.find((d) => d.name === 'browser.manual');
    expect(def?.doc?.purpose.length).toBeGreaterThan(0);
    expect(def?.inputSchema).toMatchObject({ additionalProperties: false });
  });

  test('the index carries the version, the block status per client, every tool and every topic', async () => {
    const { VERSION } = await import('../version.js');
    const { MAP_TOOL_DEFINITIONS } = await import('../map/tools.js');
    const { TOPIC_NAMES } = await import('../manual/topics.js');
    const deps = manualDeps();
    const index = await manual(undefined, deps);
    expect(index.split('\n')[0]).toBe(`browser-link ${VERSION}`);
    expect(index).toContain('Claude Code: installed v0.30.0');
    expect(index).toContain(
      `OpenCode: installed-outdated v0.29.0 → v${VERSION}: run browser-link instructions install`,
    );
    expect(index).toContain('GitHub Copilot CLI: no-file');
    for (const def of [...BROWSER_TOOL_DEFINITIONS, ...MAP_TOOL_DEFINITIONS]) {
      expect(index).toContain(`- ${def.name} — `);
    }
    for (const topic of TOPIC_NAMES) expect(index).toContain(`- ${topic} — `);
    expect(deps.listTabs).not.toHaveBeenCalled();
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
    // `{}` is the same as no arguments.
    expect(await manual({}, deps)).toBe(index);
  });

  test('{ tool } renders the doc plus one line per inputSchema property', async () => {
    const click = BROWSER_TOOL_DEFINITIONS.find((d) => d.name === 'browser.click')!;
    const out = await manual({ tool: 'browser.click' });
    expect(out).toContain('### browser.click');
    expect(out).toContain(click.doc!.purpose);
    expect(out).toContain('**Gotchas:**');
    expect(out).toContain('**Parameters:**');
    expect(out).toContain('- tab_id (string, required)');
    expect(out).toContain('- selector (string, optional): CSS selector.');
  });

  test('{ tool } works for map tools too', async () => {
    const out = await manual({ tool: 'browser.map.recall' });
    expect(out).toContain('### browser.map.recall');
  });

  test('{ topic } returns that topic', async () => {
    const { renderTopic } = await import('../manual/topics.js');
    expect(await manual({ topic: 'downloads' })).toBe(renderTopic('downloads'));
  });

  test('an unknown tool fails listing the valid names', async () => {
    await expect(manual({ tool: 'browser.nope' })).rejects.toThrow(
      /Unknown tool "browser\.nope"[\s\S]*browser\.click[\s\S]*browser\.map\.recall/,
    );
  });

  test('an unknown topic fails listing the valid topics', async () => {
    await expect(manual({ topic: 'nope' })).rejects.toThrow(
      /Unknown topic "nope"[\s\S]*downloads, canvas/,
    );
  });

  test('tool and topic together fail naming both', async () => {
    await expect(manual({ tool: 'browser.click', topic: 'downloads' })).rejects.toThrow(
      /either `tool` or `topic`, not both/,
    );
  });

  test('works with no connected tab and no claim registry', async () => {
    const deps = makeDeps({ instructionsStatus: () => [] });
    const out = (await handleBrowserTool('browser.manual', {}, deps, TEST_CALLER)) as string;
    expect(out).toContain('browser.list_tabs');
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });
});

describe('list_tabs — extension version (S3)', () => {
  async function listWith(tabs: Array<Record<string, unknown>>, cdp: unknown[] = []) {
    const deps = makeDeps({
      listTabs: vi.fn(() => tabs as never),
      listCdpTabs: vi.fn(async () => cdp as never),
    });
    return (await handleBrowserTool('browser.list_tabs', {}, deps, TEST_CALLER)) as Array<
      Record<string, unknown>
    >;
  }

  test('passes extension_version through and flags extension_outdated only when it is lower', async () => {
    const { VERSION } = await import('../version.js');
    const [major, minor, patch] = VERSION.split('.').map(Number) as [number, number, number];
    const newer = `${major}.${minor}.${patch + 1}`;
    const tabs = await listWith([
      { tab_id: 'tab_1', url: 'http://a', title: 'A', extension_version: '0.0.1' },
      { tab_id: 'tab_2', url: 'http://b', title: 'B', extension_version: VERSION },
      { tab_id: 'tab_3', url: 'http://c', title: 'C', extension_version: newer },
      { tab_id: 'tab_4', url: 'http://d', title: 'D' },
      { tab_id: 'tab_5', url: 'http://e', title: 'E', extension_version: 'not-a-version' },
    ]);
    const byId = new Map(tabs.map((t) => [t.tab_id, t]));
    expect(byId.get('tab_1')!.extension_version).toBe('0.0.1');
    expect(byId.get('tab_1')!.extension_outdated).toBe(true);
    expect(byId.get('tab_2')!.extension_version).toBe(VERSION);
    expect(byId.get('tab_2')).not.toHaveProperty('extension_outdated');
    expect(byId.get('tab_3')).not.toHaveProperty('extension_outdated');
    expect(byId.get('tab_4')).not.toHaveProperty('extension_version');
    expect(byId.get('tab_4')).not.toHaveProperty('extension_outdated');
    expect(byId.get('tab_5')).not.toHaveProperty('extension_outdated');
  });

  test('a cdp tab carries neither field', async () => {
    const tabs = await listWith(
      [],
      [{ tab_id: 'cdp:ABC', url: 'http://x', title: 'X', transport: 'cdp' }],
    );
    expect(tabs[0]).not.toHaveProperty('extension_version');
    expect(tabs[0]).not.toHaveProperty('extension_outdated');
  });
});

describe('outdatedServerHint (S3b)', () => {
  test('installed newer than running: tells the agent what to ask the user', () => {
    expect(outdatedServerHint('0.40.0', '0.41.0')).toBe(
      'server running 0.40.0, installed 0.41.0: this server is outdated; ask the user to run browser-link stop and restart the agent, or to click "Repair connection" in the extension popup',
    );
  });

  test('no hint when running = installed, installed is older, or unknown', () => {
    expect(outdatedServerHint('0.41.0', '0.41.0')).toBeNull();
    expect(outdatedServerHint('0.41.0', '0.40.0')).toBeNull();
    expect(outdatedServerHint('0.41.0', null)).toBeNull();
  });

  test('list_tabs result is unchanged when running = installed', async () => {
    const deps = makeDeps({
      listTabs: vi.fn(() => [{ tab_id: 'tab_1', url: 'http://x', title: 't' }]),
    });
    expect(outdatedServerHint(VERSION, VERSION)).toBeNull();
    expect(await handleBrowserTool('browser.list_tabs', {}, deps, TEST_CALLER)).toEqual([
      { tab_id: 'tab_1', url: 'http://x', title: 't', claimed_by: null, claimed_by_me: false },
    ]);
  });
});

describe('handleBrowserTool — outcome learner and trail evidence (map-learning)', () => {
  const TAB = { tab_id: 'tab_1', url: 'https://app.example.com/settings?id=1', title: 'App' };

  test('recordOutcome and recordActivity both receive the resolved result', async () => {
    const recordActivity = vi.fn();
    const recordOutcome = vi.fn();
    const deps = makeDeps({
      listTabs: vi.fn(() => [TAB]),
      callBrowserTool: vi.fn(async () => ({ matched: false, reason: 'timeout' })),
      recordActivity,
      recordOutcome,
    });
    const args = { tab_id: 'tab_1', selector: '.toast', timeout_ms: 10 };
    const result = await handleBrowserTool('browser.wait_for', args, deps, TEST_CALLER);
    expect(result).toEqual({ matched: false, reason: 'timeout' });
    expect(recordOutcome).toHaveBeenCalledWith({
      tool: 'browser.wait_for',
      args,
      result: { matched: false, reason: 'timeout' },
      error: undefined,
      url: TAB.url,
      title: TAB.title,
    });
    // The trail row is built with the result and the caller's session id
    // (buildActivityRow classifies `matched: false` as `unmatched`).
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]![0]).toMatchObject({
      tool: 'browser.wait_for',
      outcome: 'ok',
      flag: 'unmatched',
      agentId: TEST_CALLER.agent_id,
    });
  });

  test('a thrown call reaches the learner with its error', async () => {
    const recordOutcome = vi.fn();
    const error = new Error('Element not found: #save');
    const deps = makeDeps({
      listTabs: vi.fn(() => [TAB]),
      callBrowserTool: vi.fn(async () => {
        throw error;
      }),
      recordOutcome,
    });
    await expect(
      handleBrowserTool('browser.click', { tab_id: 'tab_1', selector: '#save' }, deps, TEST_CALLER),
    ).rejects.toThrow('Element not found');
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'browser.click', error, result: undefined }),
    );
  });

  test('an evaluate refused for a bad `as` never reaches the learner, but stays on the trail', async () => {
    const recordActivity = vi.fn();
    const recordOutcome = vi.fn();
    const call = vi.fn(async () => 1);
    const deps = makeDeps({
      listTabs: vi.fn(() => [TAB]),
      callBrowserTool: call,
      recordActivity,
      recordOutcome,
    });
    await expect(
      handleBrowserTool(
        'browser.evaluate',
        { tab_id: 'tab_1', expression: '1', as: 'getTotal' },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/rule 4/);
    expect(call).not.toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
    expect(recordActivity).toHaveBeenCalledTimes(1);
  });

  test('the learner runs even when activity recording is off (no recordActivity)', async () => {
    const recordOutcome = vi.fn();
    const deps = makeDeps({
      listTabs: vi.fn(() => [TAB]),
      callBrowserTool: vi.fn(async () => ({ ok: true })),
      recordOutcome,
    });
    await handleBrowserTool(
      'browser.click',
      { tab_id: 'tab_1', selector: '#a' },
      deps,
      TEST_CALLER,
    );
    expect(recordOutcome).toHaveBeenCalledTimes(1);
  });

  test('a throwing learner never fails the tool, on success or on error', async () => {
    const recordOutcome = vi.fn(() => {
      throw new Error('map DB locked');
    });
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = makeDeps({
      listTabs: vi.fn(() => [TAB]),
      callBrowserTool: vi.fn(async () => ({ ok: true })),
      recordOutcome,
    });
    await expect(
      handleBrowserTool('browser.click', { tab_id: 'tab_1', selector: '#a' }, ok, TEST_CALLER),
    ).resolves.toEqual({ ok: true });
    const failing = makeDeps({
      listTabs: vi.fn(() => [TAB]),
      callBrowserTool: vi.fn(async () => {
        throw new Error('Element not found: #a');
      }),
      recordOutcome,
    });
    await expect(
      handleBrowserTool('browser.click', { tab_id: 'tab_1', selector: '#a' }, failing, TEST_CALLER),
    ).rejects.toThrow('Element not found: #a');
    warn.mockRestore();
  });
});

describe('browser.activity — records mode and summary mode', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-dispatch-activity-'));
    process.env.BROWSER_LINK_DATA_DIR = dataDir;
  });

  afterEach(() => {
    closeActivityDb();
    delete process.env.BROWSER_LINK_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('records mode is unchanged: { records, latest_id, total, agents }', async () => {
    const result = (await handleBrowserTool(
      'browser.activity',
      {},
      makeDeps(),
      TEST_CALLER,
    )) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['records', 'latest_id', 'total', 'agents']);
    expect(result.records).toEqual([]);
  });

  test('summary: true returns the friction report instead of records', async () => {
    const result = (await handleBrowserTool(
      'browser.activity',
      { summary: true },
      makeDeps(),
      TEST_CALLER,
    )) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['summary']);
    expect(result.summary).toMatchObject({ records: 0, errors: 0 });
  });
});

describe('browser.activity — explicit filters are honoured or refused', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-dispatch-activity-filters-'));
    process.env.BROWSER_LINK_DATA_DIR = dataDir;
  });

  afterEach(() => {
    closeActivityDb();
    delete process.env.BROWSER_LINK_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Two rows: an old one of session s1, a recent one of session s2. */
  function seed(): { old: number; recent: number } {
    const base = {
      tool: 'browser.click',
      tabId: 'tab_1',
      transport: 'extension' as const,
      url: 'https://example.com/',
      title: 'Example',
      agent: 'claude-code',
      agentPid: 1,
      selector: '#a',
      payload: null,
      outcome: 'ok' as const,
      error: null,
      durationMs: 1,
      flowId: null,
    };
    const old = recordActivityRow({ ...base, agentId: 's1' })!;
    const recent = recordActivityRow({ ...base, agentId: 's2' })!;
    getActivityDb()
      .prepare('UPDATE activity SET at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', old.id);
    return { old: old.id, recent: recent.id };
  }

  async function activity(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await handleBrowserTool('browser.activity', args, makeDeps(), TEST_CALLER)) as Record<
      string,
      unknown
    >;
  }

  const ids = (result: Record<string, unknown>): number[] =>
    (result.records as { id: number }[]).map((r) => r.id);

  test('records mode honours since', async () => {
    const { recent } = seed();
    expect(ids(await activity({ since: '2025-01-01T00:00:00Z' }))).toEqual([recent]);
  });

  test('records mode honours agent_id', async () => {
    const { old } = seed();
    expect(ids(await activity({ agent_id: 's1' }))).toEqual([old]);
  });

  test('records mode without since/agent_id is unchanged', async () => {
    const { old, recent } = seed();
    const result = await activity({});
    expect(Object.keys(result)).toEqual(['records', 'latest_id', 'total', 'agents']);
    expect(ids(result)).toEqual([recent, old]);
    expect(result.total).toBe(2);
  });

  test('summary: true refuses records-only filters, naming them', async () => {
    await expect(activity({ summary: true, agent: 'claude-code', limit: 5 })).rejects.toThrow(
      'summary: true does not accept: agent, limit',
    );
    await expect(
      activity({
        summary: true,
        tool: 'browser.click',
        tab_id: 'tab_1',
        outcome: 'error',
        include_payloads: false,
      }),
    ).rejects.toThrow('summary: true does not accept: tab_id, tool, outcome, include_payloads');
  });

  test('summary: true with only window filters still runs', async () => {
    seed();
    const result = await activity({ summary: true, since: '2025-01-01T00:00:00Z', agent_id: 's2' });
    expect(result.summary).toMatchObject({ records: 1 });
  });
});

describe('browser.network — headers option', () => {
  const entries = [
    {
      request_id: 'r1',
      url: 'https://x.test/api',
      method: 'GET',
      status: 200,
      mime_type: 'application/json',
      request_headers: { accept: '*/*' },
      response_headers: { 'content-type': 'application/json' },
      started_at: 1,
      finished_at: 2,
    },
    { request_id: 'r2', url: 'https://x.test/pending', method: 'POST', started_at: 3 },
  ];

  function networkDeps() {
    return makeDeps({ callBrowserTool: vi.fn(async () => structuredClone(entries)) });
  }

  test('default output is unchanged: headers included, extension params untouched', async () => {
    const deps = networkDeps();
    const out = await handleBrowserTool(
      'browser.network',
      { tab_id: 'tab_1', url_filter: 'x.test' },
      deps,
      TEST_CALLER,
    );
    expect(out).toEqual(entries);
    const calls = (deps.callBrowserTool as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toBe('network');
    expect(calls[0][2]).toEqual({ url_filter: 'x.test' });
  });

  test('headers: true is the same as the default', async () => {
    const out = await handleBrowserTool(
      'browser.network',
      { tab_id: 'tab_1', headers: true },
      networkDeps(),
      TEST_CALLER,
    );
    expect(out).toEqual(entries);
  });

  test('headers: false omits request and response headers from every entry', async () => {
    const out = (await handleBrowserTool(
      'browser.network',
      { tab_id: 'tab_1', headers: false },
      networkDeps(),
      TEST_CALLER,
    )) as Record<string, unknown>[];
    expect(out).toHaveLength(2);
    for (const entry of out) {
      expect(entry).not.toHaveProperty('request_headers');
      expect(entry).not.toHaveProperty('response_headers');
    }
    expect(out[0]).toEqual({
      request_id: 'r1',
      url: 'https://x.test/api',
      method: 'GET',
      status: 200,
      mime_type: 'application/json',
      started_at: 1,
      finished_at: 2,
    });
    expect(out[1]).toEqual(entries[1]);
  });

  test('a non-boolean headers value is refused before reaching the tab', async () => {
    const deps = networkDeps();
    await expect(
      handleBrowserTool('browser.network', { tab_id: 'tab_1', headers: 'no' }, deps, TEST_CALLER),
    ).rejects.toThrow('browser.network: headers must be a boolean');
    expect(deps.callBrowserTool).not.toHaveBeenCalled();
  });

  test('the schema and doc document the option', () => {
    const def = BROWSER_TOOL_DEFINITIONS.find((d) => d.name === 'browser.network');
    const schema = def?.inputSchema as {
      properties: Record<string, { type?: string; description?: string }>;
    };
    expect(schema.properties.headers?.type).toBe('boolean');
    expect(schema.properties.headers?.description).toMatch(/default true/i);
  });
});

describe('browser.download — configurable size cap', () => {
  let dataDir: string;
  const okFetch = {
    state: 'complete',
    status: 200,
    mime: 'text/csv',
    content_disposition: null,
    final_url: 'https://x.test/r.csv',
    bytes: 3,
    data_b64: Buffer.from('a,b').toString('base64'),
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-dispatch-download-cap-'));
    process.env.BROWSER_LINK_DATA_DIR = dataDir;
  });

  afterEach(() => {
    delete process.env.BROWSER_LINK_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function fetchExpression(): Promise<string> {
    const callBrowserTool = vi.fn(async () => okFetch);
    await handleBrowserTool(
      'browser.download',
      { tab_id: 'tab_1', url: 'https://x.test/r.csv' },
      makeDeps({ callBrowserTool, saveDownload: () => '/dl/r.csv' }),
      TEST_CALLER,
    );
    return (callBrowserTool.mock.calls[0] as unknown as [string, string, { expression: string }])[2]
      .expression;
  }

  test('without a configured value the cap is the 25 MiB default', async () => {
    expect(await fetchExpression()).toContain(`const maxBytes = ${25 * 1024 * 1024};`);
  });

  test('downloads.max-mb from config.json is read on every call', async () => {
    saveConfig({ downloadsMaxMb: 50 });
    expect(await fetchExpression()).toContain(`const maxBytes = ${50 * 1024 * 1024};`);
    saveConfig({ downloadsMaxMb: 2 });
    expect(await fetchExpression()).toContain(`const maxBytes = ${2 * 1024 * 1024};`);
  });

  test('an out-of-range or malformed value in config.json falls back to the default', async () => {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ downloadsMaxMb: 100000 }));
    expect(await fetchExpression()).toContain(`const maxBytes = ${25 * 1024 * 1024};`);
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ downloadsMaxMb: '50' }));
    expect(await fetchExpression()).toContain(`const maxBytes = ${25 * 1024 * 1024};`);
  });

  test('the over-cap error names the active cap in MiB', async () => {
    saveConfig({ downloadsMaxMb: 7 });
    expect(await fetchExpression()).toContain('download exceeds the 7 MiB cap (7340032 bytes)');
  });
});

describe('knowledge loop: start pack, action hints and page identity', () => {
  const TAB = {
    tab_id: 'tab_1',
    url: 'https://app.example.com/facturas/48213?x=1',
    title: 'Invoice',
  };
  const KNOWLEDGE = {
    app_key: 'my-app',
    path: '/facturas/:id',
    pitfalls: [
      { key: 'k', description: 'd', confidence: 'unverified', evidence: { saved_at: 't' } },
    ],
  } as const;
  const HINT = { confidence: 'fresh', ok_n: 3, fail_n: 0, last_reason: null } as const;

  describe('list_tabs', () => {
    test('without getKnowledge the tab reads exactly as before', async () => {
      const deps = makeDeps({ listTabs: vi.fn(() => [TAB]) });
      const tabs = await handleBrowserTool('browser.list_tabs', {}, deps, TEST_CALLER);
      expect(tabs).toEqual([{ ...TAB, claimed_by: null, claimed_by_me: false }]);
    });

    test('a null start pack adds no field', async () => {
      const getKnowledge = vi.fn(() => null);
      const deps = makeDeps({ listTabs: vi.fn(() => [TAB]), getKnowledge });
      const tabs = await handleBrowserTool('browser.list_tabs', {}, deps, TEST_CALLER);
      expect(tabs).toEqual([{ ...TAB, claimed_by: null, claimed_by_me: false }]);
      expect(getKnowledge).toHaveBeenCalledWith({
        origin: 'https://app.example.com',
        pathname: '/facturas/48213',
        build: null,
      });
    });

    test('attaches knowledge per tab, looked up with the tab build, on every call', async () => {
      const getKnowledge = vi.fn(() => KNOWLEDGE);
      const deps = makeDeps({
        listTabs: vi.fn(() => [{ ...TAB, build: '3f9a2b1c', view_sig: '00aa11bb' }]),
        getKnowledge: getKnowledge as unknown as BrowserToolDeps['getKnowledge'],
      });
      for (let i = 0; i < 2; i++) {
        const tabs = (await handleBrowserTool('browser.list_tabs', {}, deps, TEST_CALLER)) as {
          knowledge?: unknown;
          build?: string;
          view_sig?: string;
        }[];
        expect(tabs[0]).toMatchObject({
          build: '3f9a2b1c',
          view_sig: '00aa11bb',
          knowledge: KNOWLEDGE,
        });
      }
      expect(getKnowledge).toHaveBeenCalledTimes(2);
      expect(getKnowledge).toHaveBeenCalledWith(expect.objectContaining({ build: '3f9a2b1c' }));
    });

    test('a tab without a usable origin is never looked up', async () => {
      const getKnowledge = vi.fn(() => KNOWLEDGE);
      const deps = makeDeps({
        listTabs: vi.fn(() => [{ ...TAB, url: 'about:blank' }]),
        getKnowledge: getKnowledge as unknown as BrowserToolDeps['getKnowledge'],
      });
      const tabs = await handleBrowserTool('browser.list_tabs', {}, deps, TEST_CALLER);
      expect(tabs).toEqual([
        { ...TAB, url: 'about:blank', claimed_by: null, claimed_by_me: false },
      ]);
      expect(getKnowledge).not.toHaveBeenCalled();
    });
  });

  describe('navigate', () => {
    const NAV_RESULT = { url: 'https://app.example.com/facturas/7', title: 'Invoice 7' };

    test('without knowledge the result is byte-identical', async () => {
      const deps = makeDeps({
        listTabs: vi.fn(() => [TAB]),
        callBrowserTool: vi.fn(async () => NAV_RESULT),
        getKnowledge: vi.fn(() => null),
      });
      const out = await handleBrowserTool(
        'browser.navigate',
        { tab_id: 'tab_1', url: NAV_RESULT.url },
        deps,
        TEST_CALLER,
      );
      expect(JSON.stringify(out)).toBe(JSON.stringify(NAV_RESULT));
    });

    test('adds the start pack of where it landed', async () => {
      const getKnowledge = vi.fn(() => KNOWLEDGE);
      const deps = makeDeps({
        listTabs: vi.fn(() => [{ ...TAB, build: '3f9a2b1c' }]),
        callBrowserTool: vi.fn(async () => NAV_RESULT),
        getKnowledge: getKnowledge as unknown as BrowserToolDeps['getKnowledge'],
      });
      const out = await handleBrowserTool(
        'browser.navigate',
        { tab_id: 'tab_1', url: NAV_RESULT.url },
        deps,
        TEST_CALLER,
      );
      expect(out).toEqual({ ...NAV_RESULT, knowledge: KNOWLEDGE });
      expect(getKnowledge).toHaveBeenCalledWith({
        origin: 'https://app.example.com',
        pathname: '/facturas/7',
        build: '3f9a2b1c',
      });
    });
  });

  describe('action hints', () => {
    const RESULT = { ok: true, settle: { settled: true, mutation_count: 1 } };

    function depsWith(getActionHint: BrowserToolDeps['getActionHint']): BrowserToolDeps {
      return makeDeps({
        listTabs: vi.fn(() => [{ ...TAB, build: '3f9a2b1c' }]),
        callBrowserTool: vi.fn(async () => RESULT),
        getActionHint,
      });
    }

    test.each([
      ['browser.click', { selector: '#pay' }, 'click', 'selector', '#pay'],
      ['browser.type', { selector: '#q', text: 'secret' }, 'type', 'selector', '#q'],
      ['browser.press', { key: 'Enter', selector: '#q' }, 'press', 'selector', '#q'],
      [
        'browser.find',
        { key: { role: 'button', name: 'Pay', path: [{ tag: 'button', index: 1 }] } },
        'find',
        'key',
        JSON.stringify({ role: 'button', name: 'Pay', path: [{ tag: 'button', index: 1 }] }),
      ],
    ])('%s carries known for a target with evidence', async (tool, args, action, kind, target) => {
      const getActionHint = vi.fn(() => HINT);
      const out = await handleBrowserTool(
        tool,
        { tab_id: 'tab_1', ...args },
        depsWith(getActionHint as unknown as BrowserToolDeps['getActionHint']),
        TEST_CALLER,
      );
      expect(out).toEqual({ ...RESULT, known: HINT });
      expect(getActionHint).toHaveBeenCalledWith({
        origin: 'https://app.example.com',
        pathname: '/facturas/48213',
        build: '3f9a2b1c',
        target,
        target_kind: kind,
        action,
      });
      expect(JSON.stringify(getActionHint.mock.calls)).not.toContain('secret');
    });

    test('no hint, no field: the click result is byte-identical', async () => {
      const out = await handleBrowserTool(
        'browser.click',
        { tab_id: 'tab_1', selector: '#pay' },
        depsWith(vi.fn(() => null)),
        TEST_CALLER,
      );
      expect(JSON.stringify(out)).toBe(JSON.stringify(RESULT));
    });

    test.each([
      ['browser.click', { ref: 'abcdef:e1' }],
      ['browser.press', { key: 'Enter' }],
      ['browser.find', { text: 'Pay' }],
    ])('%s without a durable target never looks one up', async (tool, args) => {
      const getActionHint = vi.fn(() => HINT);
      const out = await handleBrowserTool(
        tool,
        { tab_id: 'tab_1', ...args },
        depsWith(getActionHint as unknown as BrowserToolDeps['getActionHint']),
        TEST_CALLER,
      );
      expect(out).toEqual(RESULT);
      expect(getActionHint).not.toHaveBeenCalled();
    });

    test('evaluate never carries known (readers are offered by the start pack)', async () => {
      const getActionHint = vi.fn(() => HINT);
      const deps = makeDeps({
        listTabs: vi.fn(() => [TAB]),
        callBrowserTool: vi.fn(async () => 'raw value'),
        getActionHint: getActionHint as unknown as BrowserToolDeps['getActionHint'],
      });
      const out = await handleBrowserTool(
        'browser.evaluate',
        { tab_id: 'tab_1', expression: 'document.title' },
        deps,
        TEST_CALLER,
      );
      expect(out).toBe('raw value');
      expect(getActionHint).not.toHaveBeenCalled();
    });
  });

  test('the learner receives the tab build and view signature', async () => {
    const recordOutcome = vi.fn();
    const deps = makeDeps({
      listTabs: vi.fn(() => [{ ...TAB, build: '3f9a2b1c', view_sig: '00aa11bb' }]),
      callBrowserTool: vi.fn(async () => ({ ok: true })),
      recordOutcome,
    });
    await handleBrowserTool(
      'browser.click',
      { tab_id: 'tab_1', selector: '#pay' },
      deps,
      TEST_CALLER,
    );
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ build: '3f9a2b1c', viewSig: '00aa11bb' }),
    );
  });
});

describe('knowledge loop: wrap_up, read, feedback and the flow/evaluate shortcuts (S9-S12)', () => {
  let dataDir: string;
  const ORIGIN = 'https://app.test';
  const TAB = { tab_id: 'tab_1', url: `${ORIGIN}/clients/42`, title: 'Clients' };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'browser-link-dispatch-knowledge-'));
    process.env.BROWSER_LINK_DATA_DIR = dataDir;
    resetSessions();
    clearTypedValues();
  });

  afterEach(() => {
    closeMapDb();
    closeActivityDb();
    resetSessions();
    clearTypedValues();
    delete process.env.BROWSER_LINK_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  function deps(callBrowserTool: BrowserToolDeps['callBrowserTool']): BrowserToolDeps {
    return makeDeps({ listTabs: vi.fn(() => [TAB]), callBrowserTool });
  }

  function keptReader(expression: string, name: string, template: string | null = null): number {
    const db = getMapDb();
    const app = resolveLearnerApp(db, ORIGIN);
    const row = upsertReader(db, { appId: app.id, expression, ok: true })!;
    setReaderStatus(db, row.id, 'kept', name);
    setReaderTemplate(db, row.id, template);
    return row.id;
  }

  test('catalogue names: wrap_up, read and feedback are browser tools with definitions', () => {
    for (const name of ['browser.wrap_up', 'browser.read', 'browser.feedback']) {
      expect(isBrowserTool(name)).toBe(true);
      expect(BROWSER_TOOL_DEFINITIONS.some((d) => d.name === name)).toBe(true);
    }
    const feedback = BROWSER_TOOL_DEFINITIONS.find((d) => d.name === 'browser.feedback')!;
    const schema = feedback.inputSchema as { required: string[]; properties: object };
    expect(schema.required).toEqual(['tool', 'observed', 'expected']);
    expect(Object.keys(schema.properties).sort()).toEqual(['expected', 'observed', 'tool']);
  });

  test('wrap_up step 1 reports the tab app; step 2 keeps a reader and resets pending work', async () => {
    const db = getMapDb();
    const app = resolveLearnerApp(db, ORIGIN);
    const row = upsertReader(db, { appId: app.id, expression: 'document.title', ok: true })!;
    notePendingWork(TEST_CALLER.agent_id);
    const step1 = (await handleBrowserTool('browser.wrap_up', {}, deps(vi.fn()), TEST_CALLER)) as {
      step: number;
      apps: { origin: string; readers: { id: number }[] }[];
    };
    expect(step1.step).toBe(1);
    expect(step1.apps.map((a) => a.origin)).toEqual([ORIGIN]);
    expect(step1.apps[0].readers.map((r) => r.id)).toEqual([row.id]);

    const step2 = (await handleBrowserTool(
      'browser.wrap_up',
      { readers: { keep: [{ id: row.id, name: 'page-title' }] } },
      deps(vi.fn()),
      TEST_CALLER,
    )) as { step: number; applied: unknown[]; rejected: unknown[] };
    expect(step2).toEqual({
      step: 2,
      applied: [{ item: `reader #${row.id}`, action: 'kept', name: 'page-title' }],
      rejected: [],
    });
    expect(peekSession(TEST_CALLER.agent_id)?.pendingWrapUp).toBe(0);
  });

  test('wrap_up step 2 rejects by rule and stores feedback in the activity DB', async () => {
    const result = (await handleBrowserTool(
      'browser.wrap_up',
      {
        readers: { keep: [{ id: 999, name: 'get-total' }] },
        feedback: [{ tool: 'browser.find', observed: 'two shapes', expected: 'one shape' }],
      },
      deps(vi.fn()),
      TEST_CALLER,
    )) as { applied: { item: string }[]; rejected: { rule: number }[] };
    expect(result.rejected).toEqual([expect.objectContaining({ item: 'reader #999', rule: 1 })]);
    expect(result.applied).toEqual([{ item: 'feedback[0]', action: 'saved' }]);
    expect(listFeedback(getActivityDb())).toEqual([
      expect.objectContaining({ tool: 'browser.find', agentId: TEST_CALLER.agent_id }),
    ]);
  });

  test('wrap_up refuses a malformed body before writing anything', async () => {
    await expect(
      handleBrowserTool(
        'browser.wrap_up',
        { readers: { keep: 'all' } },
        deps(vi.fn()),
        TEST_CALLER,
      ),
    ).rejects.toThrow(/readers\.keep must be an array/);
  });

  test('read by name runs the kept expression and counts the outcome', async () => {
    const id = keptReader('document.title', 'page-title');
    const call = vi.fn(async () => 'Clients');
    const value = await handleBrowserTool(
      'browser.read',
      { tab_id: 'tab_1', name: 'page-title' },
      deps(call),
      TEST_CALLER,
    );
    expect(value).toBe('Clients');
    expect(call).toHaveBeenCalledWith('tab_1', 'evaluate', { expression: 'document.title' });
    expect(getReader(getMapDb(), id)?.ok_n).toBe(2);
  });

  test('read by id fills the template placeholders, escaped for a string literal', async () => {
    const id = keptReader(
      `document.querySelector('[title="Juan Perez"]').textContent`,
      'client-cell',
      `document.querySelector('[title="<CLIENT>"]').textContent`,
    );
    const call = vi.fn(async () => '12');
    await handleBrowserTool(
      'browser.read',
      { tab_id: 'tab_1', id, values: { CLIENT: 'O"Brien' } },
      deps(call),
      TEST_CALLER,
    );
    expect(call).toHaveBeenCalledWith('tab_1', 'evaluate', {
      expression: `document.querySelector('[title="O\\"Brien"]').textContent`,
    });
  });

  test('read refuses a missing placeholder, an unknown name and a pending reader', async () => {
    keptReader(`q("Juan Perez")`, 'client-row', `q("<CLIENT>")`);
    const call = vi.fn();
    await expect(
      handleBrowserTool(
        'browser.read',
        { tab_id: 'tab_1', name: 'client-row' },
        deps(call),
        TEST_CALLER,
      ),
    ).rejects.toThrow(/missing value for <CLIENT>/);
    await expect(
      handleBrowserTool('browser.read', { tab_id: 'tab_1', name: 'nope' }, deps(call), TEST_CALLER),
    ).rejects.toThrow(/no kept reader "nope".*kept: client-row/);
    const db = getMapDb();
    const pending = upsertReader(db, {
      appId: resolveLearnerApp(db, ORIGIN).id,
      expression: 'location.href',
      ok: true,
    })!;
    await expect(
      handleBrowserTool(
        'browser.read',
        { tab_id: 'tab_1', id: pending.id },
        deps(call),
        TEST_CALLER,
      ),
    ).rejects.toThrow(/no kept reader #/);
    await expect(
      handleBrowserTool('browser.read', { tab_id: 'tab_1' }, deps(call), TEST_CALLER),
    ).rejects.toThrow(/exactly one of name or id/);
    expect(call).not.toHaveBeenCalled();
  });

  test('a failing read counts a failure on the reader', async () => {
    const id = keptReader('document.title', 'page-title');
    const call = vi.fn(async () => {
      throw new Error('ReferenceError');
    });
    await expect(
      handleBrowserTool(
        'browser.read',
        { tab_id: 'tab_1', name: 'page-title' },
        deps(call),
        TEST_CALLER,
      ),
    ).rejects.toThrow(/ReferenceError/);
    expect(getReader(getMapDb(), id)?.fail_n).toBe(1);
  });

  test('flow by name runs the saved steps with values filled and counts the use', async () => {
    saveFlow({
      origin: ORIGIN,
      app_key: resolveLearnerApp(getMapDb(), ORIGIN).app_key,
      name: 'search',
      steps: [{ type: { selector: '#q', text: '<QUERY>' } }, { press: { key: 'Enter' } }],
    });
    const call = vi.fn(async () => ({ ok: true, steps_completed: 2, results: [] }));
    await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', name: 'search', values: { QUERY: 'shrek' } },
      deps(call),
      TEST_CALLER,
    );
    const sent = (call.mock.calls[0] as unknown[])[2] as { steps: unknown[] };
    expect(sent.steps[0]).toEqual({ type: { selector: '#q', text: 'shrek' } });
    const flows = listFlows(resolveLearnerApp(getMapDb(), ORIGIN).id);
    expect(flows[0].use_count).toBe(1);
    const session = peekSession(TEST_CALLER.agent_id)!;
    expect(session.flows[0]).toMatchObject({
      saved_name: 'search',
      ok: true,
      steps: [{ type: { selector: '#q', text: '<QUERY>' } }, { press: { key: 'Enter' } }],
    });
  });

  test('flow by name refuses a missing value or an unknown flow before anything runs', async () => {
    saveFlow({
      origin: ORIGIN,
      app_key: resolveLearnerApp(getMapDb(), ORIGIN).app_key,
      name: 'search',
      steps: [{ type: { selector: '#q', text: '<QUERY>' } }],
    });
    const call = vi.fn();
    await expect(
      handleBrowserTool(
        'browser.flow',
        { tab_id: 'tab_1', name: 'search' },
        deps(call),
        TEST_CALLER,
      ),
    ).rejects.toThrow(/missing value for <QUERY>/);
    await expect(
      handleBrowserTool(
        'browser.flow',
        { tab_id: 'tab_1', name: 'other' },
        deps(call),
        TEST_CALLER,
      ),
    ).rejects.toThrow(/no saved flow "other".*saved: search/);
    expect(call).not.toHaveBeenCalled();
  });

  test('an inline flow with name and values is recorded as a named template candidate', async () => {
    const call = vi.fn(async () => ({ ok: true, steps_completed: 1, results: [] }));
    await handleBrowserTool(
      'browser.flow',
      {
        tab_id: 'tab_1',
        name: 'search-box',
        steps: [{ type: { selector: '#q', text: '<QUERY>' } }],
        values: { QUERY: 'shrek' },
      },
      deps(call),
      TEST_CALLER,
    );
    const sent = (call.mock.calls[0] as unknown[])[2] as { steps: unknown[] };
    expect(sent.steps).toEqual([{ type: { selector: '#q', text: 'shrek' } }]);
    expect(peekSession(TEST_CALLER.agent_id)?.flows[0]).toMatchObject({
      name: 'search-box',
      origin: ORIGIN,
      steps: [{ type: { selector: '#q', text: '<QUERY>' } }],
    });
    // Nothing is saved before wrap_up.
    expect(listFlows(resolveLearnerApp(getMapDb(), ORIGIN).id)).toEqual([]);
  });

  test('an inline flow without values runs its steps untouched', async () => {
    const call = vi.fn(async () => ({ ok: true, steps_completed: 1, results: [] }));
    await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps: [{ type: { selector: '#q', text: '<keep me>' } }] },
      deps(call),
      TEST_CALLER,
    );
    const sent = (call.mock.calls[0] as unknown[])[2] as { steps: unknown[] };
    expect(sent.steps).toEqual([{ type: { selector: '#q', text: '<keep me>' } }]);
  });

  test('evaluate as: a bad name is refused before running; a good one is not forwarded', async () => {
    const call = vi.fn(async () => 1);
    await expect(
      handleBrowserTool(
        'browser.evaluate',
        { tab_id: 'tab_1', expression: '1', as: 'getTotal' },
        deps(call),
        TEST_CALLER,
      ),
    ).rejects.toThrow(/rule 4/);
    expect(call).not.toHaveBeenCalled();
    await handleBrowserTool(
      'browser.evaluate',
      { tab_id: 'tab_1', expression: '1', as: 'invoice-total' },
      deps(call),
      TEST_CALLER,
    );
    expect(call).toHaveBeenCalledWith('tab_1', 'evaluate', { expression: '1' });
  });

  test('feedback is stored locally with the session app; typed values are refused', async () => {
    const result = await handleBrowserTool(
      'browser.feedback',
      { tool: 'browser.find', observed: 'matched twice', expected: 'one match' },
      deps(vi.fn()),
      TEST_CALLER,
    );
    expect(result).toEqual({ id: expect.any(Number), stored: 'local' });
    expect(listFeedback(getActivityDb())[0]).toMatchObject({
      tool: 'browser.find',
      observed: 'matched twice',
      agentId: TEST_CALLER.agent_id,
    });
    rememberTypedValue('acme corp');
    await expect(
      handleBrowserTool(
        'browser.feedback',
        { tool: 'browser.find', observed: 'acme corp twice', expected: 'one' },
        deps(vi.fn()),
        TEST_CALLER,
      ),
    ).rejects.toThrow(/rule 7/);
    await expect(
      handleBrowserTool(
        'browser.feedback',
        { tool: 'browser.find', observed: '', expected: 'one' },
        deps(vi.fn()),
        TEST_CALLER,
      ),
    ).rejects.toThrow(/observed must be a non-empty string/);
  });
});
