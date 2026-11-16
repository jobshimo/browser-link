import { afterEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  readUpdatePlan,
  loadsNativeSqlite,
  neutralCwd,
  readInstalledPackageVersion,
  resolveNpmCliJs,
  runSelfUpdate,
  SELF_UPDATE_TIMEOUT_MS,
  type InstalledRead,
  type SelfUpdateProgress,
} from './self-update.js';

// Never run the real `stop` from a test: since 0.41.0 it ends every live
// browser-link process on the machine, not only the port owner.
vi.mock('./free-port.js', () => ({
  runFreePort: vi.fn(() => ({
    portState: 'free',
    ok: true,
    pid: null,
    imageName: null,
    message: 'free',
  })),
}));

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

/** The read-back of the installed version, injected: no test runs npm. For
 * `latest` it answers a fixed version. */
function readBack(target: string): () => Promise<InstalledRead> {
  const version = target === 'latest' ? '9.9.9' : target;
  return () => Promise.resolve({ kind: 'read', version });
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
      readInstalled: readBack('0.5.3'),
      consoleHoldsNativeModule: () => false,
      // Pin the binary AND the shell decision so the assertion below does
      // not depend on the runner OS (production resolves to 'npm.cmd' +
      // shell on Windows, 'npm' with no shell elsewhere). Before this was
      // pinned the test passed on CI's Ubuntu and failed on a Windows dev
      // machine — a real gap, not a cosmetic one.
      npmBin: 'npm',
      useShell: false,
      skipFreePort: true,
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    expect(result.ok).toBe(true);
    expect(result.target).toBe('0.5.3');
    expect(result.message).toMatch(/Installed.*0\.5\.3/);
    expect(events.map((e) => e.stage)).toEqual(['preflight', 'installing', 'done']);
    expect(spawnImpl).toHaveBeenCalledWith('npm', ['install', '-g', '@example/pkg@0.5.3'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // A neutral directory, never the console's own (S5).
      cwd: homedir(),
    });
  });

  test('FALLBACK on Windows: npm.cmd WITH a shell when npm-cli.js is unresolvable', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const spawnImpl = vi.fn(() => makeFakeChild({ exitCode: 0 }));

    await runSelfUpdate('0.5.3', 'en', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack('0.5.3'),
      consoleHoldsNativeModule: () => false,
      npmCliJs: null,
      skipFreePort: true,
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    // Both halves matter on Windows and only having the first was the bug:
    // naming the .cmd shim avoids ENOENT, but since Node 18.20.2/20.12.2/
    // 21.7.3 spawning a .cmd WITHOUT a shell throws EINVAL, so every
    // in-app update on Windows died before npm ever ran.
    expect(spawnImpl).toHaveBeenCalledWith(
      'npm.cmd',
      ['install', '-g', '@example/pkg@0.5.3'],
      expect.objectContaining({ shell: true }),
    );
    platformSpy.mockRestore();
  });

  test('FALLBACK on POSIX: plain npm, still shell-free', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const spawnImpl = vi.fn(() => makeFakeChild({ exitCode: 0 }));

    await runSelfUpdate('0.5.3', 'en', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack('0.5.3'),
      consoleHoldsNativeModule: () => false,
      npmCliJs: null,
      skipFreePort: true,
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    expect(spawnImpl).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '@example/pkg@0.5.3'],
      expect.any(Object),
    );
    // On POSIX `npm` is a real executable, so the shell buys nothing and
    // we stay out of cmd/sh quoting entirely.
    const opts = spawnImpl.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.shell).toBeUndefined();
    platformSpy.mockRestore();
  });

  test('emits a stopping-primary event before the install when port-freeing is on', async () => {
    const events: SelfUpdateProgress[] = [];
    const spawnImpl = vi.fn(() => makeFakeChild({ exitCode: 0 }));

    // runFreePort is mocked for the whole file (it would stop every live
    // browser-link process on this machine); the stage label still appears.
    // Windows: the only OS where the update stops the server (D18).
    await runSelfUpdate('latest', 'en', (e) => events.push(e), {
      packageName: '@example/pkg',
      readInstalled: readBack('latest'),
      consoleHoldsNativeModule: () => false,
      os: 'win32',
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    expect(events.map((e) => e.stage)).toEqual([
      'preflight',
      'stopping-primary',
      'installing',
      'done',
    ]);
  });

  /* D14: the stop step shows "not running" only when the OS lookup ran and
   * found the port free; a failed lookup is shown as it is. */
  async function stopMessageFor(result: object): Promise<string | undefined> {
    const { runFreePort } = await import('./free-port.js');
    vi.mocked(runFreePort).mockReturnValueOnce(result as ReturnType<typeof runFreePort>);
    const events: SelfUpdateProgress[] = [];
    await runSelfUpdate('latest', 'en', (e) => events.push(e), {
      packageName: '@example/pkg',
      readInstalled: readBack('latest'),
      consoleHoldsNativeModule: () => false,
      os: 'win32',
      spawnImpl: vi.fn(() =>
        makeFakeChild({ exitCode: 0 }),
      ) as unknown as typeof import('node:child_process').spawn,
    });
    return events.find((e) => e.stage === 'stopping-primary')?.message;
  }

  test('a failed port lookup is shown as it is, never as "not running"', async () => {
    const lookupFailed =
      '✗ Could not check through the operating system which process holds port ' +
      '127.0.0.1:17529: the lookup timed out. Nothing was stopped.';
    const message = await stopMessageFor({
      ok: false,
      portState: 'unknown',
      pid: null,
      imageName: null,
      message: lookupFailed,
    });
    expect(message).toBe(lookupFailed);
  });

  /* BL-DIAG-125, changed on purpose (D18): the free port no longer hides
   * the rest of `stop`'s report behind "No primary running". */
  test('a lookup that found the port free shows what stop said, whole', async () => {
    const free = 'Port 127.0.0.1:17529 is already free — nothing to stop.';
    const message = await stopMessageFor({
      ok: true,
      portState: 'free',
      pid: null,
      imageName: null,
      message: free,
    });
    expect(message).toBe(free);
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
      readInstalled: readBack('0.5.3'),
      consoleHoldsNativeModule: () => false,
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
      readInstalled: readBack('0.5.3'),
      consoleHoldsNativeModule: () => false,
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
      readInstalled: readBack('latest'),
      consoleHoldsNativeModule: () => false,
      skipFreePort: true,
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    expect(result.message).toContain('Instalado');
    expect(events.find((e) => e.stage === 'preflight')!.message).toContain('Actualizando');
  });
});

