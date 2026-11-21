// TabSession's invariants on a manual clock (design section 4).
import { describe, expect, test } from 'vitest';
import { createManualClock } from '../ports/contract/index.js';
import {
  DEFAULT_IDLE_TTL_MINUTES,
  MAX_CALL_HOLD_MS,
  tabsToDisconnectForIdle,
  type IdleFlowHold,
} from '../policies/idle-rules.js';
import type { PageDriverHandle } from './page-driver.js';
import { CONSOLE_BUFFER_MAX, NETWORK_BUFFER_MAX } from './capture-intake.js';
import { idleTabs, sessionCaptureWatch, sessionDialogWatch, TabSession } from './tab-session.js';

const MINUTE = 60_000;
const TTL_MS = DEFAULT_IDLE_TTL_MINUTES * MINUTE;

function sessionAt(start = 1_000) {
  const clock = createManualClock(start);
  const session = new TabSession({ clock, driver: {} as PageDriverHandle });
  return { clock, session };
}

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TabSession: activity', () => {
  test('a new session starts its idle clock at the connect', () => {
    const { session } = sessionAt(5_000);
    expect(session.lastActivityAt).toBe(5_000);
  });

  test('touch sets the activity to now', async () => {
    const { clock, session } = sessionAt();
    await clock.advance(700);
    session.touch();
    expect(session.lastActivityAt).toBe(1_700);
  });

  test('the end of a call never moves the activity backwards', async () => {
    const { clock, session } = sessionAt();
    const gate = deferred<void>();
    const run = session.runCall(() => gate.promise);
    await clock.advance(1_000);
    // A flow that ended later than the call's end time.
    session.flowEnded(clock.now() + 5_000);
    gate.resolve();
    await run;
    expect(session.lastActivityAt).toBe(7_000);
  });

  test('a finished flow restarts the idle window from its end, never earlier', () => {
    const { session } = sessionAt(10_000);
    session.flowEnded(4_000);
    expect(session.lastActivityAt).toBe(10_000);
    session.flowEnded(12_000);
    expect(session.lastActivityAt).toBe(12_000);
  });
});

