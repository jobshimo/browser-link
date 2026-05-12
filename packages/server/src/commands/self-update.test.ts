import { afterEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { runSelfUpdate, type SelfUpdateProgress } from './self-update.js';

/**
 * Build a minimal fake `ChildProcess` for `spawn` stubs. Tests drive it by
 * emitting `data` on the stderr stream, then `close` with an exit code.
 */
function makeFakeChild(options: { exitCode?: number; stderr?: string } = {}): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  const stderr = new EventEmitter() as NodeJS.ReadableStream;
  const stdout = new EventEmitter() as NodeJS.ReadableStream;
  emitter.stderr = stderr;
  emitter.stdout = stdout;
  // Fire 'data' + 'close' on the next tick so listeners attached after the
  // spawn() return still see them.
  setImmediate(() => {
    if (options.stderr) stderr.emit('data', Buffer.from(options.stderr));
    emitter.emit('close', options.exitCode ?? 0);
  });
  return emitter;
}

describe('runSelfUpdate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('emits preflight → stopping-primary → installing → done on success', async () => {
    const events: SelfUpdateProgress[] = [];
    const spawnImpl = vi.fn(() => makeFakeChild({ exitCode: 0 }));

    const result = await runSelfUpdate('0.5.3', 'en', (e) => events.push(e), {
      packageName: '@example/pkg',
      skipFreePort: true,
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    expect(result.ok).toBe(true);
    expect(result.target).toBe('0.5.3');
    expect(result.message).toMatch(/Installed.*0\.5\.3/);
    expect(events.map((e) => e.stage)).toEqual(['preflight', 'installing', 'done']);
    expect(spawnImpl).toHaveBeenCalledWith('npm', ['install', '-g', '@example/pkg@0.5.3'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  test('emits a stopping-primary event before the install when port-freeing is on', async () => {
    const events: SelfUpdateProgress[] = [];
    const spawnImpl = vi.fn(() => makeFakeChild({ exitCode: 0 }));

    // We don't mock runFreePort itself — it might find or not find a primary
    // on the test runner. Either way the stage label appears in events.
    await runSelfUpdate('latest', 'en', (e) => events.push(e), {
      packageName: '@example/pkg',
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    expect(events.map((e) => e.stage)).toEqual([
      'preflight',
      'stopping-primary',
      'installing',
      'done',
    ]);
  });

  test('returns ok=false and captures stderr when npm install exits non-zero', async () => {
    const spawnImpl = vi.fn(() =>
      makeFakeChild({
        exitCode: 1,
        stderr: 'npm error code E403\nnpm error 403 Forbidden — Put',
      }),
    );

    const result = await runSelfUpdate('0.5.3', 'en', undefined, {
      packageName: '@example/pkg',
      skipFreePort: true,
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('403 Forbidden');
    expect(result.stderr).toContain('E403');
  });

  test('returns ok=false when spawn emits an error event (e.g. npm not found)', async () => {
    const spawnImpl = vi.fn(() => {
      const emitter = new EventEmitter() as ChildProcess;
      emitter.stderr = new EventEmitter() as NodeJS.ReadableStream;
      emitter.stdout = new EventEmitter() as NodeJS.ReadableStream;
      setImmediate(() => {
        emitter.emit('error', new Error('spawn npm ENOENT'));
      });
      return emitter;
    });

    const result = await runSelfUpdate('0.5.3', 'en', undefined, {
      packageName: '@example/pkg',
      skipFreePort: true,
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('ENOENT');
  });

  test('respects the Spanish language for the user-facing messages', async () => {
    const events: SelfUpdateProgress[] = [];
    const spawnImpl = vi.fn(() => makeFakeChild({ exitCode: 0 }));

    const result = await runSelfUpdate('latest', 'es', (e) => events.push(e), {
      packageName: '@example/pkg',
      skipFreePort: true,
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    expect(result.message).toContain('Instalado');
    expect(events.find((e) => e.stage === 'preflight')!.message).toContain('Actualizando');
  });
});
