import { describe, expect, test } from 'vitest';
import {
  MAX_DETACHED_FLOW_RECORDS,
  MAX_DETACHED_MANIFEST_BYTES,
  MAX_FLOW_HISTORY_PER_TAB,
  MAX_MINIMAL_RECORD_ERROR_CHARS,
  appendFlowHistory,
  createFlowRegistry,
  describeFlowHistoryEntry,
  describeFlowProgress,
  detachedFlowKey,
  detachedFlowRecordsToEvict,
  finishedDetachedFlowRecord,
  flowHistoryKey,
  flowIdFromDetachedFlowKey,
  flowTabLabel,
  formatFlowDuration,
  minimalDetachedFlowRecord,
  parseDetachedFlowRecord,
  parseFlowHistory,
  startedDetachedFlowRecord,
  summarizeFlow,
  terminatedDetachedFlowRecord,
  terminatedFlowHistoryEntry,
  toFlowStatus,
  toHistoryEntry,
  type FlowHistoryEntry,
  type FlowRegistryEntry,
} from './flow-registry.js';
import type { FlowResult } from './flow.js';

/**
 * The in-flight registry and the flow history behind the popup's Flows
 * panel. Pure — no `chrome.*`, no service worker — which is the whole
 * reason this logic lives outside `background.ts`.
 *
 * The privacy assertions here are the important ones: a history entry is
 * the only part of the kill switch that gets PERSISTED, and the rule (same
 * as the persistent map's) is UI structure and outcomes only.
 */

function entryFor(overrides: Partial<FlowRegistryEntry> = {}): FlowRegistryEntry {
  return {
    flowId: 'flow_abc',
    tabId: 7,
    title: 'Cardmarket — Wants',
    startedAt: 1_000,
    steps: 3,
    cancelled: false,
    progress: { step: 2, steps: 3 },
    detached: false,
    ...overrides,
  };
}

