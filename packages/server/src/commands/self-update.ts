/**
 * One-shot self-update for the browser-link CLI / MCP server.
 *
 * Strategy (owner decision D18):
 *   1. Stop only what must be stopped, and only on Windows (see
 *      `stopsServerOn`). The caller shows `readUpdatePlan` and asks first.
 *   2. Run `npm install -g <package>@<target>` as a child process, with
 *      stdio piped so we can capture output and report it to the caller,
 *      bounded by `SELF_UPDATE_TIMEOUT_MS` and cancellable through a signal.
 *      Before it runs, the databases this console opened are closed, and
 *      npm runs in a neutral directory (`neutralCwd`), not the console's.
 *   3. After npm exits 0, read the installed version back from disk
 *      (`readInstalledPackageVersion`): only that confirms the install.
 *   4. Return a structured result: what the stop did, whether it installed
 *      (and which version is on disk), npm's real error, and what to do
 *      next, ending with reloading the extension.
 *
 * Why not auto-restart the MCP client? We don't own that process — it is
 * the parent (Claude Code, OpenCode, Copilot CLI, …). Telling the user
 * to relaunch it is the only honest thing we can do.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { runFreePort, type FreePortResult } from './free-port.js';
import { assertSafeNpmName } from './updates.js';
import { BRIDGE_PORT } from '../bridge/protocol.js';
import { probeVersion, type VersionProbe } from '../lifecycle/election.js';
import {
  findBridgeProcesses,
  listProcessesAsync,
  type ProcessEntry,
} from '../lifecycle/processes.js';
import { closeActivityDb } from '../activity/db.js';
import { closeDb } from '../map/db.js';
import { PACKAGE_NAME, readInstalledVersion } from '../version.js';
import type { Language } from './welcome.js';

/**
 * Whether the update must stop the running server first, by OS.
 *
 * Windows: yes. A server that has opened its map or activity database has
 * loaded better-sqlite3's native module, and Windows keeps a loaded module's
 * file locked until the process exits, so npm cannot move or replace the
 * package folder (EBUSY/EPERM). The JavaScript files are not held open, so
 * proxies (which only pipe frames and never open a database) need not stop.
 *
 * macOS and Linux: no. npm replaces files a running process has open or
 * mapped without error; the running server keeps the code it started with,
 * and the next server to start takes the port over from an older one
 * (`lifecycle/election.ts`), as after a manual `npm install -g`.
 */
export function stopsServerOn(os: NodeJS.Platform): boolean {
  return os === 'win32';
}

/**
 * What an update would do, read before anything is touched so the screen can
 * say it and ask. Only what was read: the server is the one that answered
 * `/version`; how many agent sessions use it is what that body said
 * (`sessions`), and absent when the primary is older and sent none.
 */
export interface UpdatePlan {
  /** Whether the running server will be stopped (`stopsServerOn`). */
  stopsServer: boolean;
  server:
    | { kind: 'running'; version: string; pid: number; sessions?: number }
    /** Nothing answered and the OS lists no browser-link process. */
    | { kind: 'none' }
    /** Nothing usable answered, yet a server may be running. */
    | { kind: 'unreadable' };
  /** Other browser-link server processes the OS lists (proxies of other
   * agents, other consoles; an `npx` launch counts its npm wrapper too).
   * `null` when the process table could not be read. */
  otherProcesses: number | null;
}

export interface UpdatePlanDeps {
  os?: NodeJS.Platform;
  probe?: () => Promise<VersionProbe>;
  processTable?: () => Promise<ProcessEntry[]>;
  selfPid?: number;
}

