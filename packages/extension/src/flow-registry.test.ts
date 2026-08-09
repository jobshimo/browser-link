import { describe, expect, test } from 'vitest';
import {
  MAX_FLOW_HISTORY_PER_TAB,
  appendFlowHistory,
  createFlowRegistry,
  describeFlowHistoryEntry,
  describeFlowProgress,
  flowHistoryKey,
  flowTabLabel,
  formatFlowDuration,
  parseFlowHistory,
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
