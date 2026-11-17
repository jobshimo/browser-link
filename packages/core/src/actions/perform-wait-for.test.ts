// performWaitFor on fakes (slice 13): the poll loop on the clock, a timeout
// as an ordinary result, a cancelled wait, and the `network_url` mode and
// its `capture-buffers` requirement.
import { describe, expect, test } from 'vitest';
import { createManualClock, type ManualClock } from '../ports/contract/index.js';
import type { CaptureWatch } from '../session/page-driver.js';
import { TOOL_REGISTRY } from '../tools/catalog.js';
import { dispatchTool } from '../tools/registry.js';
import type { Requirement, ToolDeps } from '../tools/requirement.js';
import {
  NETWORK_URL_UNSUPPORTED_MESSAGE,
  performWaitFor,
  type WaitForDeps,
} from './perform-wait-for.js';

/** Let every pending promise continuation run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Run `wait` to its end, advancing the clock a poll at a time. */
async function drive<T>(clock: ManualClock, wait: Promise<T>, stepMs = 100): Promise<T> {
  let done = false;
  const result = wait.finally(() => {
    done = true;
  });
  for (let i = 0; i < 1000 && !done; i++) {
    await flush();
    await clock.advance(stepMs);
  }
  return result;
}

function deps(
  clock: ManualClock,
  answers: unknown[],
  captureBuffers?: CaptureWatch,
): { deps: WaitForDeps; evaluated: string[] } {
  const evaluated: string[] = [];
  let i = 0;
  return {
    evaluated,
    deps: {
      clock,
      captureBuffers,
      evaluator: {
        evaluate: <T>(expression: string): Promise<T> => {
          evaluated.push(expression);
          const answer = answers[Math.min(i++, answers.length - 1)];
          return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as T);
        },
      },
    },
  };
}

describe('performWaitFor', () => {
  test('a match on the first poll is a result with one check', async () => {
    const clock = createManualClock();
    const { deps: d } = deps(clock, [true]);
    expect(await performWaitFor(d, { selector: '#go' })).toEqual({
      ok: true,
      result: { matched: true, elapsed_ms: 0, checks: 1 },
    });
  });

  test('a timeout is an ordinary result, not a failure', async () => {
    const clock = createManualClock();
    const { deps: d } = deps(clock, [false]);
    const outcome = await drive(
      clock,
      performWaitFor(d, { expression: 'false', timeout_ms: 250, poll_interval_ms: 100 }),
    );
    expect(outcome).toEqual({
      ok: true,
      result: { matched: false, elapsed_ms: 300, checks: 4, reason: 'timeout' },
    });
  });

  test('a page that throws mid-poll counts as not yet matched', async () => {
    const clock = createManualClock();
    const { deps: d } = deps(clock, [new Error('gone'), true]);
    const outcome = await drive(clock, performWaitFor(d, { selector: '#go' }));
    expect(outcome).toEqual({
      ok: true,
      result: { matched: true, elapsed_ms: 100, checks: 2 },
    });
  });

  test('the timeout and the poll interval are clamped to 30 s and 50..1000 ms', async () => {
    const clock = createManualClock();
    const { deps: d } = deps(clock, [false]);
    const outcome = await drive(
      clock,
      performWaitFor(d, { selector: '#go', timeout_ms: 1_000_000, poll_interval_ms: 1 }),
      50,
    );
    expect(outcome).toMatchObject({
      ok: true,
      result: { matched: false, elapsed_ms: 30_000, checks: 601, reason: 'timeout' },
    });
  });

  test('the cancel flag cuts the wait short as `cancelled`, not a timeout', async () => {
    const clock = createManualClock();
    const { deps: d } = deps(clock, [false]);
    let polls = 0;
    const outcome = await drive(
      clock,
      performWaitFor(d, { selector: '#go', timeout_ms: 30_000 }, () => ++polls > 2),
    );
    expect(outcome).toEqual({
      ok: true,
      result: { matched: false, elapsed_ms: 200, checks: 2, reason: 'cancelled' },
    });
  });

  test('a ref on a page with no observer fails with the owner sentence', async () => {
    const clock = createManualClock();
    const { deps: d } = deps(clock, [{ reason: 'observer-unavailable' }]);
    const outcome = await performWaitFor(d, { ref: 'd1:e2' });
    expect(outcome.ok).toBe(false);
  });

  test('a ref of another document fails at once; a gone element keeps the timeout shape', async () => {
    const clock = createManualClock();
    const other = deps(clock, [{ reason: 'ref-stale', doc_id: 'd2', doc_changed: true }]);
    expect((await performWaitFor(other.deps, { ref: 'd1:e2' })).ok).toBe(false);
    const gone = deps(clock, [{ reason: 'ref-stale', doc_id: 'd1' }]);
    const outcome = await drive(
      clock,
      performWaitFor(gone.deps, { ref: 'd1:e2', timeout_ms: 100, poll_interval_ms: 100 }),
    );
    expect(outcome).toMatchObject({
      ok: true,
      result: { matched: false, reason: 'timeout', ref_gone: expect.stringContaining('d1:e2') },
    });
  });
});