describe('TabSession: the call hold', () => {
  test('a call touches the clock, holds it while it runs and its end is activity', async () => {
    const { clock, session } = sessionAt();
    const gate = deferred<string>();
    const run = session.runCall(() => gate.promise);
    expect(session.callsInProgress()).toEqual([{ startedAt: 1_000 }]);
    await clock.advance(3_000);
    gate.resolve('done');
    await expect(run).resolves.toBe('done');
    expect(session.callsInProgress()).toEqual([]);
    expect(session.lastActivityAt).toBe(4_000);
  });

  test('a call that throws releases its hold and counts its end as activity', async () => {
    const { clock, session } = sessionAt();
    const gate = deferred<never>();
    const run = session.runCall(() => gate.promise);
    await clock.advance(2_000);
    gate.reject(new Error('boom'));
    await expect(run).rejects.toThrow('boom');
    expect(session.callsInProgress()).toEqual([]);
    expect(session.lastActivityAt).toBe(3_000);
  });

  test('a call that throws synchronously inside fn releases its hold too', async () => {
    const { session } = sessionAt();
    await expect(
      session.runCall(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(session.callsInProgress()).toEqual([]);
  });

  test('a call longer than the TTL is not idle while it runs, up to MAX_CALL_HOLD_MS', async () => {
    const { clock, session } = sessionAt(0);
    const gate = deferred<void>();
    const run = session.runCall(() => gate.promise);
    await clock.advance(TTL_MS + MINUTE);
    expect(session.idleCandidate(clock.now(), DEFAULT_IDLE_TTL_MINUTES, [])).toBe(false);
    // Past the hold's bound the call counts as activity at that bound.
    expect(session.idleCandidate(MAX_CALL_HOLD_MS + TTL_MS - 1, DEFAULT_IDLE_TTL_MINUTES, [])).toBe(
      false,
    );
    expect(session.idleCandidate(MAX_CALL_HOLD_MS + TTL_MS, DEFAULT_IDLE_TTL_MINUTES, [])).toBe(
      true,
    );
    gate.resolve();
    await run;
    // Once it answered, the window restarts from its end.
    expect(session.idleCandidate(clock.now() + TTL_MS - 1, DEFAULT_IDLE_TTL_MINUTES, [])).toBe(
      false,
    );
    expect(session.idleCandidate(clock.now() + TTL_MS, DEFAULT_IDLE_TTL_MINUTES, [])).toBe(true);
  });

  test('two concurrent calls each hold the clock until their own end', async () => {
    const { clock, session } = sessionAt(0);
    const first = deferred<void>();
    const second = deferred<void>();
    const a = session.runCall(() => first.promise);
    await clock.advance(10);
    const b = session.runCall(() => second.promise);
    first.resolve();
    await a;
    expect(session.callsInProgress()).toEqual([{ startedAt: 10 }]);
    second.reject(new Error('x'));
    await expect(b).rejects.toThrow('x');
    expect(session.callsInProgress()).toEqual([]);
  });
});

describe('TabSession: idle decisions', () => {
  test('a running flow holds the tab until its bound', () => {
    const { session } = sessionAt(0);
    const bound = TTL_MS * 3;
    expect(session.idleCandidate(TTL_MS * 2, DEFAULT_IDLE_TTL_MINUTES, [bound])).toBe(false);
    expect(session.idleCandidate(bound + TTL_MS - 1, DEFAULT_IDLE_TTL_MINUTES, [bound])).toBe(
      false,
    );
    expect(session.idleCandidate(bound + TTL_MS, DEFAULT_IDLE_TTL_MINUTES, [bound])).toBe(true);
  });

  test('"never" (0) never disconnects', () => {
    const { session } = sessionAt(0);
    expect(session.idleCandidate(TTL_MS * 100, 0, [])).toBe(false);
  });

  test('idleTabs answers what tabsToDisconnectForIdle answers', async () => {
    const clock = createManualClock(0);
    const make = () => new TabSession({ clock, driver: {} as PageDriverHandle });
    const quiet = make();
    const busy = make();
    const flowing = make();
    const gate = deferred<void>();
    void busy.runCall(() => gate.promise);
    await clock.advance(TTL_MS + 1);
    const fresh = make();
    const sessions: [number, TabSession][] = [
      [1, quiet],
      [2, busy],
      [3, flowing],
      [4, fresh],
    ];
    const holds: IdleFlowHold[] = [{ tabId: 3, holdUntil: TTL_MS * 2 }];
    for (const now of [TTL_MS - 1, TTL_MS + 1, TTL_MS * 3, MAX_CALL_HOLD_MS + TTL_MS]) {
      const expected = tabsToDisconnectForIdle(
        sessions.map(([id, s]) => [id, s.lastActivityAt] as const),
        holds,
        now,
        DEFAULT_IDLE_TTL_MINUTES,
        sessions.flatMap(([tabId, s]) =>
          s.callsInProgress().map((c) => ({ tabId, startedAt: c.startedAt })),
        ),
      );
      expect(idleTabs(sessions, holds, now, DEFAULT_IDLE_TTL_MINUTES)).toEqual(expected);
    }
    expect(idleTabs(sessions, holds, TTL_MS + 1, DEFAULT_IDLE_TTL_MINUTES)).toEqual([1]);
    gate.resolve();
  });
});

describe('TabSession: bounded buffers', () => {
  test('the console keeps the last CONSOLE_BUFFER_MAX entries, oldest dropped first', () => {
    const { session } = sessionAt();
    for (let i = 0; i < CONSOLE_BUFFER_MAX + 5; i++) {
      session.pushConsole({ timestamp: i, level: 'log', text: `m${i}`, source: 'console' });
    }
    expect(session.consoleBuffer).toHaveLength(CONSOLE_BUFFER_MAX);
    expect(session.consoleBuffer[0]?.text).toBe('m5');
    expect(session.consoleBuffer.at(-1)?.text).toBe(`m${CONSOLE_BUFFER_MAX + 4}`);
  });

  test('the network keeps the last NETWORK_BUFFER_MAX requests; order and map hold the same ids', () => {
    const { session } = sessionAt();
    for (let i = 0; i < NETWORK_BUFFER_MAX + 3; i++) session.networkEntry(`r${i}`);
    // Seeing a kept request again neither adds nor reorders it.
    session.networkEntry(`r${NETWORK_BUFFER_MAX}`).status = 200;
    expect(session.networkOrder).toHaveLength(NETWORK_BUFFER_MAX);
    expect(session.networkOrder[0]).toBe('r3');
    expect([...session.networkBuffer.keys()].sort()).toEqual([...session.networkOrder].sort());
    expect(session.networkBuffer.has('r2')).toBe(false);
    expect(session.networkBuffer.get(`r${NETWORK_BUFFER_MAX}`)?.status).toBe(200);
  });

  test('a new network entry starts at the clock time with empty url and method', async () => {
    const { clock, session } = sessionAt();
    await clock.advance(42);
    expect(session.networkEntry('a')).toEqual({
      request_id: 'a',
      url: '',
      method: '',
      started_at: 1_042,
    });
  });
});

describe('TabSession: the pending dialog', () => {
  test('at most one pending dialog: opening replaces, closing clears', () => {
    const { session } = sessionAt();
    expect(session.pendingDialog).toBeUndefined();
    session.dialogOpened({ type: 'alert', message: 'one' });
    session.dialogOpened({ type: 'confirm', message: 'two' });
    expect(session.pendingDialog).toEqual({ type: 'confirm', message: 'two' });
    session.dialogClosed();
    expect(session.pendingDialog).toBeUndefined();
  });

  test('the dialog watch reads the current session live', () => {
    const { session } = sessionAt();
    let current: TabSession | undefined = session;
    const watch = sessionDialogWatch(() => current);
    expect(watch.isOpen()).toBe(false);
    session.dialogOpened({ type: 'alert', message: 'm' });
    expect(watch.isOpen()).toBe(true);
    current = undefined;
    expect(watch.isOpen()).toBe(false);
  });
});

describe('TabSession: the capture watch', () => {
  test('reads the console and network buffers live, in buffer order', () => {
    const { session } = sessionAt();
    const watch = sessionCaptureWatch(session);
    expect(watch.consoleEntries()).toEqual([]);
    expect(watch.networkEntries()).toEqual([]);
    session.pushConsole({ timestamp: 1, level: 'warn', text: 'a', source: 'console' });
    session.pushConsole({ timestamp: 2, level: 'log', text: 'b', source: 'log' });
    session.networkEntry('r1').url = 'https://x.test/one';
    session.networkEntry('r2').url = 'https://x.test/two';
    session.networkEntry('r1').finished_at = 5;
    expect(watch.consoleEntries().map((e) => e.text)).toEqual(['a', 'b']);
    expect(watch.networkEntries().map((e) => e.request_id)).toEqual(['r1', 'r2']);
    expect([...watch.finishedUrls()]).toEqual(['https://x.test/one']);
  });
});
