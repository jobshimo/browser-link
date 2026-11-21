// The PageDriver on in-memory fakes: the CDP commands it sends, in order,
// and how it folds the page's answers into a mark and a settle report.
import { describe, expect, test } from 'vitest';
import { buildFrameWatchReadJs, buildFrameWatchStartJs } from '../inpage/builders.js';
import { OBSERVER_BINDING } from '../inpage/observer.js';
import {
  createManualClock,
  createMemoryCdpSession,
  createMemoryPageInfo,
  type MemoryCdpSession,
} from '../ports/contract/index.js';
import { resolveKey } from '../support/keymap.js';
import { TOP_DOCUMENT_PROBE_JS } from '../support/observer-host.js';
import { createPageDriver, OBSERVER_EVAL_TIMEOUT_MS, pressKey } from './page-driver.js';

type Sent = { method: string; params: Record<string, unknown> };
type Answer = (params: Record<string, unknown>) => unknown;

const SETTLE = { settleMs: 150, settleTimeoutMs: 2000 };

/** A session recording every command; `evaluate` answers Runtime.evaluate
 * by expression. */
function recordingSession(
  evaluate: (expression: string, params: Record<string, unknown>) => unknown,
  extra: Record<string, Answer> = {},
): { session: MemoryCdpSession; sent: Sent[] } {
  const sent: Sent[] = [];
  const record =
    (method: string, answer: Answer): Answer =>
    (params) => {
      sent.push({ method, params });
      return answer(params);
    };
  const handlers: Record<string, Answer> = {
    'Runtime.evaluate': record('Runtime.evaluate', (p) => evaluate(String(p.expression), p)),
    'Runtime.enable': record('Runtime.enable', () => ({})),
    'Runtime.addBinding': record('Runtime.addBinding', () => ({})),
    'Page.addScriptToEvaluateOnNewDocument': record(
      'Page.addScriptToEvaluateOnNewDocument',
      () => ({
        identifier: 'script-1',
      }),
    ),
    'Page.removeScriptToEvaluateOnNewDocument': record(
      'Page.removeScriptToEvaluateOnNewDocument',
      () => ({}),
    ),
    'Input.dispatchKeyEvent': record('Input.dispatchKeyEvent', () => ({})),
  };
  for (const [method, answer] of Object.entries(extra)) handlers[method] = record(method, answer);
  return { session: createMemoryCdpSession(handlers), sent };
}

const value = (v: unknown): unknown => ({ result: { value: v } });

function driverOn(session: MemoryCdpSession, clock = createManualClock()) {
  const page = createMemoryPageInfo({ url: 'https://t.test/', title: 'T' }, clock);
  return createPageDriver({ session, page, clock });
}

/** Answers for an installed observer with a valid mark and changes. */
function observedPage(expression: string): unknown {
  if (expression === buildFrameWatchStartJs()) return value({ ok: true });
  if (expression === buildFrameWatchReadJs()) return value({ ok: true, records: 0 });
  if (expression.includes('g.mark()')) return value({ ok: true, mark: 4, doc_id: 'd1' });
  if (expression.includes('g.changes(')) {
    return value({
      ok: true,
      records: 3,
      targets: 1,
      kinds: { childList: 3, attributes: 0, characterData: 0 },
      roots: { document: true, shadow: false, frame: false },
      descriptors: [],
      overflow: 0,
    });
  }
  // What is left is the settle wait.
  return value({ settled: true, duration_ms: 150, mutation_count: 1 });
}

describe('Evaluator', () => {
  test('sends Runtime.evaluate with the user gesture and returns the value', async () => {
    const { session, sent } = recordingSession(() => value(42));
    expect(await driverOn(session).evaluator.evaluate('6 * 7')).toBe(42);
    expect(sent).toEqual([
      {
        method: 'Runtime.evaluate',
        params: { expression: '6 * 7', returnByValue: true, awaitPromise: true, userGesture: true },
      },
    ]);
  });

  test("rejects with the page's exception text, then its text, then a default", async () => {
    const answers = [
      { exceptionDetails: { exception: { description: 'TypeError: x' }, text: 'Uncaught' } },
      { exceptionDetails: { text: 'Uncaught' } },
      { exceptionDetails: {} },
    ];
    const { session } = recordingSession(() => answers.shift());
    const driver = driverOn(session);
    await expect(driver.evaluator.evaluate('x')).rejects.toThrow('TypeError: x');
    await expect(driver.evaluator.evaluate('x')).rejects.toThrow('Uncaught');
    await expect(driver.evaluator.evaluate('x')).rejects.toThrow('Evaluation failed');
  });
});

