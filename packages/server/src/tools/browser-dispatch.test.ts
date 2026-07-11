import { describe, expect, test, vi } from 'vitest';
import { type BrowserToolDeps, handleBrowserTool, isBrowserTool } from './browser-dispatch.js';
import { BridgeEventLog } from '../bridge/events.js';
import { TabClaimRegistry, type AgentCaller } from './tab-claims.js';

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
      'browser.canvas_screenshot',
      'browser.click',
      'browser.type',
      'browser.drag',
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
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'type', {
      selector: '#x',
      text: 'hi',
      clear: false,
    });
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
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'click', {
      selector: '#go',
      force: false,
    });
  });

  test('click forwards force:true when the caller opts out of the occlusion guard', async () => {
    const deps = makeDepsWithClaims();
    await handleBrowserTool(
      'browser.click',
      { tab_id: 'tab_1', selector: '#go', force: true },
      deps,
      A,
    );
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'click', {
      selector: '#go',
      force: true,
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