/** Reads the update plan. Never rejects. */
export async function readUpdatePlan(deps: UpdatePlanDeps = {}): Promise<UpdatePlan> {
  const os = deps.os ?? process.platform;
  const [probe, table] = await Promise.all([
    (deps.probe ?? (() => probeVersion(BRIDGE_PORT)))().catch((): VersionProbe => ({
      kind: 'unreachable',
    })),
    (deps.processTable ?? (() => listProcessesAsync(os)))().catch((): ProcessEntry[] => []),
  ]);
  // A table that was read lists at least this console: empty means unread.
  const readable = table.length > 0;
  const primaryPid = probe.kind === 'version' ? probe.info.pid : null;
  const bridges = findBridgeProcesses(table, deps.selfPid ?? process.pid).filter(
    (p) => p.pid !== primaryPid,
  );
  let server: UpdatePlan['server'];
  if (probe.kind === 'version') {
    server = {
      kind: 'running',
      version: probe.info.version,
      pid: probe.info.pid,
      ...(probe.info.sessions === undefined ? {} : { sessions: probe.info.sessions }),
    };
  } else if (probe.kind === 'unreachable' && readable && bridges.length === 0) {
    server = { kind: 'none' };
  } else {
    server = { kind: 'unreadable' };
  }
  return {
    stopsServer: stopsServerOn(os),
    server,
    otherProcesses: readable ? bridges.length : null,
  };
}

/** The install's time limit. npm's own per-request fetch timeout is five
 * minutes, and better-sqlite3 builds from source when no prebuilt binary
 * matches: ten minutes covers both. A hung npm ends at the limit; the user
 * can cancel sooner. */
export const SELF_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

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

/** `unverified`: npm exited 0 but the version on disk could not be read
 * back, so nothing confirms the install. A version read back that is not the
 * requested one is `failed`. */
export type SelfUpdateOutcome =
  'installed' | 'failed' | 'unverified' | 'timed-out' | 'cancelled' | 'refused';

/** The installed package's version, read back from disk after npm exits. */
export type InstalledRead =
  { kind: 'read'; version: string } | { kind: 'unreadable'; reason: string };

export interface SelfUpdateResult {
  ok: boolean;
  outcome: SelfUpdateOutcome;
  /** The version requested (e.g. `"latest"`, `"0.5.3"`). */
  target: string;
  /** Final message — the one to show in the UI when the spinner stops. */
  message: string;
  /** What the stop step did, in full (`stop`'s own report, the processes it
   * left running included), or that nothing was stopped. `null` when the
   * update was refused before any step. */
  stopReport: string | null;
  /** What the user should do now. */
  nextStep: string;
  /** The version read back from the installed package after npm exited 0;
   * absent when npm failed or the read failed. */
  installedVersion?: string;
  /** Combined npm stderr in case the caller wants to dump it for diagnosis. */
  stderr?: string;
}

/** The timer the install's time limit uses; injected by tests. */
export interface SelfUpdateTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const REAL_TIMERS: SelfUpdateTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

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
  /** Skip the stop step whatever the OS. Tests / dry-run use this. */
  skipFreePort?: boolean;
  /** The OS that decides whether the server is stopped. Default: this one. */
  os?: NodeJS.Platform;
  /** The stop itself. Default `runFreePort` (`browser-link stop`). */
  stopServers?: (language: Language) => FreePortResult;
  /** Override the actual spawn for tests. */
  spawnImpl?: typeof spawn;
  /** Cancels the install: npm is stopped and the result says so. */
  signal?: AbortSignal;
  /** Default `SELF_UPDATE_TIMEOUT_MS`. */
  timeoutMs?: number;
  timers?: SelfUpdateTimers;
  /** Closes the databases this console opened, before npm runs. Default
   * closes the map DB (`closeDb`) and the activity DB (`closeActivityDb`). */
  closeDatabases?: () => void;
  /** npm's working directory. Default `os.homedir()` (see `neutralCwd`). */
  cwd?: string;
  /** Reads the installed version back after npm exits 0. Default
   * `readInstalledPackageVersion` (`npm root -g`, then that package.json). */
  readInstalled?: () => Promise<InstalledRead>;
  /** Whether this console process has loaded better-sqlite3's native module.
   * Default `loadsNativeSqlite`. */
  consoleHoldsNativeModule?: () => boolean;
}

/**
 * The directory npm runs in. Not the console's own working directory: that
 * is wherever the user launched the console (a project of theirs, with its
 * own package.json and .npmrc, or a folder inside the very package being
 * replaced, which Windows will not let npm move). The home directory always
 * exists, belongs to the user, is never inside the global package, and adds
 * no configuration: npm reads `~/.npmrc` as the user config from any
 * directory anyway.
 */
export function neutralCwd(): string {
  return homedir();
}

