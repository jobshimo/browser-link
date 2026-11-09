import { beforeEach, describe, expect, test } from 'vitest';
import {
  MAX_SESSIONS,
  MAX_SESSION_FLOWS,
  MAX_SESSION_TYPED,
  beginToolCall,
  markRulesDelivered,
  noteOrigin,
  notePendingWork,
  noteTypedValue,
  peekSession,
  recordSessionFlow,
  resetPendingWork,
  resetSessions,
  sessionFor,
} from './session.js';

beforeEach(() => {
  resetSessions();
});

describe('per-agent session state', () => {
  test('a new session starts empty and records when it started', () => {
    const s = sessionFor('a');
    expect(s.firstCallDone).toBe(false);
    expect(s.pendingWrapUp).toBe(0);
    expect([...s.origins]).toEqual([]);
    expect(s.typedValues).toEqual([]);
    expect(s.flows).toEqual([]);
    expect(Number.isNaN(Date.parse(s.startedAt))).toBe(false);
  });

  test('beginToolCall is true exactly once per session, and sessions are independent', () => {
    expect(beginToolCall('a')).toBe(true);
    expect(beginToolCall('a')).toBe(false);
    expect(beginToolCall('b')).toBe(true);
    expect(peekSession('a')?.firstCallDone).toBe(true);
  });

  test('markRulesDelivered makes the next call not the first', () => {
    markRulesDelivered('a');
    expect(beginToolCall('a')).toBe(false);
  });

  test('pending work counts up and resets to zero', () => {
    notePendingWork('a');
    notePendingWork('a');
    expect(peekSession('a')?.pendingWrapUp).toBe(2);
    resetPendingWork('a');
    expect(peekSession('a')?.pendingWrapUp).toBe(0);
  });

  test('origins are a set; typed values ignore non-strings and keep the last N', () => {
    noteOrigin('a', 'https://x.test');
    noteOrigin('a', 'https://x.test');
    noteOrigin('a', null);
    expect([...sessionFor('a').origins]).toEqual(['https://x.test']);
    noteTypedValue('a', 42);
    noteTypedValue('a', '');
    for (let i = 0; i < MAX_SESSION_TYPED + 3; i += 1) noteTypedValue('a', `v${i}`);
    const typed = sessionFor('a').typedValues;
    expect(typed).toHaveLength(MAX_SESSION_TYPED);
    expect(typed[0]).toBe('v3');
  });

  test('flow records get a stable session_index and are capped', () => {
    const first = recordSessionFlow('a', {
      origin: 'https://x.test',
      name: null,
      saved_name: null,
      steps: [{ click: { selector: '.a' } }],
      stopped_by: null,
      ok: true,
    });
    expect(first.session_index).toBe(0);
    for (let i = 0; i < MAX_SESSION_FLOWS + 5; i += 1) {
      recordSessionFlow('a', {
        origin: null,
        name: null,
        saved_name: null,
        steps: [],
        stopped_by: null,
        ok: true,
      });
    }
    const flows = sessionFor('a').flows;
    expect(flows).toHaveLength(MAX_SESSION_FLOWS);
    // Indices are never reused, even after the oldest records fall off.
    expect(flows[flows.length - 1].session_index).toBe(MAX_SESSION_FLOWS + 5);
  });

  test('the table is an LRU capped at MAX_SESSIONS: the least recently used goes first', () => {
    for (let i = 0; i < MAX_SESSIONS; i += 1) sessionFor(`s${i}`);
    sessionFor('s0'); // touch: s1 is now the oldest
    sessionFor('new');
    expect(peekSession('s0')).toBeDefined();
    expect(peekSession('s1')).toBeUndefined();
    expect(peekSession('new')).toBeDefined();
  });

  test('peekSession never creates a session', () => {
    expect(peekSession('ghost')).toBeUndefined();
    expect(peekSession('ghost')).toBeUndefined();
  });
});