describe('Keyboard', () => {
  test('pressKey sends the key sequence in order, one command each', async () => {
    const { session, sent } = recordingSession(() => value(null));
    const enter = resolveKey('Enter');
    if (!enter) throw new Error('Enter is a known key');
    await pressKey(driverOn(session).keyboard, enter, 0);
    expect(sent.map((s) => [s.method, s.params.type])).toEqual([
      ['Input.dispatchKeyEvent', 'keyDown'],
      ['Input.dispatchKeyEvent', 'char'],
      ['Input.dispatchKeyEvent', 'keyUp'],
    ]);
  });
});

describe('observer install and teardown', () => {
  test('cdp-direct: Runtime.enable, the binding, then the new-document script', async () => {
    const { session, sent } = recordingSession(() => value(null));
    const driver = driverOn(session);
    expect(await driver.install({ enableRuntime: true })).toEqual({ ok: true });
    expect(driver.observer.installed).toBe(true);
    expect(sent.map((s) => s.method)).toEqual([
      'Runtime.enable',
      'Runtime.addBinding',
      'Page.addScriptToEvaluateOnNewDocument',
    ]);
    expect(sent[1].params).toEqual({ name: OBSERVER_BINDING });
    expect(sent[2].params.runImmediately).toBe(true);
  });

  test('extension: no Runtime.enable (connect already sent it)', async () => {
    const { session, sent } = recordingSession(() => value(null));
    await driverOn(session).install({ enableRuntime: false });
    expect(sent.map((s) => s.method)).toEqual([
      'Runtime.addBinding',
      'Page.addScriptToEvaluateOnNewDocument',
    ]);
  });

  test('a failing install reports the error and leaves the observer off', async () => {
    const { session } = recordingSession(() => value(null), {
      'Runtime.addBinding': () => {
        throw new Error('binding refused');
      },
    });
    const driver = driverOn(session);
    expect(await driver.install({ enableRuntime: false })).toEqual({
      ok: false,
      error: 'binding refused',
    });
    expect(driver.observer.installed).toBe(false);
  });

  test.each([
    ['no result', undefined],
    ['an empty result', {}],
    ['a non-string identifier', { identifier: 7 }],
    ['an empty identifier', { identifier: '' }],
  ])(
    '%s from the new-document script leaves the observer off, and a retry installs',
    async (_n, answer) => {
      let reply: unknown = answer;
      const { session, sent } = recordingSession(() => value(null), {
        'Page.addScriptToEvaluateOnNewDocument': () => reply,
      });
      const driver = driverOn(session);
      expect(await driver.install({ enableRuntime: false })).toEqual({
        ok: false,
        error: 'Page.addScriptToEvaluateOnNewDocument returned no identifier',
      });
      expect(driver.observer.installed).toBe(false);
      // Like the old cdp-direct path, the binding already added is left in place.
      expect(sent.map((s) => s.method)).toEqual([
        'Runtime.addBinding',
        'Page.addScriptToEvaluateOnNewDocument',
      ]);
      await driver.uninstall(() => true);
      expect(sent.map((s) => s.method)).not.toContain('Page.removeScriptToEvaluateOnNewDocument');

      reply = { identifier: 'script-2' };
      expect(await driver.install({ enableRuntime: false })).toEqual({ ok: true });
      expect(driver.observer.installed).toBe(true);
      await driver.uninstall(() => false);
      const removal = sent.find((s) => s.method === 'Page.removeScriptToEvaluateOnNewDocument');
      expect(removal?.params).toEqual({ identifier: 'script-2' });
    },
  );

  test('an identifier from the new-document script is kept for the removal', async () => {
    const { session, sent } = recordingSession(() => value(null));
    const driver = driverOn(session);
    expect(await driver.install({ enableRuntime: false })).toEqual({ ok: true });
    expect(driver.observer.installed).toBe(true);
    await driver.uninstall(() => false);
    expect(
      sent.find((s) => s.method === 'Page.removeScriptToEvaluateOnNewDocument')?.params,
    ).toEqual({ identifier: 'script-1' });
  });

  test('uninstall removes the script, then tears the page down when asked', async () => {
    const { session, sent } = recordingSession(() => value(null));
    const driver = driverOn(session);
    await driver.install({ enableRuntime: false });
    sent.length = 0;
    await driver.uninstall(() => true);
    expect(sent.map((s) => s.method)).toEqual([
      'Page.removeScriptToEvaluateOnNewDocument',
      'Runtime.evaluate',
    ]);
    expect(sent[0].params).toEqual({ identifier: 'script-1' });
    expect(sent[1].params.userGesture).toBeUndefined();
    sent.length = 0;
    await driver.uninstall(() => true);
    expect(sent).toEqual([]);
  });

  test('uninstall skips the in-page teardown when told not to', async () => {
    const { session, sent } = recordingSession(() => value(null));
    const driver = driverOn(session);
    await driver.install({ enableRuntime: true });
    sent.length = 0;
    await driver.uninstall(() => false);
    expect(sent.map((s) => s.method)).toEqual(['Page.removeScriptToEvaluateOnNewDocument']);
  });
});