describe('runSelfUpdate — never-throws contract', () => {
  test('a SYNCHRONOUS spawn throw resolves as a failure instead of rejecting', async () => {
    // This is the Windows EINVAL shape: Node >= 18.20.2 refuses to spawn a
    // .cmd without a shell and throws immediately, so the throw never
    // reaches child.on('error'). Before the fix it escaped the promise and
    // rejected out of a function documented as "never throws" — the UI has
    // no try/catch, so the user saw a crash rather than a clean message.
    const spawnImpl = vi.fn(() => {
      const err = new Error('spawn EINVAL') as NodeJS.ErrnoException;
      err.code = 'EINVAL';
      throw err;
    });
    const events: SelfUpdateProgress[] = [];

    const result = await runSelfUpdate('latest', 'en', (e) => events.push(e), {
      packageName: '@example/pkg',
      readInstalled: readBack('latest'),
      consoleHoldsNativeModule: () => false,
      skipFreePort: true,
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('spawn EINVAL');
    expect(events.at(-1)?.stage).toBe('failed');
  });
});

describe('runSelfUpdate — target and package validation', () => {
  test.each([
    ['a shell metacharacter', 'latest & calc.exe'],
    ['a command substitution', '$(whoami)'],
    ['a path traversal', '../evil'],
    ['an arbitrary range', '>=1.0.0'],
    ['empty', ''],
  ])('refuses %s as a target and never spawns anything', async (_label, target) => {
    const spawnImpl = vi.fn(() => makeFakeChild({ exitCode: 0 }));
    const result = await runSelfUpdate(target, 'en', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack(target),
      consoleHoldsNativeModule: () => false,
      skipFreePort: true,
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Refusing to install/);
    // The whole point of validating before the shell: nothing reaches it.
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test.each([
    ['latest', 'latest'],
    ['an exact release', '1.2.3'],
    ['a prerelease', '1.2.3-rc.1'],
  ])('accepts %s as a target', async (_label, target) => {
    const spawnImpl = vi.fn(() => makeFakeChild({ exitCode: 0 }));
    const result = await runSelfUpdate(target, 'en', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack(target),
      consoleHoldsNativeModule: () => false,
      npmBin: 'npm',
      useShell: false,
      skipFreePort: true,
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    expect(result.ok).toBe(true);
    expect(spawnImpl).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', `@example/pkg@${target}`],
      expect.any(Object),
    );
  });

  test('refuses a package name that is not valid npm grammar', async () => {
    const spawnImpl = vi.fn(() => makeFakeChild({ exitCode: 0 }));
    const result = await runSelfUpdate('latest', 'en', undefined, {
      packageName: 'evil pkg && rm -rf /',
      skipFreePort: true,
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not match the npm package-name grammar/);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe('runSelfUpdate — permission failures get an actionable hint', () => {
  test('an EACCES install failure explains both real remedies', async () => {
    const spawnImpl = vi.fn(() =>
      makeFakeChild({
        exitCode: 1,
        stderr:
          "npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules\nnpm error errno -13\nnpm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules'",
      }),
    );
    const result = await runSelfUpdate('latest', 'en', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack('latest'),
      consoleHoldsNativeModule: () => false,
      npmBin: 'npm',
      useShell: false,
      skipFreePort: true,
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    expect(result.ok).toBe(false);
    // npm's own last line says nothing about what to do about it.
    expect(result.message).toMatch(/sudo npm install -g/);
    expect(result.message).toMatch(/npm config set prefix/);
  });

  test('an ordinary failure does NOT get the permission hint', async () => {
    const spawnImpl = vi.fn(() =>
      makeFakeChild({ exitCode: 1, stderr: 'npm error 404 Not Found - GET https://registry…' }),
    );
    const result = await runSelfUpdate('latest', 'en', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack('latest'),
      consoleHoldsNativeModule: () => false,
      npmBin: 'npm',
      useShell: false,
      skipFreePort: true,
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
    });

    expect(result.ok).toBe(false);
    expect(result.message).not.toMatch(/npm config set prefix/);
  });
});

describe('runSelfUpdate — preferred shell-free npm-cli.js path', () => {
  test.each([['win32'], ['darwin'], ['linux']])(
    'on %s it runs node + npm-cli.js with no shell at all',
    async (platform) => {
      const platformSpy = vi
        .spyOn(process, 'platform', 'get')
        .mockReturnValue(platform as NodeJS.Platform);
      const spawnImpl = vi.fn(() => makeFakeChild({ exitCode: 0 }));

      const result = await runSelfUpdate('latest', 'en', undefined, {
        packageName: '@example/pkg',
        readInstalled: readBack('latest'),
        consoleHoldsNativeModule: () => false,
        npmCliJs: '/opt/node/node_modules/npm/bin/npm-cli.js',
        skipFreePort: true,
        spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
      });

      expect(result.ok).toBe(true);
      expect(spawnImpl).toHaveBeenCalledWith(
        process.execPath,
        ['/opt/node/node_modules/npm/bin/npm-cli.js', 'install', '-g', '@example/pkg@latest'],
        expect.any(Object),
      );
      // One identical, shell-free code path on every OS: no .cmd shim to
      // trip Windows' EINVAL, and no concatenated command line (which is
      // what Node's DEP0190 warns about and what would otherwise print a
      // deprecation notice at the user in the middle of an update).
      const opts = spawnImpl.mock.calls[0][2] as Record<string, unknown>;
      expect(opts.shell).toBeUndefined();
      platformSpy.mockRestore();
    },
  );
});

/* D18 (owner decision): say what will happen, stop only what must be
 * stopped, bound and cancel the install, report everything. Every effect is
 * injected: no test stops a process, runs npm or asks the OS for ports. */

type SpawnLike = typeof import('node:child_process').spawn;

/** A child that never exits by itself: only `kill` ends it. */
function makeHangingChild(): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter() as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  emitter.stderr = new EventEmitter() as NodeJS.ReadableStream;
  emitter.stdout = new EventEmitter() as NodeJS.ReadableStream;
  emitter.kill = vi.fn(() => true);
  return emitter;
}

/** Captures the one timer the install arms, so a test fires it by hand. */
function fakeTimers() {
  const armed: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    armed,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const entry = { fn, ms, cleared: false };
        armed.push(entry);
        return entry;
      },
      clearTimeout: (handle: unknown) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
  };
}

/** S1: the last step of every confirmed install (here for 1.2.0). */
const RELOAD_EN =
  'Last step: reload the browser-link extension in chrome://extensions (the reload button on its card) so it runs 1.2.0 too. Once a tab reconnects, the extension popup and browser.list_tabs say whether the extension and the server run the same version; this console cannot see the extension, so it has not checked that.';
const RELOAD_ES =
  'Último paso: recargá la extensión browser-link en chrome://extensions (el botón de recarga de su tarjeta) para que también corra 1.2.0. Cuando una pestaña se reconecte, el popup de la extensión y browser.list_tabs dicen si la extensión y el servidor corren la misma versión; esta consola no ve la extensión, así que eso no lo comprobó.';

const STOP_REPORT_WITH_OTHERS = [
  '✓ Stopped browser-link primary (PID 4242). Port 127.0.0.1:17529 is now free.',
  'Other browser-link processes, not stopped (they hold no browser-link port, so the operating system cannot confirm them through it):',
  '  PID 5151  node browser-link  to stop it: browser-link stop --pid 5151',
].join('\n');

describe('runSelfUpdate — D18: only what must be stopped, per OS', () => {
  test('on Windows it stops the verified server first and reports everything that stop did', async () => {
    const order: string[] = [];
    const stopServers = vi.fn(() => {
      order.push('stop');
      return {
        portState: 'stopped' as const,
        ok: true,
        pid: 4242,
        imageName: 'node.exe',
        message: STOP_REPORT_WITH_OTHERS,
        processes: [{ pid: 4242, command: 'node browser-link', stopped: true }],
      };
    });
    const spawnImpl = vi.fn(() => {
      order.push('install');
      return makeFakeChild({ exitCode: 0 });
    });

    const result = await runSelfUpdate('1.2.0', 'en', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack('1.2.0'),
      consoleHoldsNativeModule: () => false,
      npmBin: 'npm',
      useShell: false,
      os: 'win32',
      stopServers,
      spawnImpl: spawnImpl as unknown as SpawnLike,
    });

    expect(order).toEqual(['stop', 'install']);
    expect(stopServers).toHaveBeenCalledWith('en');
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('installed');
    // The whole report, the proxy that was left running included.
    expect(result.stopReport).toBe(STOP_REPORT_WITH_OTHERS);
    expect(result.nextStep).toMatch(/restart your MCP clients/i);
  });

  test('on Windows a port found free still shows every other process the stop listed', async () => {
    const report =
      'Port 127.0.0.1:17529 is already free — nothing to stop.\n' +
      'Other browser-link processes, not stopped (…):\n  PID 77  node browser-link  to stop it: browser-link stop --pid 77';
    const result = await runSelfUpdate('1.2.0', 'en', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack('1.2.0'),
      consoleHoldsNativeModule: () => false,
      npmBin: 'npm',
      useShell: false,
      os: 'win32',
      stopServers: () => ({
        portState: 'free',
        ok: true,
        pid: null,
        imageName: null,
        message: report,
      }),
      spawnImpl: vi.fn(() => makeFakeChild({ exitCode: 0 })) as unknown as SpawnLike,
    });
    expect(result.stopReport).toBe(report);
  });

  test.each([['linux'], ['darwin']] as const)(
    'on %s nothing is stopped: the stop is never called and the result says so',
    async (os) => {
      const stopServers = vi.fn();
      const events: SelfUpdateProgress[] = [];
      const result = await runSelfUpdate('1.2.0', 'en', (e) => events.push(e), {
        packageName: '@example/pkg',
        readInstalled: readBack('1.2.0'),
        consoleHoldsNativeModule: () => false,
        npmBin: 'npm',
        useShell: false,
        os,
        stopServers,
        spawnImpl: vi.fn(() => makeFakeChild({ exitCode: 0 })) as unknown as SpawnLike,
      });
      expect(stopServers).not.toHaveBeenCalled();
      expect(events.map((e) => e.stage)).toEqual(['preflight', 'installing', 'done']);
      expect(result.stopReport).toBe('Nothing was stopped.');
      expect(result.nextStep).toBe(
        'A server that was already running keeps the old version until it restarts: restart your MCP clients, and the first one to start takes the port over with the new version.\n' +
          RELOAD_EN,
      );
    },
  );

  test('Spanish: nothing stopped and the next step', async () => {
    const result = await runSelfUpdate('1.2.0', 'es', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack('1.2.0'),
      consoleHoldsNativeModule: () => false,
      npmBin: 'npm',
      useShell: false,
      os: 'linux',
      stopServers: vi.fn(),
      spawnImpl: vi.fn(() => makeFakeChild({ exitCode: 0 })) as unknown as SpawnLike,
    });
    expect(result.stopReport).toBe('No se detuvo nada.');
    expect(result.nextStep).toBe(
      'Un servidor que ya estaba corriendo sigue con la versión anterior hasta que se reinicie: reiniciá tus clientes MCP, y el primero que arranque toma el puerto con la versión nueva.\n' +
        RELOAD_ES,
    );
  });
});

describe('runSelfUpdate — D18: the install has a time limit and can be cancelled', () => {
  test('the install is stopped when the time limit passes, and the result says what to do', async () => {
    const child = makeHangingChild();
    const { armed, timers } = fakeTimers();
    const events: SelfUpdateProgress[] = [];
    const pending = runSelfUpdate('1.2.0', 'en', (e) => events.push(e), {
      packageName: '@example/pkg',
      readInstalled: readBack('1.2.0'),
      consoleHoldsNativeModule: () => false,
      npmBin: 'npm',
      useShell: false,
      os: 'linux',
      timers,
      spawnImpl: vi.fn(() => child) as unknown as SpawnLike,
    });
    await new Promise((r) => setImmediate(r));
    expect(armed).toHaveLength(1);
    expect(armed[0].ms).toBe(SELF_UPDATE_TIMEOUT_MS);
    expect(child.kill).not.toHaveBeenCalled();
    armed[0].fn();
    const result = await pending;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('timed-out');
    // Only what was observed: npm was asked to stop, nobody saw it end.
    expect(result.message).toBe(
      '✗ The install did not finish within 10 minutes. npm was asked to stop.',
    );
    expect(result.nextStep).toBe(
      'npm was asked to stop, but this tool cannot confirm that it ended: it may still be running (on Windows only the shell that launched it may have ended). Check for a leftover npm or node process (Task Manager on Windows, `ps` on macOS and Linux). browser-link may be incomplete: once npm is gone, run `npm install -g @example/pkg@1.2.0` in a terminal to finish it.',
    );
    expect(events.at(-1)).toEqual({ stage: 'failed', message: result.message });
  });

  test('the install is stopped when the caller cancels it', async () => {
    const child = makeHangingChild();
    const { armed, timers } = fakeTimers();
    const controller = new AbortController();
    const pending = runSelfUpdate('1.2.0', 'es', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack('1.2.0'),
      consoleHoldsNativeModule: () => false,
      npmBin: 'npm',
      useShell: false,
      os: 'linux',
      timers,
      signal: controller.signal,
      spawnImpl: vi.fn(() => child) as unknown as SpawnLike,
    });
    await new Promise((r) => setImmediate(r));
    controller.abort();
    const result = await pending;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(armed[0].cleared).toBe(true);
    expect(result.outcome).toBe('cancelled');
    expect(result.message).toBe('✗ Cancelaste la instalación. Se le pidió a npm que se detenga.');
    expect(result.nextStep).toBe(
      'Se le pidió a npm que se detenga, pero esta herramienta no puede confirmar que haya terminado: puede seguir corriendo (en Windows puede haber terminado solo el intérprete que lo lanzó). Fijate si queda algún proceso npm o node (Administrador de tareas en Windows, `ps` en macOS y Linux). browser-link puede haber quedado incompleto: cuando npm ya no esté, corré `npm install -g @example/pkg@1.2.0` en una terminal para terminarlo.',
    );
  });

  test('a cancel that arrives before the install starts installs nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawnImpl = vi.fn();
    const result = await runSelfUpdate('1.2.0', 'en', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack('1.2.0'),
      consoleHoldsNativeModule: () => false,
      os: 'linux',
      signal: controller.signal,
      spawnImpl: spawnImpl as unknown as SpawnLike,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result.outcome).toBe('cancelled');
    expect(result.nextStep).toBe('Nothing was installed.');
  });

  test('a finished install clears its timer', async () => {
    const { armed, timers } = fakeTimers();
    await runSelfUpdate('1.2.0', 'en', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack('1.2.0'),
      consoleHoldsNativeModule: () => false,
      os: 'linux',
      timers,
      spawnImpl: vi.fn(() => makeFakeChild({ exitCode: 0 })) as unknown as SpawnLike,
    });
    expect(armed[0].cleared).toBe(true);
  });
});

