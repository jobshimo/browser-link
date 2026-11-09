import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useBackgroundUpdateCheck, type UpdateCheckState } from './use-update-check.js';

/* `useBackgroundUpdateCheck` with its `runCheck` seam: one check on mount,
 * one per interval, none from rendering itself. Only the interval timers
 * are faked so ink's own rendering keeps real time. */

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

afterEach(() => {
  vi.useRealTimers();
});

function Probe(props: {
  runCheck: () => Promise<UpdateCheckState>;
  intervalMs?: number;
  onRender: (callsAtRender: number) => void;
  calls: () => number;
}) {
  props.onRender(props.calls());
  const state = useBackgroundUpdateCheck({
    runCheck: props.runCheck,
    intervalMs: props.intervalMs,
  });
  return <Text>{state.isNewer ? `update ${state.latest ?? ''}` : 'no banner'}</Text>;
}

describe('useBackgroundUpdateCheck', () => {
  test('checks once on mount, never while rendering, and exposes the result', async () => {
    const runCheck = vi.fn(async () => ({ latest: '0.49.0', isNewer: true }));
    const callsAtRender: number[] = [];
    const view = render(
      <Probe
        runCheck={runCheck}
        onRender={(n) => callsAtRender.push(n)}
        calls={() => runCheck.mock.calls.length}
      />,
    );
    // The first render ran before any check: the check lives in an effect.
    expect(callsAtRender[0]).toBe(0);
    await flush();
    expect(runCheck).toHaveBeenCalledOnce();
    expect(view.lastFrame()).toBe('update 0.49.0');
    // The re-render the result caused did not check again.
    expect(callsAtRender.length).toBeGreaterThan(1);
    expect(runCheck).toHaveBeenCalledOnce();
    view.unmount();
  });

  test('checks again once per interval, and stops on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const runCheck = vi.fn(async () => ({ latest: null, isNewer: false }));
    const view = render(
      <Probe
        runCheck={runCheck}
        intervalMs={1000}
        onRender={() => undefined}
        calls={() => runCheck.mock.calls.length}
      />,
    );
    await flush();
    expect(runCheck).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(runCheck).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2999);
    expect(runCheck).toHaveBeenCalledTimes(4);
    view.unmount();
    vi.advanceTimersByTime(5000);
    expect(runCheck).toHaveBeenCalledTimes(4);
  });

  test('a failing check is silent and keeps the previous state', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const runCheck = vi
      .fn<() => Promise<UpdateCheckState>>()
      .mockResolvedValueOnce({ latest: '0.49.0', isNewer: true })
      .mockRejectedValueOnce(new Error('offline'));
    const view = render(
      <Probe
        runCheck={runCheck}
        intervalMs={1000}
        onRender={() => undefined}
        calls={() => runCheck.mock.calls.length}
      />,
    );
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(runCheck).toHaveBeenCalledTimes(2);
    expect(view.lastFrame()).toBe('update 0.49.0');
    view.unmount();
  });
});
