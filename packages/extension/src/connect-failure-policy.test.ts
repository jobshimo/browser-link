import { describe, expect, test, vi } from 'vitest';
import { createConnectFailureTracker } from './connect-failure-policy.js';
import type { WorkerMessage } from './worker-messages.js';

const REFUSED: WorkerMessage = {
  code: 'ws-handshake-refused',
  values: { reason: 'origin-not-allowed' },
};

/** A tracker over a once-only settle like background.ts's, with a
 * diagnosis the test resolves by hand. */
function setup() {
  let settled = false;
  const settle = vi.fn((_message: WorkerMessage) => {
    settled = true;
  });
  let answer!: (message: WorkerMessage) => void;
  const diagnose = vi.fn(
    () =>
      new Promise<WorkerMessage>((resolve) => {
        answer = resolve;
      }),
  );
  const tracker = createConnectFailureTracker({ isSettled: () => settled, settle, diagnose });
  return { tracker, settle, diagnose, answer: (m: WorkerMessage) => answer(m) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createConnectFailureTracker — a connect refused before registration', () => {
  test('error then close: exactly one settle, carrying the diagnosed refusal', async () => {
    const { tracker, settle, diagnose, answer } = setup();
    tracker.onError();
    tracker.onClose();
    expect(settle).not.toHaveBeenCalled();
    answer(REFUSED);
    await flush();
    expect(diagnose).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(REFUSED);
  });

  test('the close handler holds back ws-closed-before-registration only while a diagnosis is pending', async () => {
    const { tracker, settle, answer } = setup();
    tracker.onError();
    tracker.onClose();
    expect(settle).not.toHaveBeenCalled();
    answer(REFUSED);
    await flush();
    tracker.onClose();
    expect(settle.mock.calls.map(([m]) => m.code)).toEqual([
      'ws-handshake-refused',
      'ws-closed-before-registration',
    ]);
  });

  test('a close without a preceding error settles as before, without a diagnosis', () => {
    const { tracker, settle, diagnose } = setup();
    tracker.onClose();
    expect(diagnose).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith({ code: 'ws-closed-before-registration' });
  });

  test('an error after the attempt settled (a post-registration drop) asks nothing', () => {
    const { tracker, settle, diagnose } = setup();
    tracker.onClose();
    tracker.onError();
    expect(diagnose).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledOnce();
  });

  test('a second error does not start a second diagnosis', async () => {
    const { tracker, settle, diagnose, answer } = setup();
    tracker.onError();
    tracker.onError();
    answer(REFUSED);
    await flush();
    expect(diagnose).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
  });

  test('a diagnosis that rejects settles with the generic connect failure', async () => {
    const settle = vi.fn();
    const tracker = createConnectFailureTracker({
      isSettled: () => false,
      settle,
      diagnose: () => Promise.reject(new Error('boom')),
    });
    tracker.onError();
    tracker.onClose();
    await flush();
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith({ code: 'ws-connect-failed' });
  });
});
