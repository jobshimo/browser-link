import { afterEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { resolveNpmCliJs, runSelfUpdate, type SelfUpdateProgress } from './self-update.js';

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
    });
  });

  test('FALLBACK on Windows: npm.cmd WITH a shell when npm-cli.js is unresolvable', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const spawnImpl = vi.fn(() => makeFakeChild({ exitCode: 0 }));

    await runSelfUpdate('0.5.3', 'en', undefined, {
      packageName: '@example/pkg',
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
