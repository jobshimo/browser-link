import { describe, expect, test, vi } from 'vitest';
import { MAX_FLOW_STEPS, runFlow, type FlowDeps, type FlowStep } from './flow.js';

/* Local execution coverage of the server's verbatim flow copy — sequencing,
 * implicit-target threading, fail-fast — with fully faked perform* deps (no
 * CDP client needed). */

function fakeDeps(overrides: Partial<FlowDeps> = {}): FlowDeps {
  return {
    performFind: vi.fn(async () => ({ ok: true, result: { matched: true, selector: '#found' } })),
    performClick: vi.fn(async () => ({ ok: true, result: { clicked: '#x', tag: 'button' } })),
    performType: vi.fn(async () => ({ ok: true, result: { typed: 2 } })),
    performPress: vi.fn(async () => ({ ok: true, result: { key: 'Enter', modifiers: [] } })),
    performWaitFor: vi.fn(async () => ({
      ok: true,
      result: { matched: true, elapsed_ms: 1, checks: 1 },
    })),
    buildRecoverySnapshot: vi.fn(async () => ({ interactive: [] })),
    ...overrides,
  };
}

describe('runFlow', () => {
  test('rejects an empty step array', async () => {
    const result = await runFlow([], fakeDeps());
    expect(result.ok).toBe(false);
  });

  test('rejects more than MAX_FLOW_STEPS steps', async () => {
    const steps = Array.from({ length: MAX_FLOW_STEPS + 1 }, () => ({
      press: { key: 'a' },
    })) as FlowStep[];
    const result = await runFlow(steps, fakeDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(new RegExp(`${MAX_FLOW_STEPS}`));
  });

  test('rejects an unknown step shape', async () => {
    const result = await runFlow([{ mystery: {} } as unknown as FlowStep], fakeDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.step_kind).toBe('unknown');
  });

  test('threads a find selector as the implicit target for the next click', async () => {
    const deps = fakeDeps();
    const result = await runFlow([{ find: { text: 'Save' } }, { click: {} }], deps);
    expect(result.ok).toBe(true);
    expect(deps.performClick).toHaveBeenCalledWith(expect.objectContaining({ selector: '#found' }));
  });

  test('fails fast: a failing step stops the flow and returns a recovery snapshot', async () => {
    const deps = fakeDeps({
      performClick: vi.fn(async () => ({ ok: false, error: 'Element not found: #x' })),
    });
    const result = await runFlow(
      [{ click: { selector: '#x' } }, { press: { key: 'Enter' } }],
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failed_step).toBe(0);
      expect(result.error).toMatch(/Element not found/);
      expect(result.recovery_snapshot).toEqual({ interactive: [] });
    }
    expect(deps.performPress).not.toHaveBeenCalled();
  });

  test('a wait_for non-match stops the flow', async () => {
    const deps = fakeDeps({
      performWaitFor: vi.fn(async () => ({
        ok: true,
        result: { matched: false, elapsed_ms: 5000, checks: 50 },
      })),
    });
    const result = await runFlow([{ wait_for: { selector: '#late' } }], deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/condition not met/);
  });
});
