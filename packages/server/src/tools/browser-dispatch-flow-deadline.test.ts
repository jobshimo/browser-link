import { describe, expect, test, vi } from 'vitest';
import { handleBrowserTool, type BrowserToolDeps } from './browser-dispatch.js';
import type { AgentCaller } from './tab-claims.js';

function makeDeps(overrides: Partial<BrowserToolDeps> = {}): BrowserToolDeps {
  return {
    listTabs: vi.fn(() => []),
    callBrowserTool: vi.fn(async () => undefined),
    ...overrides,
  };
}

const TEST_CALLER: AgentCaller = { agent_id: 'test-caller', pid: 0, binary: 'node' };

const flowCall = (deps: BrowserToolDeps): unknown[] =>
  (deps.callBrowserTool as ReturnType<typeof vi.fn>).mock.calls.find(
    (c) => c[1] === 'flow',
  ) as unknown[];

describe('browser.flow worst-case budget', () => {
  test('a step settle_timeout_ms replaces the default settle ceiling in the budget', async () => {
    const deps = makeDeps();
    // 2_000 + 5 * (8_000 + 500) = 44_500
    const steps = Array.from({ length: 5 }, () => ({
      click: { selector: '#a', settle_timeout_ms: 8_000 },
    }));
    await handleBrowserTool('browser.flow', { tab_id: 'tab_1', steps }, deps, TEST_CALLER);
    expect(flowCall(deps)[3]).toBe(44_500);
  });

  test('settle_timeout_ms is ignored when the step disables settle', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.flow',
      {
        tab_id: 'tab_1',
        steps: Array.from({ length: 20 }, () => ({
          press: { key: 'a', settle_ms: 0, settle_timeout_ms: 10_000 },
        })),
      },
      deps,
      TEST_CALLER,
    );
    // 2_000 + 20 * 500 = 12_000 -> floored
    expect(flowCall(deps)[3]).toBe(15_000);
  });

  test('a repeat multiplies the settle ceiling and the delay by max_iterations', async () => {
    const deps = makeDeps();
    // 2_000 + 14 * (2_500 + 500 + 450) = 50_300
    await handleBrowserTool(
      'browser.flow',
      {
        tab_id: 'tab_1',
        steps: [
          {
            repeat: {
              max_iterations: 14,
              delay_ms: 450,
              steps: [{ click: { selector: '#a', settle_ms: 650, settle_timeout_ms: 2_500 } }],
            },
          },
        ],
      },
      deps,
      TEST_CALLER,
    );
    expect(flowCall(deps)[3]).toBe(50_300);
  });

  test('rejects a settle_timeout_ms outside 0..10000', async () => {
    const deps = makeDeps();
    await expect(
      handleBrowserTool(
        'browser.flow',
        { tab_id: 'tab_1', steps: [{ click: { selector: '#a', settle_timeout_ms: 20_000 } }] },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/settle_timeout_ms must be a number between 0 and 10000/);
  });
});

describe('browser.flow deadline', () => {
  test('passes the runner a deadline shorter than the bridge timeout', async () => {
    const deps = makeDeps();
    await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps: [{ press: { key: 'a' } }] },
      deps,
      TEST_CALLER,
    );
    const call = flowCall(deps);
    expect(call[3]).toBe(15_000);
    expect((call[2] as { deadline_ms: number }).deadline_ms).toBe(12_000);
  });

  test('a dry run and a detached launch carry no deadline', async () => {
    for (const flag of [{ dry_run: true }, { detach: true }]) {
      const deps = makeDeps();
      await handleBrowserTool(
        'browser.flow',
        { tab_id: 'tab_1', steps: [{ press: { key: 'a' } }], ...flag },
        deps,
        TEST_CALLER,
      );
      expect(flowCall(deps)[2]).not.toHaveProperty('deadline_ms');
    }
  });
});