describe('runSelfUpdate — D18: the real error when the install fails', () => {
  test("npm's error lines are shown, not the log-path line npm prints last", async () => {
    const stderr = [
      'npm error code E404',
      'npm error 404 Not Found - GET https://registry.npmjs.org/@example%2fpkg - Not found',
      'npm error 404',
      'npm error A complete log of this run can be found in: C:\\Users\\x\\AppData\\Local\\npm-cache\\_logs\\debug-0.log',
    ].join('\n');
    const result = await runSelfUpdate('1.2.0', 'en', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack('1.2.0'),
      consoleHoldsNativeModule: () => false,
      os: 'linux',
      spawnImpl: vi.fn(() => makeFakeChild({ exitCode: 1, stderr })) as unknown as SpawnLike,
    });
    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('npm error code E404');
    expect(result.message).toContain('404 Not Found');
    expect(result.message).not.toContain('complete log');
    expect(result.stderr).toBe(stderr);
    expect(result.nextStep).toBe(
      "Nothing was installed. Run `npm install -g @example/pkg@1.2.0` in a terminal to see npm's full output.",
    );
  });

  test('an install that fails with no error output says its exit code', async () => {
    const result = await runSelfUpdate('1.2.0', 'en', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack('1.2.0'),
      consoleHoldsNativeModule: () => false,
      os: 'linux',
      spawnImpl: vi.fn(() => makeFakeChild({ exitCode: 1 })) as unknown as SpawnLike,
    });
    expect(result.message).toBe('✗ Update failed: npm exited with code 1 and printed no error.');
  });

  test('on Windows a locked file gets the lock remedy, not the permission one', async () => {
    const stderr =
      "npm error code EBUSY\nnpm error syscall rename\nnpm error EBUSY: resource busy or locked, rename 'C:\\npm\\node_modules\\@example\\pkg'";
    const result = await runSelfUpdate('1.2.0', 'en', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack('1.2.0'),
      consoleHoldsNativeModule: () => false,
      os: 'win32',
      stopServers: () => ({
        portState: 'free',
        ok: true,
        pid: null,
        imageName: null,
        message: 'free',
      }),
      spawnImpl: vi.fn(() => makeFakeChild({ exitCode: 1, stderr })) as unknown as SpawnLike,
    });
    expect(result.message).toContain('EBUSY: resource busy or locked');
    expect(result.message).not.toMatch(/sudo/);
    expect(result.nextStep).toBe(
      "A running process still holds browser-link's files (Windows locks a loaded native module). Close every browser-link console and MCP client, then run `npm install -g @example/pkg@1.2.0` in a new terminal.",
    );
  });
});

