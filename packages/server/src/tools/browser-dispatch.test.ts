import { describe, expect, test, vi } from 'vitest';
import { type BrowserToolDeps, handleBrowserTool, isBrowserTool } from './browser-dispatch.js';
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
      'browser.click',
      'browser.type',
      'browser.press',
      'browser.drag',
      'browser.flow',
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
      { steps },
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
        { steps },
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
      ).rejects.toThrow(/must have exactly one of find \| click \| type \| press \| wait_for/);
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
      ).rejects.toThrow(/must have exactly one of find \| click \| type \| press \| wait_for/);
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
        { steps },
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
        { steps },
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
        { steps },
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
      ).rejects.toThrow(/must have exactly one of find \| click \| type \| press \| wait_for/);
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
          { steps },
          expect.any(Number),
        );
      }
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
        /worst-case budget 612s exceeds the 60s ceiling — reduce wait_for timeout_ms values or split the flow/,
      );
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

  test('is registered with tab_id and steps as required properties', () => {
    expect(def).toBeDefined();
    const schema = def!.inputSchema as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['tab_id', 'steps']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.tab_id).toBeDefined();
    expect(schema.properties.steps).toBeDefined();
  });

  test('steps is an array capped at 20 items, each a oneOf of the 5 step kinds', () => {
    const stepsSchema = (
      def!.inputSchema as {
        properties: { steps: { type: string; minItems: number; maxItems: number; items: unknown } };
      }
    ).properties.steps;
    expect(stepsSchema.type).toBe('array');
    expect(stepsSchema.minItems).toBe(1);
    expect(stepsSchema.maxItems).toBe(20);
    const oneOf = (stepsSchema.items as { oneOf: { required: string[] }[] }).oneOf;
    expect(oneOf).toHaveLength(5);
    expect(oneOf.map((v) => v.required[0]).sort()).toEqual([
      'click',
      'find',
      'press',
      'type',
      'wait_for',
    ]);
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
      'selector',
    ]);
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
