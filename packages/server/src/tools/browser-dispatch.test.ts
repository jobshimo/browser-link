import { describe, expect, test, vi } from 'vitest';
import { type BrowserToolDeps, handleBrowserTool, isBrowserTool } from './browser-dispatch.js';
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
    expect(deps.callBrowserTool).toHaveBeenCalledWith('tab_1', 'click', { selector: '#go' });
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
});