describe('browser.flow bridge timeout recovery', () => {
  const timeoutError = new Error("Tool 'flow' timed out after 15000ms");

  function makeStuckDeps(status: unknown): {
    deps: BrowserToolDeps;
    cancelFlow: ReturnType<typeof vi.fn>;
  } {
    const cancelFlow = vi.fn();
    const deps = makeDeps({
      cancelFlow,
      callBrowserTool: vi.fn((_tab: string, tool: string) => {
        if (tool === 'flow') return Promise.reject(timeoutError);
        return status instanceof Error ? Promise.reject(status) : Promise.resolve(status);
      }),
    });
    return { deps, cancelFlow };
  }

  test('answers with the registry progress and the flow_id instead of a bare error', async () => {
    const { deps, cancelFlow } = makeStuckDeps({
      flow_id: 'x',
      state: 'running',
      steps: 5,
      steps_completed: 3,
      iterations_completed: 2,
    });
    const result = (await handleBrowserTool(
      'browser.flow',
      { tab_id: 'tab_1', steps: [{ press: { key: 'a' } }] },
      deps,
      TEST_CALLER,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      stopped_by: 'timeout',
      steps_completed: 3,
      iterations_completed: 2,
      results_available: false,
      flow_id: expect.stringMatching(/^flow_/),
    });
    // The runner is stuck inside a step: tell it to stop so it does not
    // keep acting after the agent was told the flow ended.
    expect(cancelFlow).toHaveBeenCalledWith('tab_1', result.flow_id, 'expired');
  });

  test('rethrows the original error, tagged with the flow_id, when the status read fails', async () => {
    const { deps } = makeStuckDeps(new Error('bridge gone'));
    await expect(
      handleBrowserTool(
        'browser.flow',
        { tab_id: 'tab_1', steps: [{ press: { key: 'a' } }] },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/timed out after 15000ms.*flow_/);
  });

  test.each([
    ['an unknown flow (already finished and gone from the registry)', { state: 'unknown' }],
    ['a status without a step count', { state: 'running' }],
    ['a finished state', { state: 'completed', steps_completed: 4 }],
  ])('never invents a step count: %s rethrows tagged with the flow_id', async (_n, status) => {
    const { deps } = makeStuckDeps(status);
    await expect(
      handleBrowserTool(
        'browser.flow',
        { tab_id: 'tab_1', steps: [{ press: { key: 'a' } }] },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/timed out after 15000ms.*flow_/);
  });

  test('a cdp-direct client timeout is a transport failure, not a flow timeout', async () => {
    const callCdpTool = vi.fn((_tab: string, tool: string) =>
      tool === 'flow'
        ? Promise.reject(
            new Error('cdp-direct: command "Runtime.evaluate" timed out after 15000ms'),
          )
        : Promise.resolve({ state: 'running', steps_completed: 2 }),
    );
    const deps = makeDeps({
      cdpGate: () => ({ ok: true as const }),
      callCdpTool,
    });
    await expect(
      handleBrowserTool(
        'browser.flow',
        { tab_id: 'cdp:ABC', steps: [{ press: { key: 'a' } }] },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow(/cdp-direct: command "Runtime.evaluate" timed out/);
    expect(callCdpTool).toHaveBeenCalledTimes(1);
  });

  test('only the bridge message for the flow tool counts as a flow timeout', async () => {
    const deps = makeDeps({
      callBrowserTool: vi.fn(() => Promise.reject(new Error("Tool 'click' timed out after 5ms"))),
    });
    await expect(
      handleBrowserTool(
        'browser.flow',
        { tab_id: 'tab_1', steps: [{ press: { key: 'a' } }] },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow("Tool 'click' timed out");
  });

  test('a non-timeout failure is not rewritten', async () => {
    const deps = makeDeps({
      callBrowserTool: vi.fn(() => Promise.reject(new Error('Tab not connected'))),
    });
    await expect(
      handleBrowserTool(
        'browser.flow',
        { tab_id: 'tab_1', steps: [{ press: { key: 'a' } }] },
        deps,
        TEST_CALLER,
      ),
    ).rejects.toThrow('Tab not connected');
  });
});