describe('readUpdatePlan — what the preview can truthfully say', () => {
  const BRIDGE = 'node /usr/local/lib/node_modules/@jobshimo/browser-link/dist/cli.js';
  const self = { pid: 10, ppid: 1, startedAt: null, command: BRIDGE };

  test('a running server answers /version; the other browser-link processes are counted', async () => {
    const plan = await readUpdatePlan({
      os: 'win32',
      selfPid: 10,
      probe: async () => ({
        kind: 'version',
        info: {
          name: 'browser-link',
          version: '1.0.2',
          pid: 20,
          startedAt: 'x',
          installedVersion: '1.0.2',
        },
      }),
      processTable: async () => [
        self,
        { pid: 20, ppid: 2, startedAt: null, command: BRIDGE },
        { pid: 30, ppid: 3, startedAt: null, command: BRIDGE },
        { pid: 31, ppid: 3, startedAt: null, command: `${BRIDGE} stop` },
      ],
    });
    expect(plan).toEqual({
      stopsServer: true,
      server: { kind: 'running', version: '1.0.2', pid: 20 },
      otherProcesses: 1,
    });
  });

  test('the number of agent sessions is the one /version sent, only when it sent one (D18)', async () => {
    const info = {
      name: 'browser-link',
      version: '1.0.2',
      pid: 20,
      startedAt: 'x',
      installedVersion: '1.0.2',
    };
    const table = async () => [self, { pid: 20, ppid: 2, startedAt: null, command: BRIDGE }];
    const withSessions = await readUpdatePlan({
      os: 'win32',
      selfPid: 10,
      probe: async () => ({ kind: 'version', info: { ...info, sessions: 3 } }),
      processTable: table,
    });
    expect(withSessions.server).toEqual({
      kind: 'running',
      version: '1.0.2',
      pid: 20,
      sessions: 3,
    });
    const zero = await readUpdatePlan({
      os: 'win32',
      selfPid: 10,
      probe: async () => ({ kind: 'version', info: { ...info, sessions: 0 } }),
      processTable: table,
    });
    expect(zero.server).toMatchObject({ sessions: 0 });
    const older = await readUpdatePlan({
      os: 'win32',
      selfPid: 10,
      probe: async () => ({ kind: 'version', info }),
      processTable: table,
    });
    expect('sessions' in older.server).toBe(false);
  });

  test('nothing answers and no browser-link process is listed: no server', async () => {
    const plan = await readUpdatePlan({
      os: 'linux',
      selfPid: 10,
      probe: async () => ({ kind: 'unreachable' }),
      processTable: async () => [self],
    });
    expect(plan).toEqual({ stopsServer: false, server: { kind: 'none' }, otherProcesses: 0 });
  });

  test('nothing answers but browser-link processes are listed: the server cannot be read', async () => {
    const plan = await readUpdatePlan({
      os: 'darwin',
      selfPid: 10,
      probe: async () => ({ kind: 'unreachable' }),
      processTable: async () => [self, { pid: 20, ppid: 2, startedAt: null, command: BRIDGE }],
    });
    expect(plan.server).toEqual({ kind: 'unreadable' });
    expect(plan.otherProcesses).toBe(1);
  });

  test('an unreadable process table gives no count, never zero', async () => {
    const plan = await readUpdatePlan({
      os: 'win32',
      selfPid: 10,
      probe: async () => ({ kind: 'no-endpoint' }),
      processTable: async () => [],
    });
    expect(plan).toEqual({
      stopsServer: true,
      server: { kind: 'unreadable' },
      otherProcesses: null,
    });
  });
});

