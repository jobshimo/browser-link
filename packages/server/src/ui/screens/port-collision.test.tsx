import { describe, expect, test } from 'vitest';
import { render } from 'ink-testing-library';
import { PortCollisionView } from './port-collision.js';

/* Render + interaction tests for the PortCollision state. */
const noop = (): void => undefined;

describe('PortCollisionView render', () => {
  test('renders the EN title, PID, and the fix paths', () => {
    const { lastFrame } = render(
      <PortCollisionView
        language="en"
        info={{ pid: 52817, cmdline: 'node /usr/local/lib/browser-link/server.js' }}
        onKill={noop}
        onMultiAgent={noop}
        onRetry={noop}
        onQuit={noop}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Port 17529 is already in use');
    expect(frame).toContain('52817');
    expect(frame).toContain('Process holding the port');
    expect(frame).toContain('Fix paths');
    expect(frame).toContain('Kill the stuck process');
    expect(frame).toContain('Switch to multi-agent');
    expect(frame).toContain('Retry');
    expect(frame).toContain('Quit');
  });

  test('renders the ES title and ES fix paths', () => {
    const { lastFrame } = render(
      <PortCollisionView language="es" info={{ pid: 1234, cmdline: null }} onQuit={noop} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('puerto 17529');
    expect(frame).toContain('arreglarlo');
  });

  test('renders "unknown" when PID is null', () => {
    const { lastFrame } = render(
      <PortCollisionView language="en" info={{ pid: null, cmdline: null }} onQuit={noop} />,
    );
    expect(lastFrame() ?? '').toContain('unknown');
  });

  test("'k' fires onKill", async () => {
    let killCalls = 0;
    const onKill = () => {
      killCalls += 1;
    };
    const { stdin } = render(
      <PortCollisionView
        language="en"
        info={{ pid: 52817, cmdline: null }}
        onKill={onKill}
        onMultiAgent={noop}
        onRetry={noop}
        onQuit={noop}
      />,
    );
    await new Promise((resolve) => setImmediate(resolve));
    stdin.write('k');
    await new Promise((resolve) => setImmediate(resolve));
    expect(killCalls).toBe(1);
  });

  test("'q' fires onQuit", async () => {
    let quitCalls = 0;
    const onQuit = () => {
      quitCalls += 1;
    };
    const { stdin } = render(
      <PortCollisionView language="en" info={{ pid: 52817, cmdline: null }} onQuit={onQuit} />,
    );
    await new Promise((resolve) => setImmediate(resolve));
    stdin.write('q');
    await new Promise((resolve) => setImmediate(resolve));
    expect(quitCalls).toBe(1);
  });
});