describe('flow registry — lifecycle', () => {
  test('a registered flow is listed as running with its starting progress', () => {
    const registry = createFlowRegistry();
    registry.register({ flowId: 'f1', tabId: 3, steps: 4, title: 'Inbox' });

    const running = registry.listRunning(Date.now());
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({
      flowId: 'f1',
      tabId: 3,
      title: 'Inbox',
      steps: 4,
      // "not started yet", never a fake step 1.
      step: 0,
      cancelling: false,
    });
  });

  test('finish removes the flow and hands back its final entry', () => {
    const registry = createFlowRegistry();
    registry.register({ flowId: 'f1', tabId: 3, steps: 2 });
    const finished = registry.finish('f1');

    expect(finished?.flowId).toBe('f1');
    expect(registry.listRunning(Date.now())).toEqual([]);
    expect(registry.get('f1')).toBeUndefined();
  });

  test('cancel flips a running flow and reports that it did', () => {
    const registry = createFlowRegistry();
    registry.register({ flowId: 'f1', tabId: 3, steps: 2 });

    expect(registry.cancel('f1')).toBe(true);
    expect(registry.get('f1')?.cancelled).toBe(true);
    // The entry stays listed while the runner walks to its next check —
    // that is the "Stopping…" state the popup renders.
    expect(registry.listRunning(Date.now())[0]?.cancelling).toBe(true);
  });

  test('cancelling an unknown flow_id is a clean no-op, not an error', () => {
    const registry = createFlowRegistry();
    expect(registry.cancel('never-existed')).toBe(false);
    expect(registry.listRunning(Date.now())).toEqual([]);
  });

  test('cancelling an already-finished flow_id is a clean no-op', () => {
    const registry = createFlowRegistry();
    registry.register({ flowId: 'f1', tabId: 3, steps: 2 });
    registry.finish('f1');
    expect(registry.cancel('f1')).toBe(false);
  });

  test('a second Stop press reports false without disturbing the first', () => {
    const registry = createFlowRegistry();
    registry.register({ flowId: 'f1', tabId: 3, steps: 2 });
    expect(registry.cancel('f1')).toBe(true);
    expect(registry.cancel('f1')).toBe(false);
    expect(registry.get('f1')?.cancelled).toBe(true);
  });

  test('cancelForTab stops only that tab’s flows', () => {
    const registry = createFlowRegistry();
    registry.register({ flowId: 'a', tabId: 1, steps: 1 });
    registry.register({ flowId: 'b', tabId: 1, steps: 1 });
    registry.register({ flowId: 'c', tabId: 2, steps: 1 });

    expect(registry.cancelForTab(1)).toBe(2);
    expect(registry.get('a')?.cancelled).toBe(true);
    expect(registry.get('b')?.cancelled).toBe(true);
    expect(registry.get('c')?.cancelled).toBe(false);
    // Already cancelled — nothing left to flip.
    expect(registry.cancelForTab(1)).toBe(0);
  });

  test('lists concurrent flows across different tabs, oldest first', () => {
    const registry = createFlowRegistry();
    registry.register({ flowId: 'first', tabId: 1, steps: 1, title: 'One' });
    registry.register({ flowId: 'second', tabId: 2, steps: 1, title: 'Two' });
    registry.register({ flowId: 'third', tabId: 3, steps: 1, title: 'Three' });

    expect(registry.listRunning(Date.now()).map((v) => v.flowId)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  test('elapsed time is measured against the caller-supplied clock and never goes negative', () => {
    const registry = createFlowRegistry();
    registry.register({ flowId: 'f1', tabId: 1, steps: 1 });
    const startedAt = registry.get('f1')!.startedAt;

    expect(registry.listRunning(startedAt + 4_200)[0]?.elapsedMs).toBe(4_200);
    // A clock that stepped backwards reads 0s, not "-1s".
    expect(registry.listRunning(startedAt - 5_000)[0]?.elapsedMs).toBe(0);
  });

  test('progress written by the runner surfaces in the running view', () => {
    const registry = createFlowRegistry();
    registry.register({ flowId: 'f1', tabId: 1, steps: 5 });
    registry.get('f1')!.progress = { step: 3, steps: 5, iteration: 12, iterations: 50 };

    expect(registry.listRunning(Date.now())[0]).toMatchObject({
      step: 3,
      steps: 5,
      iteration: 12,
      iterations: 50,
    });
  });

  test('a flow with no repeat leaves the iteration fields absent, not zero', () => {
    const registry = createFlowRegistry();
    registry.register({ flowId: 'f1', tabId: 1, steps: 2 });
    registry.get('f1')!.progress = { step: 1, steps: 2 };
    const view = registry.listRunning(Date.now())[0]!;

    expect(Object.hasOwn(view, 'iteration')).toBe(false);
    expect(Object.hasOwn(view, 'iterations')).toBe(false);
  });

  test('an empty registry lists nothing', () => {
    expect(createFlowRegistry().listRunning(Date.now())).toEqual([]);
  });
});

describe('flow history — shaping a finished flow', () => {
  test('a completed flow records counts and a duration', () => {
    const result: FlowResult = { ok: true, steps_completed: 3, results: [{}, {}, {}] };
    expect(toHistoryEntry(entryFor(), result, 3_500)).toEqual({
      flowId: 'flow_abc',
      startedAt: 1_000,
      durationMs: 2_500,
      outcome: 'completed',
      steps: 3,
      stepsCompleted: 3,
    });
  });

  test('a cancelled flow is recorded as cancelled, keeping what it completed', () => {
    const result: FlowResult = {
      ok: true,
      stopped_by: 'cancelled',
      steps_completed: 1,
      results: [{}],
    };
    const entry = toHistoryEntry(entryFor(), result, 2_000);
    expect(entry.outcome).toBe('cancelled');
    expect(entry.stepsCompleted).toBe(1);
  });

  test('a failed flow records the failing step index and kind', () => {
    const result: FlowResult = {
      ok: false,
      failed_step: 2,
      step_kind: 'click',
      error: 'Element not found: #delete',
      steps_completed: 2,
      recovery_snapshot: null,
    };
    const entry = toHistoryEntry(entryFor(), result, 2_000);
    expect(entry.outcome).toBe('failed');
    expect(entry.failedStep).toBe(2);
    expect(entry.failedStepKind).toBe('click');
  });

  test('a flow that threw instead of returning is failed, with progress as the fallback count', () => {
    const entry = toHistoryEntry(entryFor({ progress: { step: 3, steps: 5 } }), null, 2_000);
    expect(entry.outcome).toBe('failed');
    // The runner had announced step 3, so two steps had finished.
    expect(entry.stepsCompleted).toBe(2);
  });

  test('completed repeat iterations are summed across every repeat step', () => {
    const result: FlowResult = {
      ok: true,
      steps_completed: 2,
      results: [
        { iterations_completed: 12, stopped_by: 'condition', iterations: [] },
        { iterations_completed: 5, stopped_by: 'max_iterations', iterations: [] },
      ],
    };
    expect(toHistoryEntry(entryFor(), result, 2_000).iterationsCompleted).toBe(17);
  });

  test('a flow with no repeat omits iterationsCompleted rather than reporting 0', () => {
    const result: FlowResult = { ok: true, steps_completed: 1, results: [{ ok: true }] };
    const entry = toHistoryEntry(entryFor(), result, 2_000);
    expect(Object.hasOwn(entry, 'iterationsCompleted')).toBe(false);
  });

  test('duration never goes negative on a backwards clock', () => {
    const result: FlowResult = { ok: true, steps_completed: 0, results: [] };
    expect(toHistoryEntry(entryFor({ startedAt: 5_000 }), result, 1_000).durationMs).toBe(0);
  });
});

describe('flow history — privacy contract', () => {
  /** Everything a history entry is allowed to carry. Anything else is
   * either page-derived or a step toward being page-derived. */
  const ALLOWED_KEYS = [
    'flowId',
    'startedAt',
    'durationMs',
    'outcome',
    'steps',
    'stepsCompleted',
    'iterationsCompleted',
    'failedStep',
    'failedStepKind',
    // Both fixed vocabularies, not page-derived: a boolean flag and a
    // three-value enum. See FlowStopReason.
    'detached',
    'stoppedBy',
  ];

  test('a failure message quoting the page never reaches the history', () => {
    const result: FlowResult = {
      ok: false,
      failed_step: 1,
      step_kind: 'find',
      // A real `find` failure quotes the page back at you — candidate
      // labels, user names, order numbers. Exactly what must not be stored.
      error:
        'find: multiple-matches — candidates: [{"selector":"#row-4","text":"Delete order 55912 for Jane Doe","tag":"button"}]',
      steps_completed: 1,
      recovery_snapshot: { title: 'Wants — 956 items', interactive: [{ text: 'Jane Doe' }] },
    };
    const entry = toHistoryEntry(entryFor(), result, 2_000);
    const serialized = JSON.stringify(entry);

    expect(serialized).not.toContain('Jane Doe');
    expect(serialized).not.toContain('55912');
    expect(serialized).not.toContain('#row-4');
    expect(serialized).not.toContain('multiple-matches');
    expect(serialized).not.toContain('recovery_snapshot');
    // The useful half survives: WHICH step died, and what kind it was.
    expect(entry.failedStep).toBe(1);
    expect(entry.failedStepKind).toBe('find');
  });

  test('per-step results never leak into the history, however rich they are', () => {
    const result: FlowResult = {
      ok: true,
      steps_completed: 1,
      results: [{ selector: '#password', typed: 'hunter2', settle: { reason: 'quiet' } }],
    };
    const serialized = JSON.stringify(toHistoryEntry(entryFor(), result, 2_000));
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('#password');
  });

  test('an entry carries only the allowlisted keys', () => {
    const cancelled = toHistoryEntry(
      entryFor(),
      { ok: true, stopped_by: 'cancelled', steps_completed: 1, results: [] },
      2_000,
    );
    const failed = toHistoryEntry(
      entryFor(),
      {
        ok: false,
        failed_step: 0,
        step_kind: 'click',
        error: 'nope',
        steps_completed: 0,
        recovery_snapshot: null,
      },
      2_000,
    );
    for (const entry of [cancelled, failed]) {
      for (const key of Object.keys(entry)) expect(ALLOWED_KEYS).toContain(key);
    }
  });

  test('the tab title is NOT stored — it is a live-only label', () => {
    const entry = toHistoryEntry(
      entryFor({ title: 'Secret internal tool — customer 4471' }),
      {
        ok: true,
        steps_completed: 1,
        results: [],
      },
      2_000,
    );
    expect(JSON.stringify(entry)).not.toContain('customer 4471');
  });
});

describe('flow history — storage list', () => {
  function historyEntry(flowId: string): FlowHistoryEntry {
    return {
      flowId,
      startedAt: 1,
      durationMs: 10,
      outcome: 'completed',
      steps: 1,
      stepsCompleted: 1,
    };
  }

  test('newest entry goes first', () => {
    const list = appendFlowHistory([historyEntry('old')], historyEntry('new'));
    expect(list.map((e) => e.flowId)).toEqual(['new', 'old']);
  });

  test('caps at 20 per tab, dropping the oldest', () => {
    let list: FlowHistoryEntry[] = [];
    for (let i = 0; i < 25; i++) list = appendFlowHistory(list, historyEntry(`f${i}`));

    expect(list).toHaveLength(MAX_FLOW_HISTORY_PER_TAB);
    expect(list[0]?.flowId).toBe('f24');
    expect(list.at(-1)?.flowId).toBe('f5');
    expect(list.some((e) => e.flowId === 'f4')).toBe(false);
  });

  test('history is keyed per Chrome tab', () => {
    expect(flowHistoryKey(12)).toBe('flow-history:12');
    expect(flowHistoryKey(12)).not.toBe(flowHistoryKey(13));
  });

  test('parses a well-formed stored list', () => {
    const stored = [historyEntry('a'), historyEntry('b')];
    expect(parseFlowHistory(stored)).toHaveLength(2);
  });

  test('drops entries missing required fields instead of rendering undefined', () => {
    const parsed = parseFlowHistory([
      historyEntry('good'),
      { flowId: 'no-outcome', startedAt: 1, durationMs: 1, steps: 1, stepsCompleted: 1 },
      { outcome: 'completed' },
      null,
      'nonsense',
      { ...historyEntry('bad-outcome'), outcome: 'exploded' },
    ]);
    expect(parsed.map((e) => e.flowId)).toEqual(['good']);
  });

  test('a non-array value reads as an empty history', () => {
    expect(parseFlowHistory(undefined)).toEqual([]);
    expect(parseFlowHistory({ nope: true })).toEqual([]);
  });

  test('re-caps an oversized stored list', () => {
    const stored = Array.from({ length: 40 }, (_, i) => historyEntry(`f${i}`));
    expect(parseFlowHistory(stored)).toHaveLength(MAX_FLOW_HISTORY_PER_TAB);
  });

  test('optional fields survive a round trip', () => {
    const entry: FlowHistoryEntry = {
      ...historyEntry('f'),
      outcome: 'failed',
      iterationsCompleted: 3,
      failedStep: 2,
      failedStepKind: 'wait_for',
    };
    expect(parseFlowHistory([entry])[0]).toEqual(entry);
  });
});

describe('flow panel formatting', () => {
  test('durations read compactly at every scale', () => {
    expect(formatFlowDuration(0)).toBe('0.0s');
    expect(formatFlowDuration(420)).toBe('0.4s');
    expect(formatFlowDuration(1_000)).toBe('1s');
    expect(formatFlowDuration(12_400)).toBe('12s');
    expect(formatFlowDuration(187_000)).toBe('3m 07s');
    // A negative reading (backwards clock) never renders as such.
    expect(formatFlowDuration(-5)).toBe('0.0s');
  });

  test('progress reads as step i/N, or iteration i/N inside a repeat', () => {
    const base = {
      flowId: 'f',
      tabId: 1,
      title: 't',
      elapsedMs: 0,
      steps: 5,
      cancelling: false,
    };
    expect(describeFlowProgress({ ...base, step: 0 })).toBe('starting…');
    expect(describeFlowProgress({ ...base, step: 2 })).toBe('step 2/5');
    expect(describeFlowProgress({ ...base, step: 2, iteration: 12, iterations: 50 })).toBe(
      'step 2/5 · iteration 12/50',
    );
  });

  test('a flow falls back to its tab id when the title is unavailable', () => {
    expect(flowTabLabel({ title: 'Inbox', tabId: 4 })).toBe('Inbox');
    expect(flowTabLabel({ title: '   ', tabId: 4 })).toBe('Tab 4');
    expect(flowTabLabel({ title: '', tabId: 4 })).toBe('Tab 4');
  });

  test('a history line reports counts, duration and the failing step', () => {
    expect(
      describeFlowHistoryEntry({
        flowId: 'f',
        startedAt: 0,
        durationMs: 2_000,
        outcome: 'completed',
        steps: 3,
        stepsCompleted: 3,
      }),
    ).toBe('3/3 steps · 2s');

    expect(
      describeFlowHistoryEntry({
        flowId: 'f',
        startedAt: 0,
        durationMs: 8_000,
        outcome: 'cancelled',
        steps: 1,
        stepsCompleted: 0,
        iterationsCompleted: 23,
      }),
    ).toBe('0/1 steps · 23 iterations · 8s');

    expect(
      describeFlowHistoryEntry({
        flowId: 'f',
        startedAt: 0,
        durationMs: 1_500,
        outcome: 'failed',
        steps: 4,
        stepsCompleted: 2,
        failedStep: 2,
        failedStepKind: 'click',
      }),
      // 0-based index reported 1-based, because the panel is for humans.
    ).toBe('2/4 steps · 1s · failed at step 3 (click)');
  });
});

describe('detached flows — the registry half', () => {
  test('register hands back the LIVE entry, so the caller can mutate it in place', () => {
    // The JSDoc promised this from the start and the method returned void;
    // the detach wiring needs the entry (title stamping, progress sink,
    // expiry read) without a second lookup per step.
    const registry = createFlowRegistry();
    const entry = registry.register({ flowId: 'f1', tabId: 3, steps: 2 });
    entry.title = 'Wants list';
    entry.progress = { step: 2, steps: 2 };

    expect(registry.get('f1')).toBe(entry);
    expect(registry.listRunning(1_000)[0]).toMatchObject({ title: 'Wants list', step: 2 });
  });

  test('a detached flow is flagged in the running view and gets a deadline', () => {
    const registry = createFlowRegistry();
    const entry = registry.register({
      flowId: 'f1',
      tabId: 3,
      steps: 2,
      detached: true,
      expiresAt: 9_999,
    });

    expect(entry.detached).toBe(true);
    expect(entry.expiresAt).toBe(9_999);
    expect(registry.listRunning(1_000)[0].detached).toBe(true);
  });

  test('a synchronous flow never carries a deadline, even if one is passed', () => {
    // Only a detached flow escapes MAX_FLOW_TIMEOUT_MS, so only a detached
    // flow needs a ceiling of its own.
    const registry = createFlowRegistry();
    const entry = registry.register({ flowId: 'f1', tabId: 3, steps: 2, expiresAt: 5 });
    expect(entry.expiresAt).toBeUndefined();
    expect(registry.shouldStop('f1', 1_000_000)).toBe(false);
  });

  test('one detached flow per tab is answerable by NAME, not just yes/no', () => {
    const registry = createFlowRegistry();
    registry.register({ flowId: 'sync', tabId: 3, steps: 1 });
    expect(registry.detachedForTab(3)).toBeUndefined();

    registry.register({ flowId: 'detached-1', tabId: 3, steps: 1, detached: true });
    registry.register({ flowId: 'detached-2', tabId: 4, steps: 1, detached: true });

    expect(registry.detachedForTab(3)?.flowId).toBe('detached-1');
    expect(registry.detachedForTab(4)?.flowId).toBe('detached-2');
    expect(registry.detachedForTab(99)).toBeUndefined();
  });

  test('a finished detached flow frees its tab for the next one', () => {
    const registry = createFlowRegistry();
    registry.register({ flowId: 'f1', tabId: 3, steps: 1, detached: true });
    registry.finish('f1');
    expect(registry.detachedForTab(3)).toBeUndefined();
  });

  test('shouldStop is false while running, true once cancelled', () => {
    const registry = createFlowRegistry();
    registry.register({ flowId: 'f1', tabId: 3, steps: 1 });
    expect(registry.shouldStop('f1', 1_000)).toBe(false);
    registry.cancel('f1');
    expect(registry.shouldStop('f1', 1_000)).toBe(true);
  });

  test('shouldStop expires a detached flow at its deadline and records WHY', () => {
    const registry = createFlowRegistry();
    const entry = registry.register({
      flowId: 'f1',
      tabId: 3,
      steps: 1,
      detached: true,
      expiresAt: 5_000,
    });

    expect(registry.shouldStop('f1', 4_999)).toBe(false);
    expect(entry.cancelled).toBe(false);

    expect(registry.shouldStop('f1', 5_000)).toBe(true);
    expect(entry.cancelled).toBe(true);
    // The distinction the runner cannot make: it only ever reports
    // `stopped_by: 'cancelled'`, so without this the outcome of a run that
    // simply ran out of time would be indistinguishable from a human
    // pressing Stop.
    expect(entry.stopReason).toBe('expired');
  });

  test('an expiry never overwrites a stop that was already requested', () => {
    const registry = createFlowRegistry();
    const entry = registry.register({
      flowId: 'f1',
      tabId: 3,
      steps: 1,
      detached: true,
      expiresAt: 5_000,
    });
    registry.cancel('f1');
    registry.shouldStop('f1', 900_000);
    expect(entry.stopReason).toBe('cancelled');
  });

  test('an id the registry has forgotten is told to stop, not allowed to run on', () => {
    // A flow whose bookkeeping is gone cannot be seen, listed or stopped —
    // continuing to dispatch irreversible actions on its behalf is exactly
    // the runaway this module exists to prevent.
    const registry = createFlowRegistry();
    expect(registry.shouldStop('never-registered', 1_000)).toBe(true);
  });

  test('cancelForTab stops a detached flow along with everything else on the tab', () => {
    const registry = createFlowRegistry();
    const detached = registry.register({ flowId: 'f1', tabId: 3, steps: 1, detached: true });
    const sync = registry.register({ flowId: 'f2', tabId: 3, steps: 1 });
    registry.register({ flowId: 'f3', tabId: 4, steps: 1 });

    expect(registry.cancelForTab(3)).toBe(2);
    expect(detached.cancelled).toBe(true);
    expect(sync.cancelled).toBe(true);
    expect(registry.get('f3')?.cancelled).toBe(false);
  });
});

describe('detached flows — outcome and history', () => {
  test('an expired run reads as `expired`, not as a cancellation', () => {
    const entry = entryFor({ detached: true, stopReason: 'expired' });
    const result: FlowResult = {
      ok: true,
      stopped_by: 'cancelled',
      steps_completed: 2,
      results: [{ ok: true }, { ok: true }],
    };
    expect(summarizeFlow(entry, result)).toMatchObject({
      outcome: 'expired',
      stoppedBy: 'expired',
      stepsCompleted: 2,
    });
    expect(toHistoryEntry(entry, result, 2_000)).toMatchObject({
      outcome: 'expired',
      stoppedBy: 'expired',
      detached: true,
    });
  });

  test('a human stop still reads as `cancelled`', () => {
    const entry = entryFor({ detached: true, stopReason: 'cancelled' });
    const result: FlowResult = {
      ok: true,
      stopped_by: 'cancelled',
      steps_completed: 1,
      results: [{ ok: true }],
    };
    expect(toHistoryEntry(entry, result, 2_000)).toMatchObject({
      outcome: 'cancelled',
      stoppedBy: 'cancelled',
    });
  });

  test('a completed detached run carries no stop reason at all', () => {
    const entry = entryFor({ detached: true });
    const result: FlowResult = { ok: true, steps_completed: 3, results: [] };
    const history = toHistoryEntry(entry, result, 2_000);
    expect(history.outcome).toBe('completed');
    expect(history.stoppedBy).toBeUndefined();
    expect(history.detached).toBe(true);
  });

  test('the popup renders expiry and worker termination in words', () => {
    expect(
      describeFlowHistoryEntry({
        flowId: 'f',
        startedAt: 0,
        durationMs: 1_800_000,
        outcome: 'expired',
        steps: 1,
        stepsCompleted: 1,
        iterationsCompleted: 412,
        detached: true,
        stoppedBy: 'expired',
      }),
    ).toBe('detached · 1/1 steps · 412 iterations · 30m 00s · hit the 30-minute detached ceiling');

    expect(
      describeFlowHistoryEntry({
        flowId: 'f',
        startedAt: 0,
        durationMs: 4_000,
        outcome: 'failed',
        steps: 2,
        stepsCompleted: 1,
        detached: true,
        stoppedBy: 'worker-terminated',
      }),
    ).toBe('detached · 1/2 steps · 4s · extension worker was terminated — not resumed');
  });

  test('a plain cancellation does not repeat itself in the detail line', () => {
    expect(
      describeFlowHistoryEntry({
        flowId: 'f',
        startedAt: 0,
        durationMs: 2_000,
        outcome: 'cancelled',
        steps: 3,
        stepsCompleted: 1,
        stoppedBy: 'cancelled',
      }),
    ).toBe('1/3 steps · 2s');
  });

  test('a detached running row says so in its progress line', () => {
    expect(
      describeFlowProgress({
        flowId: 'f',
        tabId: 1,
        title: '',
        elapsedMs: 0,
        steps: 3,
        step: 2,
        cancelling: false,
        detached: true,
      }),
    ).toBe('detached · step 2/3');
    expect(
      describeFlowProgress({
        flowId: 'f',
        tabId: 1,
        title: '',
        elapsedMs: 0,
        steps: 3,
        step: 0,
        cancelling: false,
        detached: true,
      }),
    ).toBe('detached · starting…');
  });

  test('the new outcomes survive a round trip through session storage', () => {
    const entries: FlowHistoryEntry[] = [
      {
        flowId: 'a',
        startedAt: 0,
        durationMs: 1,
        outcome: 'expired',
        steps: 1,
        stepsCompleted: 1,
        detached: true,
        stoppedBy: 'expired',
      },
      {
        flowId: 'b',
        startedAt: 0,
        durationMs: 1,
        outcome: 'failed',
        steps: 1,
        stepsCompleted: 0,
        detached: true,
        stoppedBy: 'worker-terminated',
      },
    ];
    expect(parseFlowHistory(JSON.parse(JSON.stringify(entries)))).toEqual(entries);
  });

  test('an unrecognised outcome or stop reason is dropped, not rendered', () => {
    const parsed = parseFlowHistory([
      {
        flowId: 'a',
        startedAt: 0,
        durationMs: 1,
        outcome: 'exploded',
        steps: 1,
        stepsCompleted: 0,
      },
      {
        flowId: 'b',
        startedAt: 0,
        durationMs: 1,
        outcome: 'failed',
        steps: 1,
        stepsCompleted: 0,
        stoppedBy: 'because',
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].flowId).toBe('b');
    expect(parsed[0].stoppedBy).toBeUndefined();
  });
});

describe('detached flows — the persisted record', () => {
  test('the launch record exists before the first step, and says running', () => {
    const entry = entryFor({ detached: true, progress: { step: 0, steps: 3 } });
    expect(startedDetachedFlowRecord(entry)).toEqual({
      flowId: 'flow_abc',
      tabId: 7,
      state: 'running',
      startedAt: 1_000,
      steps: 3,
      stepsCompleted: 0,
    });
  });

  test('the terminal record keeps the manifest verbatim — that IS the answer', () => {
    const manifest = [{ selector: '#row-1' }, { ok: true, settle: { settled: true } }];
    const record = finishedDetachedFlowRecord(
      entryFor({ detached: true }),
      { ok: true, steps_completed: 2, results: manifest },
      3_000,
    );
    expect(record.state).toBe('completed');
    expect(record.endedAt).toBe(3_000);
    expect(record.manifest).toEqual(manifest);
    expect(record.manifestTruncated).toBeUndefined();
  });

  test('a failure keeps its error message — the agent needs it, the popup never sees it', () => {
    const record = finishedDetachedFlowRecord(
      entryFor({ detached: true }),
      {
        ok: false,
        failed_step: 1,
        step_kind: 'find',
        error: 'find: multiple-matches — candidates: [{"text":"Delete Bob Smith"}]',
        steps_completed: 1,
        recovery_snapshot: null,
      },
      3_000,
    );
    expect(record.state).toBe('failed');
    expect(record.error).toContain('multiple-matches');
    // The very same run, rendered for the popup, drops it.
    const history = toHistoryEntry(
      entryFor({ detached: true }),
      {
        ok: false,
        failed_step: 1,
        step_kind: 'find',
        error: 'find: multiple-matches — candidates: [{"text":"Delete Bob Smith"}]',
        steps_completed: 1,
        recovery_snapshot: null,
      },
      3_000,
    );
    expect(JSON.stringify(history)).not.toContain('Bob Smith');
  });

  test('a manifest over the storage ceiling is dropped LOUDLY, never silently shortened', () => {
    // A short array the agent would read as "that is everything that
    // happened" is the one failure mode worth engineering against here.
    const huge = Array.from({ length: 5_000 }, (_, i) => ({ selector: `#row-${i}`, ok: true }));
    const record = finishedDetachedFlowRecord(
      entryFor({ detached: true }),
      { ok: true, steps_completed: 1, results: huge },
      3_000,
    );
    expect(JSON.stringify(huge).length).toBeGreaterThan(MAX_DETACHED_MANIFEST_BYTES);
    expect(record.manifestTruncated).toBe(true);
    expect(record.manifest).toBeUndefined();
    // Everything countable still survives.
    expect(record.state).toBe('completed');
    expect(record.stepsCompleted).toBe(1);
  });

  test('the ceiling counts UTF-8 BYTES — a CJK manifest costs three per code unit', () => {
    // Under the ceiling measured as `.length`, over it once encoded. The
    // quota this cap protects counts bytes, so measuring code units would
    // wave through a record three times too large — a rejected write, and
    // the outcome lost with it.
    const text = '観'.repeat(60_000);
    expect(JSON.stringify([text]).length).toBeLessThan(MAX_DETACHED_MANIFEST_BYTES);
    expect(new TextEncoder().encode(JSON.stringify([text])).length).toBeGreaterThan(
      MAX_DETACHED_MANIFEST_BYTES,
    );

    const record = finishedDetachedFlowRecord(
      entryFor({ detached: true }),
      { ok: true, steps_completed: 1, results: [text] },
      3_000,
    );
    expect(record.manifestTruncated).toBe(true);
    expect(record.manifest).toBeUndefined();
  });

  test('iterations are summed onto the record the same way the history sums them', () => {
    const record = finishedDetachedFlowRecord(
      entryFor({ detached: true }),
      {
        ok: true,
        steps_completed: 1,
        results: [{ iterations_completed: 187, stopped_by: 'condition', iterations: [] }],
      },
      3_000,
    );
    expect(record.iterationsCompleted).toBe(187);
  });

  test('a record round-trips through storage, and a malformed one is dropped', () => {
    const record = finishedDetachedFlowRecord(
      entryFor({ detached: true, stopReason: 'expired' }),
      { ok: true, stopped_by: 'cancelled', steps_completed: 1, results: [{ ok: true }] },
      3_000,
    );
    expect(parseDetachedFlowRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);

    expect(parseDetachedFlowRecord(null)).toBeNull();
    expect(parseDetachedFlowRecord({ flowId: 'x' })).toBeNull();
    expect(
      parseDetachedFlowRecord({
        flowId: 'x',
        tabId: 1,
        startedAt: 0,
        steps: 1,
        stepsCompleted: 0,
        state: 'sleeping',
      }),
    ).toBeNull();
  });

  test('the storage key round-trips, and other session keys are not mistaken for records', () => {
    expect(flowIdFromDetachedFlowKey(detachedFlowKey('flow_abc'))).toBe('flow_abc');
    expect(flowIdFromDetachedFlowKey('flow-history:7')).toBeNull();
    expect(flowIdFromDetachedFlowKey('prevTabId:7')).toBeNull();
    expect(flowIdFromDetachedFlowKey('detached-flow:')).toBeNull();
  });
});

describe('detached flows — service-worker termination', () => {
  test('an orphaned running record becomes failed / worker-terminated, never resumed', () => {
    const record = startedDetachedFlowRecord(entryFor({ detached: true }));
    const terminated = terminatedDetachedFlowRecord(record, 9_000);

    expect(terminated).toMatchObject({
      state: 'failed',
      stoppedBy: 'worker-terminated',
      endedAt: 9_000,
      // The partial results lived in the dead worker's closure. Saying so
      // beats presenting an empty array as "nothing happened".
      manifestTruncated: true,
      // Nothing was listening when it died; the summary event is owed and
      // goes out on the tab's next registration.
      eventPending: true,
    });
    expect(terminated?.manifest).toBeUndefined();
    // There is deliberately no "resume" anywhere in the shape: the only
    // transition offered is to a terminal state.
    expect(terminated?.state).not.toBe('running');
  });

  test('a second worker restart does not rewrite an already-terminal record', () => {
    const first = terminatedDetachedFlowRecord(
      startedDetachedFlowRecord(entryFor({ detached: true })),
      9_000,
    );
    expect(first).not.toBeNull();
    expect(terminatedDetachedFlowRecord(first!, 20_000)).toBeNull();

    const completed = finishedDetachedFlowRecord(
      entryFor({ detached: true }),
      { ok: true, steps_completed: 1, results: [] },
      3_000,
    );
    expect(terminatedDetachedFlowRecord(completed, 20_000)).toBeNull();
  });

  test('the history entry for a killed flow is counts and enums only', () => {
    const terminated = terminatedDetachedFlowRecord(
      { ...startedDetachedFlowRecord(entryFor({ detached: true })), stepsCompleted: 4 },
      9_000,
    );
    const history = terminatedFlowHistoryEntry(terminated!);
    expect(history).toEqual({
      flowId: 'flow_abc',
      startedAt: 1_000,
      durationMs: 8_000,
      steps: 3,
      stepsCompleted: 4,
      outcome: 'failed',
      detached: true,
      stoppedBy: 'worker-terminated',
    });
  });

  test('running records are never evicted — they are the only evidence of a live flow', () => {
    const records = [
      ...Array.from({ length: MAX_DETACHED_FLOW_RECORDS }, (_, i) => ({
        ...startedDetachedFlowRecord(entryFor({ flowId: `done-${i}`, startedAt: i })),
        state: 'completed' as const,
      })),
      { ...startedDetachedFlowRecord(entryFor({ flowId: 'live', startedAt: -1 })) },
    ];
    const evicted = detachedFlowRecordsToEvict(records);
    expect(evicted.map((r) => r.flowId)).toEqual(['done-0']);
  });

  test('nothing is evicted while the cap has room', () => {
    const records = Array.from({ length: 3 }, (_, i) => ({
      ...startedDetachedFlowRecord(entryFor({ flowId: `done-${i}`, startedAt: i })),
      state: 'completed' as const,
    }));
    expect(detachedFlowRecordsToEvict(records)).toEqual([]);
  });

  test('a record still owing its summary event outlives newer, older and non-pending ones', () => {
    // The oldest record is the one that would go first on age alone, and it
    // is the one carrying an audit event nobody has received yet.
    const records = [
      {
        ...startedDetachedFlowRecord(entryFor({ flowId: 'owed', startedAt: 0 })),
        state: 'completed' as const,
        eventPending: true as const,
      },
      ...Array.from({ length: MAX_DETACHED_FLOW_RECORDS }, (_, i) => ({
        ...startedDetachedFlowRecord(entryFor({ flowId: `done-${i}`, startedAt: i + 1 })),
        state: 'completed' as const,
      })),
    ];
    expect(detachedFlowRecordsToEvict(records).map((r) => r.flowId)).toEqual(['done-0']);
  });

  test('when EVERY terminal record is still owing, the oldest goes anyway', () => {
    // The exemption is a preference, not a lock: a cap that can never be
    // enforced would block new records forever, which is the worse loss.
    const records = Array.from({ length: MAX_DETACHED_FLOW_RECORDS + 2 }, (_, i) => ({
      ...startedDetachedFlowRecord(entryFor({ flowId: `owed-${i}`, startedAt: i })),
      state: 'completed' as const,
      eventPending: true as const,
    }));
    expect(detachedFlowRecordsToEvict(records).map((r) => r.flowId)).toEqual(['owed-0', 'owed-1']);
  });

  test('the fallback record keeps the outcome and drops only the manifest', () => {
    const full = finishedDetachedFlowRecord(
      entryFor({ detached: true, stopReason: 'cancelled' }),
      {
        ok: true,
        stopped_by: 'cancelled',
        steps_completed: 2,
        results: [{ selector: '#row-1' }, { iterations_completed: 9, iterations: [] }],
      },
      3_000,
    );
    expect(full.manifest).toBeDefined();

    // Everything the outcome is made of survives — that is the whole point:
    // a lost terminal write is reinterpreted as `worker-terminated`.
    const minimal = minimalDetachedFlowRecord(full);
    expect(minimal).toEqual({ ...full, manifest: undefined, manifestTruncated: true });
    expect(minimal.manifest).toBeUndefined();
    expect(minimal).toMatchObject({ state: 'cancelled', stoppedBy: 'cancelled' });
    // And it round-trips through the parser the real write goes over.
    expect(parseDetachedFlowRecord(JSON.parse(JSON.stringify(minimal)))).toEqual(minimal);
  });

  test('the fallback record bounds the error too — it is the last unbounded field', () => {
    // Page-derived free text with no ceiling of its own. Once the full
    // write has already been refused, an error long enough to be the reason
    // would sink the retry as well, and the outcome with it.
    const full = finishedDetachedFlowRecord(
      entryFor({ detached: true }),
      {
        ok: false,
        failed_step: 0,
        step_kind: 'find',
        error: `find: multiple-matches — ${'x'.repeat(200_000)}`,
        steps_completed: 0,
        recovery_snapshot: null,
      },
      3_000,
    );

    const minimal = minimalDetachedFlowRecord(full);
    expect(minimal.error).toHaveLength(MAX_MINIMAL_RECORD_ERROR_CHARS + 1);
    expect(minimal.error?.endsWith('…')).toBe(true);
    // The head of the message — the part that names what went wrong — is
    // what survives.
    expect(minimal.error).toContain('multiple-matches');
    expect(minimal.state).toBe('failed');
  });

  test('an error already under the bound is left exactly as it was', () => {
    const full = finishedDetachedFlowRecord(
      entryFor({ detached: true }),
      {
        ok: false,
        failed_step: 0,
        step_kind: 'click',
        error: 'Element not found: #delete',
        steps_completed: 0,
        recovery_snapshot: null,
      },
      3_000,
    );
    expect(minimalDetachedFlowRecord(full).error).toBe('Element not found: #delete');
  });
});

describe('detached flows — the flow_status payload', () => {
  test('a running flow reports live progress and no manifest', () => {
    const entry = entryFor({
      detached: true,
      expiresAt: 1_800_000,
      progress: { step: 3, steps: 5, iteration: 12, iterations: 50 },
    });
    const status = toFlowStatus('flow_abc', entry, undefined);

    expect(status).toEqual({
      flow_id: 'flow_abc',
      state: 'running',
      detached: true,
      started_at: 1_000,
      steps: 3,
      // Step 3 ANNOUNCED means 2 finished — the runner reports what it is
      // about to dispatch.
      steps_completed: 2,
      iterations_completed: 11,
      expires_at: 1_800_000,
    });
    // The runner is still holding them; promising a manifest here would be
    // promising a shorter truth than the real one.
    expect(status.manifest).toBeUndefined();
  });

  test('a stop already requested shows as cancelling, not yet as cancelled', () => {
    const entry = entryFor({ detached: true, cancelled: true, stopReason: 'cancelled' });
    expect(toFlowStatus('flow_abc', entry, undefined)).toMatchObject({
      state: 'running',
      cancelling: true,
    });
  });

  test('the live entry wins over a stale launch record', () => {
    const entry = entryFor({ detached: true, progress: { step: 4, steps: 5 } });
    const stale = startedDetachedFlowRecord(entry);
    expect(toFlowStatus('flow_abc', entry, stale).steps_completed).toBe(3);
  });

  test('a finished flow reports its outcome and the full manifest', () => {
    const manifest = [{ selector: '#a' }, { ok: true }];
    const record = finishedDetachedFlowRecord(
      entryFor({ detached: true }),
      { ok: true, steps_completed: 2, results: manifest },
      3_000,
    );
    expect(toFlowStatus('flow_abc', undefined, record)).toEqual({
      flow_id: 'flow_abc',
      state: 'completed',
      detached: true,
      started_at: 1_000,
      ended_at: 3_000,
      steps: 3,
      steps_completed: 2,
      manifest,
    });
  });

  test('a worker-terminated flow reports the loss instead of an empty manifest', () => {
    const terminated = terminatedDetachedFlowRecord(
      startedDetachedFlowRecord(entryFor({ detached: true })),
      9_000,
    );
    const status = toFlowStatus('flow_abc', undefined, terminated!);
    expect(status).toMatchObject({
      state: 'failed',
      stopped_by: 'worker-terminated',
      manifest_truncated: true,
    });
    expect(status.manifest).toBeUndefined();
  });

  test('an id nobody knows is `unknown`, not an error', () => {
    expect(toFlowStatus('flow_nope', undefined, undefined)).toEqual({
      flow_id: 'flow_nope',
      state: 'unknown',
      detached: false,
    });
  });
});