describe('wait_for network_url mode and the capture-buffers requirement', () => {
  const finished = (...urls: string[]): CaptureWatch => ({ finishedUrls: () => urls });

  test('matches a finished request by URL, ignoring case', async () => {
    const clock = createManualClock();
    const { deps: d, evaluated } = deps(clock, [false], finished('https://x.test/API/users'));
    expect(await performWaitFor(d, { network_url: '/api/' })).toEqual({
      ok: true,
      result: { matched: true, elapsed_ms: 0, checks: 1 },
    });
    expect(evaluated).toEqual([]);
  });

  test('without capture buffers it fails with the cdp-direct text, before any poll', async () => {
    const clock = createManualClock();
    const { deps: d, evaluated } = deps(clock, [true]);
    expect(await performWaitFor(d, { network_url: '/api' })).toEqual({
      ok: false,
      error: NETWORK_URL_UNSUPPORTED_MESSAGE,
    });
    expect(NETWORK_URL_UNSUPPORTED_MESSAGE).toBe(
      'wait_for: network_url mode is not supported over cdp-direct in v1 (no network buffering) — use a tab connected through the Chrome extension instead.',
    );
    expect(evaluated).toEqual([]);
  });

  test('through the registry a transport that does not provide them refuses the mode only', async () => {
    const clock = createManualClock();
    const { deps: d, evaluated } = deps(clock, [true]);
    const toolDeps = d as ToolDeps;
    const cdp = new Set<Requirement>(['evaluator']);
    expect(
      await dispatchTool(TOOL_REGISTRY, cdp, toolDeps, 'cdp-direct', 'wait_for', {
        network_url: '/api',
      }),
    ).toEqual({ ok: false, failure: { kind: 'action', message: NETWORK_URL_UNSUPPORTED_MESSAGE } });
    expect(evaluated).toEqual([]);
    expect(
      await dispatchTool(TOOL_REGISTRY, cdp, toolDeps, 'cdp-direct', 'wait_for', {
        selector: '#go',
      }),
    ).toEqual({ ok: true, result: { matched: true, elapsed_ms: 0, checks: 1 } });
  });

  test('a transport that provides them runs the mode through the registry', async () => {
    const clock = createManualClock();
    const { deps: d } = deps(clock, [false], finished('https://x.test/api'));
    const provided = new Set<Requirement>(['evaluator', 'capture-buffers']);
    expect(
      await dispatchTool(TOOL_REGISTRY, provided, d as ToolDeps, 'extension', 'wait_for', {
        network_url: 'API',
      }),
    ).toEqual({ ok: true, result: { matched: true, elapsed_ms: 0, checks: 1 } });
  });
});