describe('binding messages', () => {
  const docStart = JSON.stringify({
    type: 'doc_start',
    doc_id: 'd1',
    url: 'https://t.test/a',
    coverage: 'full',
  });

  test('a top-document doc_start is applied and handed on', async () => {
    const { session, sent } = recordingSession((e) =>
      value(e === TOP_DOCUMENT_PROBE_JS ? { doc_id: 'd1' } : null),
    );
    const driver = driverOn(session);
    const seen: unknown[] = [];
    await driver.install({ enableRuntime: false, onTopDocument: (o) => void seen.push(o) });
    session.emit('Runtime.bindingCalled', { name: OBSERVER_BINDING, payload: docStart });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    expect(driver.observer.doc_id).toBe('d1');
    expect(sent.at(-1)?.params).toEqual({ expression: TOP_DOCUMENT_PROBE_JS, returnByValue: true });
  });

  test('another binding, or a message from a child frame, is not handed on', async () => {
    const { session } = recordingSession(() => value({ doc_id: 'other' }));
    const driver = driverOn(session);
    const seen: unknown[] = [];
    await driver.install({ enableRuntime: false, onTopDocument: (o) => void seen.push(o) });
    session.emit('Runtime.bindingCalled', { name: 'someone-else', payload: docStart });
    session.emit('Runtime.bindingCalled', { name: OBSERVER_BINDING, payload: docStart });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([]);
  });

  test('topDocumentSettled waits for every message received so far to be handed on', async () => {
    let answerProbe: (v: unknown) => void = () => undefined;
    const probe = new Promise((resolve) => {
      answerProbe = resolve;
    });
    const { session } = recordingSession((e) =>
      e === TOP_DOCUMENT_PROBE_JS ? probe : value(null),
    );
    const driver = driverOn(session);
    const seen: unknown[] = [];
    await driver.install({ enableRuntime: false, onTopDocument: (o) => void seen.push(o) });
    session.emit('Runtime.bindingCalled', { name: OBSERVER_BINDING, payload: docStart });
    let settled = false;
    const settling = driver.topDocumentSettled().then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    answerProbe(value({ doc_id: 'd1' }));
    await settling;
    expect(seen).toHaveLength(1);
  });

  test('topDocumentSettled resolves at once with nothing in flight, and after a failed probe', async () => {
    const { session } = recordingSession((e) => {
      if (e === TOP_DOCUMENT_PROBE_JS) throw new Error('renderer gone');
      return value(null);
    });
    const driver = driverOn(session);
    const seen: unknown[] = [];
    await driver.install({ enableRuntime: false, onTopDocument: (o) => void seen.push(o) });
    await driver.topDocumentSettled();
    session.emit('Runtime.bindingCalled', { name: OBSERVER_BINDING, payload: docStart });
    await driver.topDocumentSettled();
    expect(seen).toEqual([]);
  });
});

