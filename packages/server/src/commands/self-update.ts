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

import { spawn } from 'node:child_process';
import { runFreePort } from './free-port.js';
import { PACKAGE_NAME } from '../version.js';
import type { Language } from './welcome.js';

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
  /** Force `npm` command path. Defaults to the `npm` on PATH. */
  npmBin?: string;
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
  },
};

/** Returns the human-readable hint to restart the MCP client after a
 * successful update. Exported so the CLI wrapper can reuse it without
 * duplicating the i18n table. */
export function restartHint(language: Language = 'en'): string {
  return I18N[language].restartHint;
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
  const npmBin = opts.npmBin ?? 'npm';
  const doSpawn = opts.spawnImpl ?? spawn;

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
    const child = doSpawn(npmBin, ['install', '-g', ref], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // Drain stdout to avoid blocking npm on large logs.
    child.stdout?.on('data', () => {});
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
    const message = t.failed(lastLine);
    emit('failed', message);
    return { ok: false, target, message, stderr: installResult.stderr };
  }

  const okMessage = t.installed(target);
  emit('done', okMessage);
  return { ok: true, target, message: okMessage };
}
