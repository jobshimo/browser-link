/**
 * One-shot self-update for the browser-link CLI / MCP server.
 *
 * Strategy:
 *   1. Optionally free port 17529 — if a primary is running, npm install
 *      can race with the live binary on Windows (file lock) and produces
 *      confusing errors on Unix when the process is rebound to a stale
 *      dist/. Stopping the primary first keeps the install clean and
 *      forces the next MCP-client spawn to pick up the new code.
 *   2. Run `npm install -g <package>@<target>` as a child process, with
 *      stdio piped so we can capture output and report it to the caller
 *      (UI streams a short summary; CLI prints raw stderr on failure).
 *   3. Return a structured result. The caller decides what to do next:
 *      the interactive UI shows a "restart your MCP client" hint, the
 *      command-line wrapper prints stdout and exits.
 *
 * Why not auto-restart the MCP client? We don't own that process — it is
 * the parent (Claude Code, OpenCode, Copilot CLI, …). Telling the user
 * to relaunch it is the only honest thing we can do.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runFreePort } from './free-port.js';
import { assertSafeNpmName } from './updates.js';
import { PACKAGE_NAME } from '../version.js';
import type { Language } from './welcome.js';

/**
 * What we are willing to install: the `latest` dist-tag, or one exact
 * semver. Validated BEFORE the value is ever interpolated into an
 * argument list, because on Windows the install runs through cmd.exe
 * (see `runSelfUpdate`) and an unvalidated target would be a command
 * injection surface. An allow-list is the right shape here — the set of
 * legitimate values is tiny and closed.
 */