describe('Settler', () => {
  test('settle off: no mark, no commands, no report', async () => {
    const { session, sent } = recordingSession(observedPage);
    const driver = driverOn(session);
    const mark = await driver.settler.mark(null);
    expect(mark).toEqual({ kind: 'none' });
    expect(await driver.settler.settle(null, mark)).toBeUndefined();
    expect(sent).toEqual([]);
  });

  test('observer not installed: the frame watch is armed, the report says unavailable', async () => {
    const { session } = recordingSession(observedPage);
    const driver = driverOn(session);
    const mark = await driver.settler.mark(SETTLE);
    expect(mark).toEqual({ kind: 'unavailable', reason: 'observer-unavailable' });
    expect(await driver.settler.settle(SETTLE, mark)).toEqual({
      settled: true,
      duration_ms: 150,
      mutation_count: 1,
      changes: null,
      observer: 'observer-unavailable',
    });
  });

  test('marked: the changes since the mark replace the mutation count', async () => {
    const { session, sent } = recordingSession(observedPage);
    const driver = driverOn(session);
    await driver.install({ enableRuntime: false });
    sent.length = 0;
    const mark = await driver.settler.mark(SETTLE);
    expect(mark).toEqual({ kind: 'marked', mark: { mark: 4, doc_id: 'd1' } });
    const report = await driver.settler.settle(SETTLE, mark);
    expect(report?.mutation_count).toBe(3);
    expect(report?.changes?.records).toBe(3);
    // frame watch start, mark, frame watch read, settle wait, changes read
    expect(sent.map((s) => s.params.userGesture === true)).toEqual([
      true,
      false,
      true,
      true,
      false,
    ]);
  });

  test("a mark the page refused keeps the page's reason", async () => {
    const { session } = recordingSession((e) =>
      e.includes('g.mark()') ? value({ ok: false, reason: 'doc-changed' }) : observedPage(e),
    );
    const driver = driverOn(session);
    await driver.install({ enableRuntime: false });
    const mark = await driver.settler.mark(SETTLE);
    expect(mark).toEqual({ kind: 'unavailable', reason: 'doc-changed' });
    expect((await driver.settler.settle(SETTLE, mark))?.observer).toBe('doc-changed');
  });

  test('a malformed mark is a changes error', async () => {
    const { session } = recordingSession((e) =>
      e.includes('g.mark()') ? value({ ok: true }) : observedPage(e),
    );
    const driver = driverOn(session);
    await driver.install({ enableRuntime: false });
    expect(await driver.settler.mark(SETTLE)).toEqual({
      kind: 'unavailable',
      reason: 'changes-error',
    });
  });

  test('a changes read that fails reports doc-changed', async () => {
    const { session } = recordingSession((e) => {
      if (e.includes('g.changes(')) throw new Error('Execution context was destroyed');
      return observedPage(e);
    });
    const driver = driverOn(session);
    await driver.install({ enableRuntime: false });
    const report = await driver.settler.settle(SETTLE, await driver.settler.mark(SETTLE));
    expect(report).toMatchObject({ changes: null, observer: 'doc-changed' });
  });

  test('frame records seen before the wait are added to its counts', async () => {
    const { session } = recordingSession((e) =>
      e === buildFrameWatchReadJs() ? value({ ok: true, records: 2 }) : observedPage(e),
    );
    const driver = driverOn(session);
    const report = await driver.settler.settle(SETTLE, { kind: 'none' });
    expect(report?.mutation_count).toBe(3);
    expect(report).not.toHaveProperty('frame_mutation_count');
  });

  test('an observer read that never answers gives up after the timeout', async () => {
    const clock = createManualClock();
    const { session } = recordingSession((e, params) =>
      params.userGesture === true ? observedPage(e) : new Promise(() => undefined),
    );
    const driver = driverOn(session, clock);
    await driver.install({ enableRuntime: false });
    let outcome: unknown = 'pending';
    void driver.settler.mark(SETTLE).then((m) => (outcome = m));
    // Let the frame watch answer and the observer read start its timer.
    await new Promise((r) => setTimeout(r, 0));
    await clock.advance(OBSERVER_EVAL_TIMEOUT_MS - 1);
    expect(outcome).toBe('pending');
    await clock.advance(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'observer-unavailable' });
  });
});
