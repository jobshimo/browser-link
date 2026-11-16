import { describe, expect, test, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { UpdatesView } from './updates.js';
import type { UpdateInfo } from '../../commands/updates.js';
import type {
  SelfUpdateProgressCallback,
  SelfUpdateResult,
  UpdatePlan,
} from '../../commands/self-update.js';

/* D18 on the Updates screen: the key u says what will happen and asks; the
 * install can be cancelled; the result says everything; u is disabled once
 * finished. The real self-update module is replaced for the whole file, so
 * no test can stop a process or run npm even if the screen ignored its
 * injected effects (the mocks record a call, and the tests assert none). */

const real = vi.hoisted(() => ({ runs: 0, plans: 0 }));
vi.mock('../../commands/self-update.js', () => ({
  SELF_UPDATE_TIMEOUT_MS: 600_000,
  runSelfUpdate: () => {
    real.runs++;
    return new Promise<never>(() => {});
  },
  readUpdatePlan: () => {
    real.plans++;
    return new Promise<never>(() => {});
  },
}));

const NEWER: UpdateInfo = { current: '1.0.2', latest: '1.1.0', newer: true };

const WINDOWS_PLAN: UpdatePlan = {
  stopsServer: true,
  server: { kind: 'running', version: '1.0.2', pid: 4242 },
  otherProcesses: 2,
};

const UNIX_PLAN: UpdatePlan = {
  stopsServer: false,
  server: { kind: 'running', version: '1.0.2', pid: 4242 },
  otherProcesses: 0,
};

/** The frame's text with the box borders and the line wrapping removed, so
 * a sentence the frame wraps still reads as one. */
function flat(frame: string | undefined): string {
  return (frame ?? '').replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');
}

async function tick(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type RunUpdate = (
  target: string,
  language: 'en' | 'es',
  onProgress: SelfUpdateProgressCallback,
  signal: AbortSignal,
) => Promise<SelfUpdateResult>;

/** A run the test finishes by hand. */
function controllableRun() {
  let finishRun: (r: SelfUpdateResult) => void = () => undefined;
  let progress: SelfUpdateProgressCallback = () => undefined;
  let signal: AbortSignal | null = null;
  const runUpdate = vi.fn<RunUpdate>((_target, _language, onProgress, s) => {
    progress = onProgress;
    signal = s;
    return new Promise<SelfUpdateResult>((resolve) => {
      finishRun = resolve;
    });
  });
  return {
    runUpdate,
    finish: (r: SelfUpdateResult) => finishRun(r),
    progress: (stage: 'installing', message: string) => progress({ stage, message }),
    signal: () => signal,
  };
}

function renderScreen(
  language: 'en' | 'es',
  plan: UpdatePlan,
  runUpdate: RunUpdate,
  onBack = vi.fn(),
) {
  const readPlan = vi.fn(async () => plan);
  const view = render(
    <UpdatesView
      language={language}
      onBack={onBack}
      checkUpdates={async () => NEWER}
      readPlan={readPlan}
      runUpdate={runUpdate}
    />,
  );
  return { ...view, readPlan, onBack };
}

const FAILED: SelfUpdateResult = {
  ok: false,
  outcome: 'failed',
  target: '1.1.0',
  message: '✗ Update failed: npm error code E404\nnpm error 404 Not Found',
  stopReport: '✓ Stopped browser-link primary (PID 4242). Port 127.0.0.1:17529 is now free.',
  nextStep:
    "Nothing was installed. Run `npm install -g @jobshimo/browser-link@1.1.0` in a terminal to see npm's full output.",
  stderr: 'npm error code E404',
};

describe('UpdatesView — D18: say what will happen and ask first', () => {
  test('u shows what the update will do (Windows) and touches nothing', async () => {
    const run = controllableRun();
    const { stdin, lastFrame, readPlan, unmount } = renderScreen('en', WINDOWS_PLAN, run.runUpdate);
    await tick();
    stdin.write('u');
    await tick();
    const frame = flat(lastFrame());
    expect(readPlan).toHaveBeenCalledOnce();
    expect(run.runUpdate).not.toHaveBeenCalled();
    expect(real.runs).toBe(0);
    expect(real.plans).toBe(0);
    expect(frame).toContain('Update to 1.1.0?');
    expect(frame).toContain('A browser-link server is running: version 1.0.2, PID 4242.');
    expect(frame).toContain('How many agent sessions use it cannot be read from this console.');
    expect(frame).toContain(
      '2 other browser-link processes are running (agents connected through the server, or other consoles).',
    );
    expect(frame).toContain(
      'It will be stopped before the install: Windows keeps the files of a running server locked.',
    );
    expect(frame).toContain('Agents using it lose browser-link until their MCP client restarts.');
    expect(frame).toContain('Other browser-link processes are not stopped.');
    expect(frame).toContain('Then: npm install -g @jobshimo/browser-link@1.1.0');
    expect(frame).toContain('stopped after 10 minutes at most; press c to cancel it sooner.');
    expect(frame).toContain('Update now?');
    unmount();
  });

  test('Spanish: the preview on macOS or Linux says nothing will be stopped', async () => {
    const run = controllableRun();
    const { stdin, lastFrame, unmount } = renderScreen('es', UNIX_PLAN, run.runUpdate);
    await tick();
    stdin.write('u');
    await tick();
    const frame = flat(lastFrame());
    expect(run.runUpdate).not.toHaveBeenCalled();
    expect(frame).toContain('¿Actualizar a 1.1.0?');
    expect(frame).toContain('Hay un servidor browser-link corriendo: versión 1.0.2, PID 4242.');
    expect(frame).toContain(
      'Desde esta consola no se puede leer cuántas sesiones de agentes lo usan.',
    );
    expect(frame).toContain('No hay otros procesos de browser-link corriendo.');
    expect(frame).toContain(
      'No se va a detener nada. Un servidor en marcha sigue con la versión anterior hasta que su cliente MCP se reinicie.',
    );
    expect(frame).toContain('Después: npm install -g @jobshimo/browser-link@1.1.0');
    expect(frame).toContain(
      'se corta a los 10 minutos como mucho; apretá c para cancelarla antes.',
    );
    expect(frame).toContain('¿Actualizar ahora?');
    unmount();
  });

  test('a preview that could not read the server says so, with no number', async () => {
    const run = controllableRun();
    const { stdin, lastFrame, unmount } = renderScreen(
      'en',
      { stopsServer: true, server: { kind: 'unreadable' }, otherProcesses: null },
      run.runUpdate,
    );
    await tick();
    stdin.write('u');
    await tick();
    const frame = flat(lastFrame());
    expect(frame).toContain('Could not read whether a browser-link server is running.');
    expect(frame).toContain('The other browser-link processes could not be listed.');
    expect(frame).toContain(
      'If a server is running, it will be stopped before the install (Windows keeps its files locked).',
    );
    expect(frame).not.toMatch(/\d+ other browser-link process/);
    unmount();
  });

  test('n answers no: nothing runs and the screen is back to the offer', async () => {
    const run = controllableRun();
    const { stdin, lastFrame, unmount } = renderScreen('en', WINDOWS_PLAN, run.runUpdate);
    await tick();
    stdin.write('u');
    await tick();
    stdin.write('n');
    await tick();
    expect(run.runUpdate).not.toHaveBeenCalled();
    expect(flat(lastFrame())).toContain('to update now (shows what it will do and asks first).');
    unmount();
  });

  test('Esc answers no too, and does not leave the screen', async () => {
    const run = controllableRun();
    const { stdin, onBack, unmount } = renderScreen('en', WINDOWS_PLAN, run.runUpdate);
    await tick();
    stdin.write('u');
    await tick();
    stdin.write('\u001B');
    await tick();
    expect(run.runUpdate).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    unmount();
  });

  test('y runs the update with the exact version the registry reported', async () => {
    const run = controllableRun();
    const { stdin, lastFrame, unmount } = renderScreen('en', WINDOWS_PLAN, run.runUpdate);
    await tick();
    stdin.write('u');
    await tick();
    stdin.write('y');
    await tick();
    expect(run.runUpdate).toHaveBeenCalledOnce();
    expect(run.runUpdate.mock.calls[0][0]).toBe('1.1.0');
    expect(run.runUpdate.mock.calls[0][1]).toBe('en');
    run.progress('installing', 'Running: npm install -g @jobshimo/browser-link@1.1.0');
    await tick();
    const frame = flat(lastFrame());
    expect(frame).toContain('Updating…');
    expect(frame).toContain('Running: npm install -g @jobshimo/browser-link@1.1.0');
    expect(frame).toContain('Press c to cancel the install.');
    unmount();
  });
});

describe('UpdatesView — D18: the install can be cancelled', () => {
  test('c cancels the running install; other keys do nothing', async () => {
    const run = controllableRun();
    const { stdin, onBack, unmount } = renderScreen('en', WINDOWS_PLAN, run.runUpdate);
    await tick();
    stdin.write('u');
    await tick();
    stdin.write('y');
    await tick();
    stdin.write('\r');
    stdin.write('u');
    stdin.write('r');
    await tick();
    expect(onBack).not.toHaveBeenCalled();
    expect(run.runUpdate).toHaveBeenCalledOnce();
    expect(run.signal()?.aborted).toBe(false);
    stdin.write('c');
    await tick();
    expect(run.signal()?.aborted).toBe(true);
    unmount();
  });

  test('Spanish: the running screen names the cancel key', async () => {
    const run = controllableRun();
    const { stdin, lastFrame, unmount } = renderScreen('es', WINDOWS_PLAN, run.runUpdate);
    await tick();
    stdin.write('u');
    await tick();
    stdin.write('y');
    await tick();
    expect(flat(lastFrame())).toContain('Apretá c para cancelar la instalación.');
    unmount();
  });
});

describe('UpdatesView — D18: the result says everything, and u is disabled after', () => {
  test('a failed update shows what was stopped, the real error and what to do next', async () => {
    const run = controllableRun();
    const { stdin, lastFrame, unmount } = renderScreen('en', WINDOWS_PLAN, run.runUpdate);
    await tick();
    stdin.write('u');
    await tick();
    stdin.write('y');
    await tick();
    run.finish(FAILED);
    await tick();
    const frame = flat(lastFrame());
    expect(frame).toContain(
      '✓ Stopped browser-link primary (PID 4242). Port 127.0.0.1:17529 is now free.',
    );
    expect(frame).toContain('✗ Update failed: npm error code E404');
    expect(frame).toContain('npm error 404 Not Found');
    // One glyph, not the doubled "✗ ✗" the screen used to print.
    expect(frame).not.toContain('✗ ✗');
    expect(frame).toContain('Nothing was installed. Run `npm install -g');
    unmount();
  });

  test('after a finished update u does nothing and is not offered', async () => {
    const run = controllableRun();
    const { stdin, lastFrame, unmount } = renderScreen('en', WINDOWS_PLAN, run.runUpdate);
    await tick();
    stdin.write('u');
    await tick();
    stdin.write('y');
    await tick();
    run.finish({
      ...FAILED,
      ok: true,
      outcome: 'installed',
      message: '✓ Installed browser-link@1.1.0.',
    });
    await tick();
    stdin.write('u');
    await tick();
    stdin.write('y');
    await tick();
    expect(run.runUpdate).toHaveBeenCalledOnce();
    const frame = flat(lastFrame());
    expect(frame).not.toContain('Update to 1.1.0?');
    expect(frame).not.toContain('u update');
    unmount();
  });

  test('after a failed update r still re-checks, and u stays disabled', async () => {
    const run = controllableRun();
    const check = vi.fn(async () => NEWER);
    const view = render(
      <UpdatesView
        language="es"
        onBack={vi.fn()}
        checkUpdates={check}
        readPlan={async () => WINDOWS_PLAN}
        runUpdate={run.runUpdate}
      />,
    );
    await tick();
    view.stdin.write('u');
    await tick();
    view.stdin.write('y');
    await tick();
    run.finish({ ...FAILED, message: '✗ La actualización falló: npm error code E404' });
    await tick();
    view.stdin.write('r');
    await tick();
    expect(check).toHaveBeenCalledTimes(2);
    view.stdin.write('u');
    await tick();
    expect(flat(view.lastFrame())).not.toContain('¿Actualizar a 1.1.0?');
    expect(flat(view.lastFrame())).toContain('✗ La actualización falló: npm error code E404');
    expect(run.runUpdate).toHaveBeenCalledOnce();
    view.unmount();
  });
});