/**
 * Whether this process has loaded better-sqlite3's native module. Closing a
 * database does not unload it: Node never unloads an addon, and Windows keeps
 * a loaded module's file locked until the process exits. Read from the
 * process report's list of loaded shared objects; false when it cannot be
 * read.
 */
export function loadsNativeSqlite(
  report: () => unknown = () => process.report.getReport(),
): boolean {
  try {
    const shared = (report() as { sharedObjects?: unknown }).sharedObjects;
    if (!Array.isArray(shared)) return false;
    return shared.some(
      (p) => typeof p === 'string' && /[\\/]better-sqlite3[\\/].*\.node$/i.test(p),
    );
  } catch {
    return false;
  }
}

/** How long reading the installed version back may take. */
const READ_BACK_TIMEOUT_MS = 60_000;

export interface ReadInstalledDeps {
  spawnImpl: typeof spawn;
  /** The npm invocation the install used, without its arguments. */
  command: string;
  argvPrefix: string[];
  useShell: boolean;
  cwd: string;
  packageName: string;
  timers?: SelfUpdateTimers;
  timeoutMs?: number;
  /** Reads a package.json's version. Default `readInstalledVersion`. */
  readVersion?: (pkgJsonPath: string) => string | null;
}

/**
 * The installed package's version, read from disk: `npm root -g` (the same
 * npm, the same directory as the install) names the global `node_modules`,
 * and the package's own package.json there says the version. Never rejects.
 */
export function readInstalledPackageVersion(deps: ReadInstalledDeps): Promise<InstalledRead> {
  const timers = deps.timers ?? REAL_TIMERS;
  const readVersion = deps.readVersion ?? readInstalledVersion;
  return new Promise<InstalledRead>((resolve) => {
    let child: ChildProcess;
    try {
      child = deps.spawnImpl(deps.command, [...deps.argvPrefix, 'root', '-g'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: deps.cwd,
        ...(deps.useShell ? { shell: true } : {}),
      });
    } catch (err) {
      resolve({ kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    let settled = false;
    const settle = (read: InstalledRead, kill: boolean): void => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      if (kill) child.kill();
      resolve(read);
    };
    const timer = timers.setTimeout(() => {
      settle({ kind: 'unreadable', reason: '`npm root -g` did not answer' }, true);
    }, deps.timeoutMs ?? READ_BACK_TIMEOUT_MS);
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', () => {
      /* drain */
    });
    child.on('error', (err) => {
      settle({ kind: 'unreadable', reason: err.message }, false);
    });
    child.on('close', (code) => {
      const root = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .at(-1);
      if (code !== 0 || root === undefined) {
        settle(
          { kind: 'unreadable', reason: `\`npm root -g\` exited with code ${String(code)}` },
          false,
        );
        return;
      }
      const pkgJson = join(root, ...deps.packageName.split('/'), 'package.json');
      const version = readVersion(pkgJson);
      settle(
        version === null
          ? { kind: 'unreadable', reason: `no version in ${pkgJson}` }
          : { kind: 'read', version },
        false,
      );
    });
  });
}

interface SelfUpdateI18n {
  starting: (target: string) => string;
  stopFailed: (reason: string) => string;
  nothingStopped: string;
  installing: (target: string) => string;
  installed: (target: string) => string;
  failed: (reason: string) => string;
  noErrorOutput: (code: number | null) => string;
  timedOut: (minutes: number) => string;
  cancelled: string;
  restartHint: string;
  nextAfterStop: string;
  nextWithoutStop: string;
  nextInterrupted: (ref: string) => string;
  nextNotInstalled: string;
  nextFailed: (ref: string) => string;
  nextLocked: (ref: string) => string;
  refusedTarget: (target: string) => string;
  refusedPackage: (name: string) => string;
  permissionHint: string;
  versionMismatch: (target: string, found: string) => string;
  unverified: (reason: string) => string;
  nextUnconfirmed: (ref: string, pkg: string) => string;
  reloadExtension: (version: string) => string;
  refusedLockedSelf: string;
  nextLockedSelf: (ref: string) => string;
}