describe('resolveNpmCliJs', () => {
  test('finds npm-cli.js next to the running node binary', () => {
    const seen: string[] = [];
    const found = resolveNpmCliJs('/opt/node/bin/node', (p) => {
      seen.push(p);
      return true;
    });
    expect(found).toBe(join('/opt/node/bin', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    expect(seen).toHaveLength(1);
  });

  test('returns null when it is not there, so the caller falls back', () => {
    // Volta and other shim-based managers do not lay npm out this way.
    expect(resolveNpmCliJs('/opt/node/bin/node', () => false)).toBeNull();
  });
});

/* S1 and S5 (owner-priority 1.1.1): the update result ends with reloading the
 * extension; the databases are closed before npm; npm runs in a neutral
 * directory; "installed" only after the version on disk was read back. */
describe('runSelfUpdate — S1: the result ends with reloading the extension', () => {
  test('the next step of a confirmed install ends with the reload in chrome://extensions', async () => {
    const result = await runSelfUpdate('1.2.0', 'en', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack('1.2.0'),
      consoleHoldsNativeModule: () => false,
      npmBin: 'npm',
      useShell: false,
      os: 'win32',
      stopServers: () => ({
        portState: 'free',
        ok: true,
        pid: null,
        imageName: null,
        message: 'free',
      }),
      spawnImpl: vi.fn(() => makeFakeChild({ exitCode: 0 })) as unknown as SpawnLike,
    });
    expect(result.outcome).toBe('installed');
    expect(result.nextStep.split('\n').at(-1)).toBe(RELOAD_EN);
  });

  test('a failed install does not tell the user to reload anything', async () => {
    const result = await runSelfUpdate('1.2.0', 'en', undefined, {
      packageName: '@example/pkg',
      readInstalled: readBack('1.2.0'),
      consoleHoldsNativeModule: () => false,
      npmBin: 'npm',
      useShell: false,
      os: 'linux',
      spawnImpl: vi.fn(() =>
        makeFakeChild({ exitCode: 1, stderr: 'npm error code E404' }),
      ) as unknown as SpawnLike,
    });
    expect(result.nextStep).not.toContain('chrome://extensions');
  });
});

describe('runSelfUpdate — S5: close the DB, neutral cwd, read the version back', () => {
  const base = {
    packageName: '@example/pkg',
    npmBin: 'npm',
    useShell: false,
    os: 'linux' as const,
  };

  test('the databases are closed before npm is spawned', async () => {
    const order: string[] = [];
    await runSelfUpdate('1.2.0', 'en', undefined, {
      ...base,
      readInstalled: readBack('1.2.0'),
      consoleHoldsNativeModule: () => false,
      closeDatabases: () => order.push('close'),
      spawnImpl: vi.fn(() => {
        order.push('spawn');
        return makeFakeChild({ exitCode: 0 });
      }) as unknown as SpawnLike,
    });
    expect(order).toEqual(['close', 'spawn']);
  });

  test('a refused target closes nothing and spawns nothing', async () => {
    const closeDatabases = vi.fn();
    const spawnImpl = vi.fn();
    await runSelfUpdate('nope', 'en', undefined, {
      ...base,
      closeDatabases,
      spawnImpl: spawnImpl as unknown as SpawnLike,
    });
    expect(closeDatabases).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test("npm runs in the home directory by default, never the console's own directory", async () => {
    const spawnImpl = vi.fn(() => makeFakeChild({ exitCode: 0 }));
    await runSelfUpdate('1.2.0', 'en', undefined, {
      ...base,
      readInstalled: readBack('1.2.0'),
      consoleHoldsNativeModule: () => false,
      spawnImpl: spawnImpl as unknown as SpawnLike,
    });
    const opts = spawnImpl.mock.calls[0]![2] as { cwd?: string };
    expect(opts.cwd).toBe(neutralCwd());
    expect(neutralCwd()).toBe(homedir());
    expect(opts.cwd).not.toBe(process.cwd());
  });

  test('installed only when the version read back is the requested one, and it is reported', async () => {
    const result = await runSelfUpdate('1.2.0', 'en', undefined, {
      ...base,
      readInstalled: readBack('1.2.0'),
      consoleHoldsNativeModule: () => false,
      spawnImpl: vi.fn(() => makeFakeChild({ exitCode: 0 })) as unknown as SpawnLike,
    });
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('installed');
    expect(result.installedVersion).toBe('1.2.0');
    expect(result.message).toBe(
      '✓ Installed browser-link@1.2.0 (read back from the installed package). Restart your MCP client (Claude Code, OpenCode, Copilot CLI, …) to load the new version.',
    );
  });

  test('npm exit 0 with another version on disk is a failure, not "installed"', async () => {
    const result = await runSelfUpdate('1.2.0', 'en', undefined, {
      ...base,
      readInstalled: () => Promise.resolve({ kind: 'read', version: '1.1.0' }),
      spawnImpl: vi.fn(() => makeFakeChild({ exitCode: 0 })) as unknown as SpawnLike,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('failed');
    expect(result.installedVersion).toBe('1.1.0');
    expect(result.message).toBe(
      '✗ npm finished without an error, but the installed browser-link is 1.1.0, not 1.2.0.',
    );
    expect(result.nextStep).toBe(
      'Run `npm install -g @example/pkg@1.2.0` in a terminal, then `npm ls -g @example/pkg` to see which version is installed.',
    );
  });

  test('npm exit 0 with an unreadable version is unverified, never "installed"', async () => {
    const events: SelfUpdateProgress[] = [];
    const result = await runSelfUpdate('1.2.0', 'es', (e) => events.push(e), {
      ...base,
      readInstalled: () => Promise.resolve({ kind: 'unreadable', reason: 'sin package.json' }),
      spawnImpl: vi.fn(() => makeFakeChild({ exitCode: 0 })) as unknown as SpawnLike,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('unverified');
    expect(result).not.toHaveProperty('installedVersion');
    expect(result.message).toBe(
      '✗ npm terminó sin error, pero no se pudo leer la versión instalada (sin package.json), así que la actualización no está confirmada.',
    );
    expect(events.at(-1)!.stage).toBe('failed');
  });

  test('for `latest` the version read back is reported as installed', async () => {
    const result = await runSelfUpdate('latest', 'en', undefined, {
      ...base,
      readInstalled: readBack('latest'),
      consoleHoldsNativeModule: () => false,
      spawnImpl: vi.fn(() => makeFakeChild({ exitCode: 0 })) as unknown as SpawnLike,
    });
    expect(result.outcome).toBe('installed');
    expect(result.installedVersion).toBe('9.9.9');
    expect(result.message).toContain('browser-link@9.9.9');
  });

  test('on Windows, when this console has loaded the native module, it refuses before stopping or spawning anything', async () => {
    const spawnImpl = vi.fn();
    const stopServers = vi.fn();
    const closeDatabases = vi.fn();
    const result = await runSelfUpdate('1.2.0', 'en', undefined, {
      ...base,
      os: 'win32',
      stopServers,
      closeDatabases,
      consoleHoldsNativeModule: () => true,
      spawnImpl: spawnImpl as unknown as SpawnLike,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(stopServers).not.toHaveBeenCalled();
    expect(closeDatabases).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('refused');
    expect(result.message).toBe(
      '✗ Not updating from this console: it has loaded the map database module (Doctor or a map screen opened the map), and Windows keeps that file locked until this console exits, so npm could not replace it. Nothing was stopped or installed.',
    );
    expect(result.nextStep).toBe(
      'Close this console. browser-link has no update command of its own, so in a new terminal run `browser-link stop` (it does not open the map), close your MCP clients, then run `npm install -g @example/pkg@1.2.0`.',
    );
  });

  test('Spanish refusal', async () => {
    const result = await runSelfUpdate('1.2.0', 'es', undefined, {
      ...base,
      os: 'win32',
      consoleHoldsNativeModule: () => true,
      spawnImpl: vi.fn() as unknown as SpawnLike,
    });
    expect(result.outcome).toBe('refused');
    expect(result.message).toMatch(/^✗ No actualizo desde esta consola/);
    expect(result.nextStep).toContain('`npm install -g @example/pkg@1.2.0`');
  });

  test('on Windows without the module loaded here, the install proceeds', async () => {
    const spawnImpl = vi.fn(() => makeFakeChild({ exitCode: 0 }));
    const result = await runSelfUpdate('1.2.0', 'en', undefined, {
      ...base,
      os: 'win32',
      skipFreePort: true,
      consoleHoldsNativeModule: () => false,
      readInstalled: readBack('1.2.0'),
      spawnImpl: spawnImpl as unknown as SpawnLike,
    });
    expect(spawnImpl).toHaveBeenCalledOnce();
    expect(result.outcome).toBe('installed');
  });

  test('off Windows the module being loaded does not stop the install', async () => {
    const spawnImpl = vi.fn(() => makeFakeChild({ exitCode: 0 }));
    const result = await runSelfUpdate('1.2.0', 'en', undefined, {
      ...base,
      consoleHoldsNativeModule: () => true,
      readInstalled: readBack('1.2.0'),
      spawnImpl: spawnImpl as unknown as SpawnLike,
    });
    expect(spawnImpl).toHaveBeenCalledOnce();
    expect(result.outcome).toBe('installed');
  });

  test('a Windows lock without the module loaded here keeps the general lock advice', async () => {
    const result = await runSelfUpdate('1.2.0', 'en', undefined, {
      ...base,
      os: 'win32',
      skipFreePort: true,
      consoleHoldsNativeModule: () => false,
      spawnImpl: vi.fn(() =>
        makeFakeChild({ exitCode: 1, stderr: 'npm error code EBUSY' }),
      ) as unknown as SpawnLike,
    });
    expect(result.nextStep).toMatch(/^A running process still holds browser-link's files/);
  });
});

describe('readInstalledPackageVersion', () => {
  function rootChild(stdout: string, exitCode = 0): ChildProcess {
    const emitter = new EventEmitter() as ChildProcess;
    const out = new EventEmitter() as NodeJS.ReadableStream;
    emitter.stdout = out;
    emitter.stderr = new EventEmitter() as NodeJS.ReadableStream;
    setImmediate(() => {
      out.emit('data', Buffer.from(stdout));
      emitter.emit('close', exitCode);
    });
    return emitter;
  }

  test('runs `npm root -g` with the same npm and directory, then reads that package.json', async () => {
    const spawnImpl = vi.fn(() => rootChild('/usr/lib/node_modules\n'));
    const readVersion = vi.fn(() => '1.2.0');
    const read = await readInstalledPackageVersion({
      spawnImpl: spawnImpl as unknown as SpawnLike,
      command: '/usr/bin/node',
      argvPrefix: ['/usr/lib/node_modules/npm/bin/npm-cli.js'],
      useShell: false,
      cwd: '/home/u',
      packageName: '@scope/pkg',
      readVersion,
    });
    expect(read).toEqual({ kind: 'read', version: '1.2.0' });
    expect(spawnImpl).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['/usr/lib/node_modules/npm/bin/npm-cli.js', 'root', '-g'],
      { stdio: ['ignore', 'pipe', 'pipe'], cwd: '/home/u' },
    );
    expect(readVersion).toHaveBeenCalledWith(
      join('/usr/lib/node_modules', '@scope', 'pkg', 'package.json'),
    );
  });

  test('unreadable when npm root fails or the package.json has no version', async () => {
    const failed = await readInstalledPackageVersion({
      spawnImpl: vi.fn(() => rootChild('', 1)) as unknown as SpawnLike,
      command: 'npm',
      argvPrefix: [],
      useShell: false,
      cwd: '/home/u',
      packageName: 'pkg',
      readVersion: () => '1.0.0',
    });
    expect(failed).toEqual({ kind: 'unreadable', reason: '`npm root -g` exited with code 1' });
    const missing = await readInstalledPackageVersion({
      spawnImpl: vi.fn(() => rootChild('/g\n')) as unknown as SpawnLike,
      command: 'npm',
      argvPrefix: [],
      useShell: false,
      cwd: '/home/u',
      packageName: 'pkg',
      readVersion: () => null,
    });
    expect(missing).toEqual({
      kind: 'unreadable',
      reason: `no version in ${join('/g', 'pkg', 'package.json')}`,
    });
  });

  test('the default install path reads back through the same npm (no injected read-back)', async () => {
    const calls: string[][] = [];
    const spawnImpl = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      return args.includes('root') ? rootChild('/nonexistent-global-root\n') : makeFakeChild();
    });
    const result = await runSelfUpdate('1.2.0', 'en', undefined, {
      packageName: '@example/pkg',
      npmBin: 'npm',
      useShell: false,
      os: 'linux',
      spawnImpl: spawnImpl as unknown as SpawnLike,
    });
    expect(calls).toEqual([
      ['install', '-g', '@example/pkg@1.2.0'],
      ['root', '-g'],
    ]);
    // Nothing on disk there: never "installed".
    expect(result.outcome).toBe('unverified');
  });
});

describe('loadsNativeSqlite', () => {
  test('true only when a better-sqlite3 .node file is among the loaded shared objects', () => {
    expect(
      loadsNativeSqlite(() => ({
        sharedObjects: ['C:\\x\\node_modules\\better-sqlite3\\prebuilds\\win32-x64.node'],
      })),
    ).toBe(true);
    expect(loadsNativeSqlite(() => ({ sharedObjects: ['C:\\Windows\\kernel32.dll'] }))).toBe(false);
    expect(
      loadsNativeSqlite(() => {
        throw new Error('no report');
      }),
    ).toBe(false);
  });
});
