import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { DoctorView } from './doctor.js';
import type { DoctorReport } from '../../commands/doctor.js';
import { PINNED_EXTENSION_ID } from '../../auth/extension-id.js';

/* The Doctor screen renders the formatted rows of an injected runner's
 * report; no port, process or client file is probed. The real runner is
 * mocked to record a call, so a screen that ignored the injected one fails
 * here instead of probing this machine. */

const realRun = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../commands/doctor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../commands/doctor.js')>();
  return {
    ...actual,
    runDoctor: () => {
      realRun.calls++;
      return new Promise<never>(() => {});
    },
  };
});

const noop = (): void => undefined;

async function tick(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  realRun.calls = 0;
});

const REPORT: DoctorReport = {
  ws: { listening: true, detail: 'browser-link primary', host: '127.0.0.1', port: 17529 },
  ipc: { listening: false, detail: 'nothing listening', host: '127.0.0.1', port: 17530 },
  multiAgent: { enabled: true, autoReelect: false },
  clients: [
    {
      id: 'claude-code',
      displayName: 'Claude Code',
      installed: true,
      registered: true,
      configPath: '/home/u/.claude.json',
      instructions: { state: { kind: 'no-file' }, filePath: '/home/u/CLAUDE.md' },
    },
  ],
  extension: { path: '/ext/dist' },
  map: { dbPath: '/data/map.db', exists: true, sizeBytes: 2048, apps: 3 },
  security: { allowedBrowsers: ['chrome.exe'], allowedExtensionIds: [PINNED_EXTENSION_ID] },
  silentDebugger: { detected: null },
  server: {
    running: { version: '0.48.0', pid: 4242, startedAt: '2026-11-09T11:00:00.000Z' },
    installed: '0.48.0',
    outdated: false,
  },
  processes: [{ pid: 4242, startedAt: null, command: 'node browser-link' }],
};

describe('DoctorView', () => {
  test('renders the result rows of the injected runner', async () => {
    const run = vi.fn(async () => REPORT);
    const { lastFrame, unmount } = render(
      <DoctorView language="en" onBack={noop} runDoctor={run} />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(run).toHaveBeenCalledOnce();
    expect(realRun.calls).toBe(0);
    expect(frame).toContain('127.0.0.1:17529 — browser-link primary');
    expect(frame).toContain('free (no primary on this machine)');
    expect(frame).toContain('running 0.48.0 (pid 4242)');
    expect(frame).toContain('Claude Code');
    expect(frame).toContain('/home/u/.claude.json');
    expect(frame).toContain('PID 4242');
    expect(frame).toContain('/ext/dist');
    unmount();
  });

  test('shows the spinner line while the runner is in flight', () => {
    const view = render(
      <DoctorView language="en" onBack={noop} runDoctor={() => new Promise(() => {})} />,
    );
    expect(view.lastFrame()).toContain('Diagnosing…');
    view.unmount();
  });

  test('r re-runs the injected runner; Enter goes back', async () => {
    const run = vi.fn(async () => REPORT);
    const onBack = vi.fn();
    const { stdin, unmount } = render(<DoctorView language="en" onBack={onBack} runDoctor={run} />);
    await tick();
    stdin.write('r');
    await tick();
    expect(run).toHaveBeenCalledTimes(2);
    stdin.write('\r');
    await tick();
    expect(onBack).toHaveBeenCalledOnce();
    unmount();
  });
});