const I18N: Record<Language, SelfUpdateI18n> = {
  en: {
    starting: (t) => `Updating browser-link → ${t}`,
    stopFailed: (reason) =>
      `Could not stop the running browser-link primary: ${reason}. Continuing with the install anyway.`,
    nothingStopped: 'Nothing was stopped.',
    installing: (t) => `Running: npm install -g ${PACKAGE_NAME}@${t}`,
    installed: (t) =>
      `✓ Installed browser-link@${t} (read back from the installed package). Restart your MCP client (Claude Code, OpenCode, Copilot CLI, …) to load the new version.`,
    failed: (reason) => `✗ Update failed: ${reason}`,
    noErrorOutput: (code) => `npm exited with code ${code ?? 'unknown'} and printed no error.`,
    timedOut: (minutes) =>
      `✗ The install did not finish within ${minutes} minutes. npm was asked to stop.`,
    cancelled: '✗ You cancelled the install. npm was asked to stop.',
    restartHint: 'Restart your MCP client to pick up the new version.',
    nextAfterStop:
      'Agents connected through the stopped server lost it: restart your MCP clients, and the first one to start runs the new version.',
    nextWithoutStop:
      'A server that was already running keeps the old version until it restarts: restart your MCP clients, and the first one to start takes the port over with the new version.',
    nextInterrupted: (ref) =>
      `npm was asked to stop, but this tool cannot confirm that it ended: it may still be running (on Windows only the shell that launched it may have ended). Check for a leftover npm or node process (Task Manager on Windows, \`ps\` on macOS and Linux). browser-link may be incomplete: once npm is gone, run \`npm install -g ${ref}\` in a terminal to finish it.`,
    nextNotInstalled: 'Nothing was installed.',
    nextFailed: (ref) =>
      `Nothing was installed. Run \`npm install -g ${ref}\` in a terminal to see npm's full output.`,
    nextLocked: (ref) =>
      `A running process still holds browser-link's files (Windows locks a loaded native module). Close every browser-link console and MCP client, then run \`npm install -g ${ref}\` in a new terminal.`,
    refusedTarget: (t) =>
      `✗ Refusing to install "${t}": a target must be "latest" or an exact version like 1.2.3.`,
    refusedPackage: (name) =>
      `✗ Refusing to install "${name}": it does not match the npm package-name grammar.`,
    permissionHint:
      'npm could not write to your global install directory. Either re-run with elevated permissions (`sudo npm install -g ' +
      PACKAGE_NAME +
      '@latest`), or point npm at a user-owned prefix (`npm config set prefix ~/.npm-global`) and reopen your shell.',
    versionMismatch: (target, found) =>
      `✗ npm finished without an error, but the installed browser-link is ${found}, not ${target}.`,
    unverified: (reason) =>
      `✗ npm finished without an error, but the installed version could not be read back (${reason}), so the update is not confirmed.`,
    nextUnconfirmed: (ref, pkg) =>
      `Run \`npm install -g ${ref}\` in a terminal, then \`npm ls -g ${pkg}\` to see which version is installed.`,
    reloadExtension: (version) =>
      `Last step: reload the browser-link extension in chrome://extensions (the reload button on its card) so it runs ${version} too. Once a tab reconnects, the extension popup and browser.list_tabs say whether the extension and the server run the same version; this console cannot see the extension, so it has not checked that.`,
    refusedLockedSelf:
      '✗ Not updating from this console: it has loaded the map database module (Doctor or a map screen opened the map), and Windows keeps that file locked until this console exits, so npm could not replace it. Nothing was stopped or installed.',
    nextLockedSelf: (ref) =>
      `Close this console. browser-link has no update command of its own, so in a new terminal run \`browser-link stop\` (it does not open the map), close your MCP clients, then run \`npm install -g ${ref}\`.`,
  },
  es: {
    starting: (t) => `Actualizando browser-link → ${t}`,
    stopFailed: (reason) =>
      `No se pudo detener el primary en uso: ${reason}. Igual sigo con la instalación.`,
    nothingStopped: 'No se detuvo nada.',
    installing: (t) => `Ejecutando: npm install -g ${PACKAGE_NAME}@${t}`,
    installed: (t) =>
      `✓ Instalado browser-link@${t} (leído del paquete instalado). Reiniciá tu cliente MCP (Claude Code, OpenCode, Copilot CLI, …) para cargar la nueva versión.`,
    failed: (reason) => `✗ La actualización falló: ${reason}`,
    noErrorOutput: (code) =>
      `npm terminó con el código ${code ?? 'desconocido'} y no mostró ningún error.`,
    timedOut: (minutes) =>
      `✗ La instalación no terminó en ${minutes} minutos. Se le pidió a npm que se detenga.`,
    cancelled: '✗ Cancelaste la instalación. Se le pidió a npm que se detenga.',
    restartHint: 'Reiniciá tu cliente MCP para que tome la nueva versión.',
    nextAfterStop:
      'Los agentes conectados por el servidor detenido lo perdieron: reiniciá tus clientes MCP, y el primero que arranque corre la versión nueva.',
    nextWithoutStop:
      'Un servidor que ya estaba corriendo sigue con la versión anterior hasta que se reinicie: reiniciá tus clientes MCP, y el primero que arranque toma el puerto con la versión nueva.',
    nextInterrupted: (ref) =>
      `Se le pidió a npm que se detenga, pero esta herramienta no puede confirmar que haya terminado: puede seguir corriendo (en Windows puede haber terminado solo el intérprete que lo lanzó). Fijate si queda algún proceso npm o node (Administrador de tareas en Windows, \`ps\` en macOS y Linux). browser-link puede haber quedado incompleto: cuando npm ya no esté, corré \`npm install -g ${ref}\` en una terminal para terminarlo.`,
    nextNotInstalled: 'No se instaló nada.',
    nextFailed: (ref) =>
      `No se instaló nada. Corré \`npm install -g ${ref}\` en una terminal para ver la salida completa de npm.`,
    nextLocked: (ref) =>
      `Un proceso en marcha todavía tiene tomados los archivos de browser-link (Windows bloquea un módulo nativo cargado). Cerrá toda consola de browser-link y todo cliente MCP, y después corré \`npm install -g ${ref}\` en una terminal nueva.`,
    refusedTarget: (t) =>
      `✗ No instalo "${t}": el destino tiene que ser "latest" o una versión exacta como 1.2.3.`,
    refusedPackage: (name) =>
      `✗ No instalo "${name}": no cumple la gramática de nombres de paquete de npm.`,
    permissionHint:
      'npm no pudo escribir en tu directorio de instalación global. O lo corrés con permisos elevados (`sudo npm install -g ' +
      PACKAGE_NAME +
      '@latest`), o apuntás npm a un prefix propio (`npm config set prefix ~/.npm-global`) y reabrís la terminal.',
    versionMismatch: (target, found) =>
      `✗ npm terminó sin error, pero el browser-link instalado es ${found}, no ${target}.`,
    unverified: (reason) =>
      `✗ npm terminó sin error, pero no se pudo leer la versión instalada (${reason}), así que la actualización no está confirmada.`,
    nextUnconfirmed: (ref, pkg) =>
      `Corré \`npm install -g ${ref}\` en una terminal, y después \`npm ls -g ${pkg}\` para ver qué versión quedó instalada.`,
    reloadExtension: (version) =>
      `Último paso: recargá la extensión browser-link en chrome://extensions (el botón de recarga de su tarjeta) para que también corra ${version}. Cuando una pestaña se reconecte, el popup de la extensión y browser.list_tabs dicen si la extensión y el servidor corren la misma versión; esta consola no ve la extensión, así que eso no lo comprobó.`,
    refusedLockedSelf:
      '✗ No actualizo desde esta consola: cargó el módulo de la base de datos del mapa (Doctor o una pantalla del mapa abrió el mapa), y Windows mantiene ese archivo bloqueado hasta que esta consola se cierre, así que npm no podría reemplazarlo. No se detuvo ni se instaló nada.',
    nextLockedSelf: (ref) =>
      `Cerrá esta consola. browser-link no tiene un comando propio de actualización, así que en una terminal nueva corré \`browser-link stop\` (no abre el mapa), cerrá tus clientes MCP, y después corré \`npm install -g ${ref}\`.`,
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
  const refuse = (message: string, nextStep: string = t.nextNotInstalled): SelfUpdateResult => {
    emitRefusal(onProgress, message);
    return {
      ok: false,
      outcome: 'refused',
      target,
      message,
      stopReport: null,
      nextStep,
    };
  };
  if (!isSafeUpdateTarget(target)) return refuse(t.refusedTarget(target));
  try {
    assertSafeNpmName(pkgName);
  } catch {
    return refuse(t.refusedPackage(pkgName));
  }
  // Windows needs BOTH halves of this, and getting only the first was the
  // long-standing bug: `npm` on Windows is `npm.cmd`, so a bare
  // `spawn('npm', …)` throws ENOENT — and since Node 18.20.2 / 20.12.2 /
  // 21.7.3 (the CVE-2024-27980 mitigation) spawning a `.cmd` WITHOUT a
  // shell throws EINVAL. Naming the shim was necessary but not
  // sufficient. We opt into the shell on Windows only, and only after
  // allow-list validating the package ref above, so the quoting surface
  // it adds never sees an unvalidated value.
  const os = opts.os ?? process.platform;
  const isWindows = os === 'win32';
  const doSpawn = opts.spawnImpl ?? spawn;

  // On Windows a console that has loaded better-sqlite3's native module
  // (Doctor or a map screen opened the map) holds its file locked until this
  // process exits, and closing the database does not unload it. npm would
  // fail partway through replacing the package, which is worse than not
  // starting: refuse before anything is stopped or spawned.
  if (isWindows && (opts.consoleHoldsNativeModule ?? loadsNativeSqlite)()) {
    return refuse(t.refusedLockedSelf, t.nextLockedSelf(`${pkgName}@${target}`));
  }

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

  // Stop the running server only where the install needs it (Windows).
  // Failure here is non-fatal — we still try to install; only the install
  // failure is treated as terminal. The report is `stop`'s own, whole: the
  // processes it stopped and the ones it left running.
  const stopping = !opts.skipFreePort && stopsServerOn(os);
  let stopReport = t.nothingStopped;
  if (stopping) {
    const stop = opts.stopServers ?? runFreePort;
    try {
      stopReport = stop(language).message;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      stopReport = t.stopFailed(reason);
    }
    emit('stopping-primary', stopReport);
  }

  const ref = `${pkgName}@${target}`;
  const finish = (
    outcome: Exclude<SelfUpdateOutcome, 'refused'>,
    message: string,
    nextStep: string,
    extra: { stderr?: string; installedVersion?: string } = {},
  ): SelfUpdateResult => {
    emit(outcome === 'installed' ? 'done' : 'failed', message);
    return {
      ok: outcome === 'installed',
      outcome,
      target,
      message,
      stopReport,
      nextStep,
      ...(extra.installedVersion === undefined ? {} : { installedVersion: extra.installedVersion }),
      ...(extra.stderr === undefined ? {} : { stderr: extra.stderr }),
    };
  };

  if (opts.signal?.aborted === true) return finish('cancelled', t.cancelled, t.nextNotInstalled);

  // The databases this console opened (Doctor and the map screens open the
  // map) are closed before npm runs, so no handle of ours is left on them
  // while the package is replaced. This does NOT unload better-sqlite3's
  // native module: Node never unloads an addon (see `loadsNativeSqlite`).
  try {
    (opts.closeDatabases ?? closeAllDatabases)();
  } catch {
    /* a close that throws leaves nothing worse than before: install anyway */
  }

  emit('installing', t.installing(target));

  const cwd = opts.cwd ?? neutralCwd();
  const timeoutMs = opts.timeoutMs ?? SELF_UPDATE_TIMEOUT_MS;
  const timers = opts.timers ?? REAL_TIMERS;
  const installResult = await new Promise<InstallExit>((resolve) => {
    let child: ChildProcess;
    try {
      child = doSpawn(command, [...argv, ref], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
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
      resolve({
        kind: 'exited',
        code: 1,
        stderr: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    let settled = false;
    // Kills npm once, for the time limit or a cancel, and resolves at once:
    // waiting for 'close' would hang again if the kill did not take.
    const settle = (exit: InstallExit, kill: boolean): void => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (kill) child.kill();
      resolve(exit);
    };
    const onAbort = (): void => {
      settle({ kind: 'cancelled' }, true);
    };
    const timer = timers.setTimeout(() => {
      settle({ kind: 'timed-out' }, true);
    }, timeoutMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
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
      settle({ kind: 'exited', code: 1, stderr: err.message }, false);
    });
    child.on('close', (code) => {
      settle({ kind: 'exited', code, stderr }, false);
    });
  });

  // Each stop below asked npm to stop partway through its work. `child.kill()`
  // ends only the process we spawned: through the Windows `.cmd` shell
  // fallback that is `cmd.exe`, and npm's own children (build scripts) are
  // never reached on any OS. Node offers no tree kill, so nothing here
  // observed npm end, and the text claims only that it was asked to.
  if (installResult.kind === 'timed-out') {
    return finish('timed-out', t.timedOut(timeoutMs / 60_000), t.nextInterrupted(ref));
  }
  if (installResult.kind === 'cancelled') {
    return finish('cancelled', t.cancelled, t.nextInterrupted(ref));
  }

  if (installResult.code !== 0) {
    const { stderr } = installResult;
    // A global-install permission failure is the single most common way
    // this fails on macOS and Linux, and npm's own last line ("EACCES:
    // permission denied") tells the user nothing about what to do. Append
    // the two real remedies instead of making them search. On Windows the
    // global prefix is the user's own, so EPERM/EBUSY there is a file lock.
    const locked = isWindows && LOCK_RE.test(stderr);
    const hint = !locked && PERMISSION_RE.test(stderr) ? `\n${t.permissionHint}` : '';
    const reason = npmErrorSummary(stderr) ?? t.noErrorOutput(installResult.code);
    // This console holding the module was refused before npm ran, so a lock
    // here belongs to another process.
    const nextStep = locked ? t.nextLocked(ref) : t.nextFailed(ref);
    return finish('failed', t.failed(reason) + hint, nextStep, { stderr });
  }

  // npm's exit code says npm thinks it worked; only the package on disk says
  // which version is there now.
  const read = await (
    opts.readInstalled ??
    (() =>
      readInstalledPackageVersion({
        spawnImpl: doSpawn,
        command,
        argvPrefix: argv.slice(0, argv.length - installArgs.length),
        useShell,
        cwd,
        packageName: pkgName,
        timers,
      }))
  )().catch((err: unknown): InstalledRead => ({
    kind: 'unreadable',
    reason: err instanceof Error ? err.message : String(err),
  }));
  if (read.kind === 'unreadable') {
    return finish('unverified', t.unverified(read.reason), t.nextUnconfirmed(ref, pkgName));
  }
  if (target !== 'latest' && read.version !== target) {
    return finish(
      'failed',
      t.versionMismatch(target, read.version),
      t.nextUnconfirmed(ref, pkgName),
      { installedVersion: read.version },
    );
  }
  const restart = stopping ? t.nextAfterStop : t.nextWithoutStop;
  return finish(
    'installed',
    t.installed(read.version),
    `${restart}\n${t.reloadExtension(read.version)}`,
    { installedVersion: read.version },
  );
}

/** The default `closeDatabases`: every database this process may have open. */
function closeAllDatabases(): void {
  closeDb();
  closeActivityDb();
}

type InstallExit =
  | { kind: 'exited'; code: number | null; stderr: string }
  | { kind: 'timed-out' }
  | { kind: 'cancelled' };

/** Windows' "a running process holds this file" errors. */
const LOCK_RE = /\bEBUSY\b|\bEPERM\b/;

/** How many of npm's error lines a failure shows. */
const MAX_ERROR_LINES = 4;

/**
 * npm's real error out of its error output. npm ends every failure with
 * "A complete log of this run can be found in: …", so the last line names a
 * log file, never the error: keep the `npm error` lines before it (the code
 * and the reason), or the last line of anything else. `null` when npm
 * printed nothing.
 */
export function npmErrorSummary(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/complete log of this run/i.test(line));
  const npmLines = lines.filter((line) => /^npm (?:error|ERR!)\s+\S/.test(line));
  if (npmLines.length > 0) return npmLines.slice(0, MAX_ERROR_LINES).join('\n');
  return lines.at(-1) ?? null;
}