const UPDATE_TARGET_RE = /^(?:latest|\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/;

export function isSafeUpdateTarget(target: string): boolean {
  return UPDATE_TARGET_RE.test(target);
}

/** npm reports a global-install permission problem in several shapes
 * depending on OS and npm version. Any of them means the same thing to
 * the user, and the fix is the same. */
const PERMISSION_RE = /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/i;

/**
 * Locate npm's own CLI entrypoint so the install can run as
 * `node npm-cli.js install -g …` instead of going through a shim.
 *
 * This is the preferred path on EVERY platform because it removes the
 * whole problem class rather than working around it: no `.cmd` shim, so
 * no Windows EINVAL; no shell, so no argument concatenation and no
 * DEP0190 deprecation warning printed at the user mid-update; and one
 * identical code path on macOS, Linux and Windows.
 *
 * npm ships inside the Node distribution, so it sits next to the running
 * `node` binary in every standard install (official installer, nvm,
 * nvm4w, fnm). When it is not there — an unusual layout, or a shim-based
 * manager like Volta — we return null and the caller falls back to the
 * platform shim.
 */
export function resolveNpmCliJs(
  execPath: string,
  fileExists: (p: string) => boolean = existsSync,
): string | null {
  const candidate = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return fileExists(candidate) ? candidate : null;
}

export interface SelfUpdateProgress {
  /** What stage are we in. Drives the UI's status label. */
  stage: 'preflight' | 'stopping-primary' | 'installing' | 'done' | 'failed';
  /** Human-readable message safe to surface to the user as-is. */
  message: string;
}

export type SelfUpdateProgressCallback = (event: SelfUpdateProgress) => void;

export interface SelfUpdateResult {
  ok: boolean;
  /** The version requested (e.g. `"latest"`, `"0.5.3"`). */
  target: string;
  /** Final message — the one to show in the UI when the spinner stops. */
  message: string;
  /** Combined npm stderr in case the caller wants to dump it for diagnosis. */
  stderr?: string;
}

interface SelfUpdateOptions {
  /** Override the package name (mainly for tests). */
  packageName?: string;
  /** Force `npm` command path. Defaults to the `npm` on PATH. Supplying
   * it also forces the shim fallback (the npm-cli.js path is skipped). */
  npmBin?: string;
  /** Override npm-cli.js resolution. `null` forces the shim fallback —
   * that is how tests exercise it on a machine where npm-cli.js DOES
   * resolve. Undefined auto-resolves next to the running Node binary. */
  npmCliJs?: string | null;
  /** Override the shell decision (mainly for tests). Defaults to true on
   * Windows only — see the spawn call for why it is mandatory there. */
  useShell?: boolean;
  /** Skip the `runFreePort` step. Tests / dry-run use this. */
  skipFreePort?: boolean;
  /** Override the actual spawn for tests. */
  spawnImpl?: typeof spawn;
}

interface SelfUpdateI18n {
  starting: (target: string) => string;
  stopping: string;
  notRunning: string;
  stopFailed: (reason: string) => string;
  installing: (target: string) => string;
  installed: (target: string) => string;
  failed: (reason: string) => string;
  restartHint: string;
  refusedTarget: (target: string) => string;
  refusedPackage: (name: string) => string;
  permissionHint: string;
}

const I18N: Record<Language, SelfUpdateI18n> = {
  en: {
    starting: (t) => `Updating browser-link → ${t}`,
    stopping: 'Stopping the running browser-link primary…',
    notRunning: 'No primary running — port is already free.',
    stopFailed: (reason) =>
      `Could not stop the running browser-link primary: ${reason}. Continuing with the install anyway.`,
    installing: (t) => `Running: npm install -g ${PACKAGE_NAME}@${t}`,
    installed: (t) =>
      `✓ Installed browser-link@${t}. Restart your MCP client (Claude Code, OpenCode, Copilot CLI, …) to load the new version.`,
    failed: (reason) => `✗ Update failed: ${reason}`,
    restartHint: 'Restart your MCP client to pick up the new version.',
    refusedTarget: (t) =>
      `✗ Refusing to install "${t}": a target must be "latest" or an exact version like 1.2.3.`,
    refusedPackage: (name) =>
      `✗ Refusing to install "${name}": it does not match the npm package-name grammar.`,
    permissionHint:
      'npm could not write to your global install directory. Either re-run with elevated permissions (`sudo npm install -g ' +
      PACKAGE_NAME +
      '@latest`), or point npm at a user-owned prefix (`npm config set prefix ~/.npm-global`) and reopen your shell.',
  },
  es: {
    starting: (t) => `Actualizando browser-link → ${t}`,
    stopping: 'Deteniendo el primary de browser-link en uso…',
    notRunning: 'No hay primary corriendo — el puerto ya está libre.',
    stopFailed: (reason) =>
      `No se pudo detener el primary en uso: ${reason}. Igual sigo con la instalación.`,
    installing: (t) => `Ejecutando: npm install -g ${PACKAGE_NAME}@${t}`,
    installed: (t) =>
      `✓ Instalado browser-link@${t}. Reiniciá tu cliente MCP (Claude Code, OpenCode, Copilot CLI, …) para cargar la nueva versión.`,
    failed: (reason) => `✗ La actualización falló: ${reason}`,
    restartHint: 'Reiniciá tu cliente MCP para que tome la nueva versión.',
    refusedTarget: (t) =>
      `✗ No instalo "${t}": el destino tiene que ser "latest" o una versión exacta como 1.2.3.`,
    refusedPackage: (name) =>
      `✗ No instalo "${name}": no cumple la gramática de nombres de paquete de npm.`,
    permissionHint:
      'npm no pudo escribir en tu directorio de instalación global. O lo corrés con permisos elevados (`sudo npm install -g ' +
      PACKAGE_NAME +
      '@latest`), o apuntás npm a un prefix propio (`npm config set prefix ~/.npm-global`) y reabrís la terminal.',
  },
};

/** Returns the human-readable hint to restart the MCP client after a
 * successful update. Exported so the CLI wrapper can reuse it without
 * duplicating the i18n table. */
export function restartHint(language: Language = 'en'): string {
  return I18N[language].restartHint;
}

/** A refusal happens before any stage has started, so it reports as a
 * `failed` preflight rather than pretending an install was attempted. */
function emitRefusal(onProgress: SelfUpdateProgressCallback | undefined, message: string): void {
  if (onProgress) onProgress({ stage: 'failed', message });
}

/**
 * Run the full self-update pipeline. Reports progress via `onProgress`
 * (optional). Always resolves with a `SelfUpdateResult` — never throws so
 * the UI doesn't have to wrap calls in try/catch.
 */
export async function runSelfUpdate(
  target: string,
  language: Language = 'en',
  onProgress?: SelfUpdateProgressCallback,
  opts: SelfUpdateOptions = {},
): Promise<SelfUpdateResult> {
  const t = I18N[language];
  const pkgName = opts.packageName ?? PACKAGE_NAME;

  // Validate BOTH halves of the package ref before anything is spawned.
  // This is not defensive decoration: on Windows the install has to run
  // through cmd.exe (see the spawn call), so an unvalidated target or
  // package name would be a command-injection surface. Refusing is the
  // safe failure mode, and the legitimate value set is tiny and closed.
  if (!isSafeUpdateTarget(target)) {
    const message = t.refusedTarget(target);
    emitRefusal(onProgress, message);
    return { ok: false, target, message };
  }
  try {
    assertSafeNpmName(pkgName);
  } catch {
    const message = t.refusedPackage(pkgName);
    emitRefusal(onProgress, message);
    return { ok: false, target, message };
  }
  // Windows needs BOTH halves of this, and getting only the first was the
  // long-standing bug: `npm` on Windows is `npm.cmd`, so a bare
  // `spawn('npm', …)` throws ENOENT — and since Node 18.20.2 / 20.12.2 /
  // 21.7.3 (the CVE-2024-27980 mitigation) spawning a `.cmd` WITHOUT a
  // shell throws EINVAL. Naming the shim was necessary but not
  // sufficient. We opt into the shell on Windows only, and only after
  // allow-list validating the package ref above, so the quoting surface
  // it adds never sees an unvalidated value.
  const isWindows = process.platform === 'win32';
  const doSpawn = opts.spawnImpl ?? spawn;

  // Preferred: drive npm's own CLI with the Node we are already running.
  // Shell-free on every platform, so Windows never touches a `.cmd` shim
  // and nothing is ever concatenated into a command line.
  const npmCliJs =
    opts.npmCliJs !== undefined
      ? opts.npmCliJs
      : opts.npmBin === undefined
        ? resolveNpmCliJs(process.execPath)
        : null;
  const installArgs = ['install', '-g'];
  let command: string;
  let argv: string[];
  let useShell: boolean;
  if (npmCliJs !== null) {
    command = process.execPath;
    argv = [npmCliJs, ...installArgs];
    useShell = opts.useShell ?? false;
  } else {
    command = opts.npmBin ?? (isWindows ? 'npm.cmd' : 'npm');
    argv = installArgs;
    useShell = opts.useShell ?? isWindows;
  }

  const emit = (stage: SelfUpdateProgress['stage'], message: string): void => {
    if (onProgress) onProgress({ stage, message });
  };

  emit('preflight', t.starting(target));

  // Stop the running primary (if any). Failure here is non-fatal — we still
  // try to install; only the install failure is treated as terminal.
  if (!opts.skipFreePort) {
    let stopMessage: string;
    try {
      const freed = runFreePort(language);
      stopMessage = freed.pid == null ? t.notRunning : freed.message;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      stopMessage = t.stopFailed(reason);
    }
    emit('stopping-primary', stopMessage);
  }

  emit('installing', t.installing(target));

  const ref = `${pkgName}@${target}`;
  const installResult = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let child: ChildProcess;
    try {
      child = doSpawn(command, [...argv, ref], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Only reached on the FALLBACK path, where we had to go through
        // the platform shim. It is mandatory there on Windows and is the
        // reason every in-app update used to fail: Node >= 18.20.2 /
        // 20.12.2 / 21.7.3 refuse to spawn a `.cmd` or `.bat` without a
        // shell (the CVE-2024-27980 mitigation), and on Windows `npm` IS
        // `npm.cmd`, so the shell-less spawn throws EINVAL. Both halves
        // of `ref` were allow-list validated above, so nothing
        // unvalidated ever reaches cmd.exe's parser.
        ...(useShell ? { shell: true } : {}),
      });
    } catch (err) {
      // `spawn` can throw SYNCHRONOUSLY — EINVAL above, and EACCES /
      // ENOENT on some platforms. That throw never reaches the 'error'
      // listener below, so without this catch it escaped the promise and
      // rejected out of a function whose contract is "never throws".
      resolve({ code: 1, stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stderr = '';
    // Non-null in practice (stdio is ['ignore','pipe','pipe']), but the
    // declared ChildProcess type allows null, and an optional chain costs
    // nothing here.
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // Drain stdout to avoid blocking npm on large logs.
    child.stdout?.on('data', () => {
      /* drain */
    });
    child.on('error', (err) => {
      resolve({ code: 1, stderr: err.message });
    });
    child.on('close', (code) => {
      resolve({ code, stderr });
    });
  });

  if (installResult.code !== 0) {
    const lastLine =
      installResult.stderr.trim().split('\n').pop() ?? `exit code ${installResult.code}`;
    // A global-install permission failure is the single most common way
    // this fails on macOS and Linux, and npm's own last line ("EACCES:
    // permission denied") tells the user nothing about what to do. Append
    // the two real remedies instead of making them search.
    const hint = PERMISSION_RE.test(installResult.stderr) ? `\n${t.permissionHint}` : '';
    const message = t.failed(lastLine) + hint;
    emit('failed', message);
    return { ok: false, target, message, stderr: installResult.stderr };
  }

  const okMessage = t.installed(target);
  emit('done', okMessage);
  return { ok: true, target, message: okMessage };
}
