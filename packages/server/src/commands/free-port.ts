import { platform } from 'node:os';
import type { Language } from './welcome.js';
import { IPC_PORT, BRIDGE_PORT } from '../bridge/protocol.js';
import {
  defaultExecFile,
  findBridgeProcesses,
  listProcesses,
  selfAndAncestors,
  shortCommand,
  type ExecFileLike,
  type ProcessEntry,
} from '../lifecycle/processes.js';
import {
  inspectPortHolder,
  identifyProcess,
  isBrowserLinkServer,
  LOOKUP_FAILURE_TEXT,
  PORT_LOOKUP_TIMEOUT_MS,
  type PortHolder,
  type PortLookupFailure,
  type ProcessIdentity,
} from '../lifecycle/port-holder.js';

const WS_HOST = '127.0.0.1';
const WS_PORT = BRIDGE_PORT;

/**
 * What `stop` established about the bridge port, so callers never infer it
 * from `pid == null` (a failed lookup has no pid either):
 * - `free`: the OS lookup ran and lists no listener;
 * - `stopped`: the OS-verified browser-link holder was killed;
 * - `stop-failed`: that holder was verified but the kill failed;
 * - `held-by-other`: the holder is not a verified browser-link server (or is
 *   this command), so it was left running;
 * - `unknown`: the OS lookup failed; nothing is known and nothing was stopped.
 */
export type PortState = 'free' | 'stopped' | 'stop-failed' | 'held-by-other' | 'unknown';

/** The result of the explicit `stop --pid`, which is not about one port. */
export interface StopPidResult {
  ok: boolean;
  pid: number | null;
  imageName: string | null;
  message: string;
  processes?: StoppedProcess[];
}

export interface FreePortResult {
  /** The state of the bridge port as this run established it. */
  portState: PortState;
  /** True when the OS confirmed the port free (nothing to do) OR every
   * process this run tried to stop was stopped. */
  ok: boolean;
  /** PID the OS reports bound to WS_PORT (or, for `stop --pid`, the PID
   * asked for); null when the port is free or its holder is unknown. */
  pid: number | null;
  /** Image / executable name reported by the OS. */
  imageName: string | null;
  /** Human-readable message in the requested language. */
  message: string;
  /** Every process this run tried to stop, in kill order. Absent when there
   * was none, so the "already free" result keeps its exact shape. */
  processes?: StoppedProcess[];
}

export interface StoppedProcess {
  pid: number;
  /** Short display form, e.g. `node browser-link start`. */
  command: string;
  stopped: boolean;
}

/** The OS effects of `stop`, injected so tests never look up or kill a real
 * process. Production uses the real OS commands. */
export interface StopDeps {
  os?: NodeJS.Platform;
  exec?: ExecFileLike;
  /** The OS process table. Default: one `listProcesses` per run. */
  listProcesses?: () => ProcessEntry[];
  /** Stop one process; false when the OS refused. */
  kill?: (pid: number) => boolean;
  selfPid?: number;
}

function killByPid(pid: number, os: NodeJS.Platform, exec: ExecFileLike): boolean {
  try {
    if (os === 'win32') {
      exec('taskkill', ['/F', '/PID', String(pid)], { timeout: PORT_LOOKUP_TIMEOUT_MS });
      return true;
    }
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

interface FreePortI18n {
  alreadyFree: string;
  lookupFailed: (reason: string) => string;
  failure: Record<PortLookupFailure, string>;
  killed: (pid: number) => string;
  killFailed: (pid: number) => string;
  notBrowserLink: (who: string, pid: number) => string;
  selfOrAncestor: (pid: number) => string;
  othersHeader: string;
  stopped: string;
  stopFailed: string;
  unverifiedHeader: string;
  stopCommand: (pid: number) => string;
  nameUnknown: string;
  target: (who: string, holds: string) => string;
  holds: (address: string) => string;
  notListed: (pid: number) => string;
  notEligible: (who: string) => string;
  stoppedPid: (pid: number) => string;
}

const IPC_ADDRESS = `${WS_HOST}:${IPC_PORT}`;
const WS_ADDRESS = `${WS_HOST}:${WS_PORT}`;

const I18N: Record<Language, FreePortI18n> = {
  en: {
    alreadyFree: `Port ${WS_ADDRESS} is already free — nothing to stop.`,
    lookupFailed: (reason) =>
      `✗ Could not check through the operating system which process holds port ${WS_ADDRESS}: ${reason}. ` +
      `Nothing was stopped.`,
    failure: LOOKUP_FAILURE_TEXT,
    killed: (pid) => `✓ Stopped browser-link primary (PID ${pid}). Port ${WS_ADDRESS} is now free.`,
    killFailed: (pid) =>
      `✗ Could not kill PID ${pid}. Try again as administrator, or close the MCP client manually.`,
    notBrowserLink: (who, pid) =>
      `✗ Port ${WS_ADDRESS} is held by ${who}, which the operating system does not show as a ` +
      `browser-link server. Nothing was stopped. To stop that process: browser-link stop --pid ${pid}`,
    selfOrAncestor: (pid) =>
      `✗ PID ${pid} is this command or one of the processes that started it. Nothing was stopped.`,
    othersHeader: 'Other browser-link processes:',
    stopped: '✓ stopped',
    stopFailed: '✗ could not stop',
    unverifiedHeader:
      'Other browser-link processes, not stopped (they hold no browser-link port, so the ' +
      'operating system cannot confirm them through it):',
    stopCommand: (pid) => `to stop it: browser-link stop --pid ${pid}`,
    nameUnknown: 'name unknown',
    target: (who, holds) => `Process to stop: ${who}${holds}`,
    holds: (address) => `, holds ${address}`,
    notListed: (pid) =>
      `✗ The operating system lists no process with PID ${pid}, or could not be asked. ` +
      `Nothing was stopped.`,
    notEligible: (who) =>
      `✗ ${who} is not a browser-link server and holds no browser-link port ` +
      `(${WS_ADDRESS}, ${IPC_ADDRESS}). Nothing was stopped.`,
    stoppedPid: (pid) => `✓ Stopped PID ${pid}.`,
  },
  es: {
    alreadyFree: `El puerto ${WS_ADDRESS} ya está libre — no hay nada que parar.`,
    lookupFailed: (reason) =>
      `✗ No se pudo comprobar con el sistema operativo qué proceso ocupa el puerto ${WS_ADDRESS}: ${reason}. ` +
      `No se detuvo nada.`,
    failure: {
      'command-missing': 'la herramienta de consulta (netstat o lsof) no está instalada',
      timeout: 'la consulta superó el tiempo límite',
      'command-failed': 'falló el comando de consulta',
      'unreadable-output': 'la consulta devolvió una salida que no se pudo leer',
      'several-holders': 'figura más de un proceso en el puerto',
    },
    killed: (pid) =>
      `✓ browser-link primary detenido (PID ${pid}). El puerto ${WS_ADDRESS} quedó libre.`,
    killFailed: (pid) =>
      `✗ No se pudo detener el PID ${pid}. Inténtelo de nuevo como administrador o cierre el cliente MCP manualmente.`,
    notBrowserLink: (who, pid) =>
      `✗ El puerto ${WS_ADDRESS} lo ocupa el ${who}, que el sistema operativo no muestra como un ` +
      `servidor browser-link. No se detuvo nada. Para detener ese proceso: browser-link stop --pid ${pid}`,
    selfOrAncestor: (pid) =>
      `✗ El PID ${pid} es este comando o uno de los procesos que lo iniciaron. No se detuvo nada.`,
    othersHeader: 'Otros procesos de browser-link:',
    stopped: '✓ detenido',
    stopFailed: '✗ no se pudo detener',
    unverifiedHeader:
      'Otros procesos de browser-link, no detenidos (no ocupan ningún puerto de browser-link, ' +
      'así que el sistema operativo no puede confirmarlos por esa vía):',
    stopCommand: (pid) => `para detenerlo: browser-link stop --pid ${pid}`,
    nameUnknown: 'nombre desconocido',
    target: (who, holds) => `Proceso a detener: ${who}${holds}`,
    holds: (address) => `, ocupa ${address}`,
    notListed: (pid) =>
      `✗ El sistema operativo no muestra ningún proceso con el PID ${pid}, o no se pudo consultar. ` +
      `No se detuvo nada.`,
    notEligible: (who) =>
      `✗ El ${who} no es un servidor browser-link y no ocupa ningún puerto de browser-link ` +
      `(${WS_ADDRESS}, ${IPC_ADDRESS}). No se detuvo nada.`,
    stoppedPid: (pid) => `✓ PID ${pid} detenido.`,
  },
};

/** What one run reads from the OS, each at most once. */
class OsView {
  readonly os: NodeJS.Platform;
  readonly exec: ExecFileLike;
  readonly kill: (pid: number) => boolean;
  readonly selfPid: number;
  private readonly readTable: () => ProcessEntry[];
  private table: ProcessEntry[] | null = null;

  constructor(deps: StopDeps) {
    this.os = deps.os ?? platform();
    this.exec = deps.exec ?? defaultExecFile;
    this.kill = deps.kill ?? ((pid) => killByPid(pid, this.os, this.exec));
    this.selfPid = deps.selfPid ?? process.pid;
    this.readTable = deps.listProcesses ?? (() => listProcesses(this.os, this.exec));
  }

  processes(): ProcessEntry[] {
    this.table ??= this.readTable();
    return this.table;
  }

  private lookup() {
    return { os: this.os, exec: this.exec, processTable: () => this.processes() };
  }

  holder(port: number): PortHolder {
    return inspectPortHolder(port, this.lookup());
  }

  identify(pid: number): ProcessIdentity {
    return identifyProcess(pid, this.lookup());
  }

  isSelfOrAncestor(pid: number): boolean {
    return pid === this.selfPid || selfAndAncestors(this.processes(), this.selfPid).has(pid);
  }
}

function who(identity: ProcessIdentity, t: FreePortI18n): string {
  const name = identity.imageName ?? t.nameUnknown;
  const command = identity.command === null ? '' : ` — ${shortCommand(identity.command)}`;
  return `PID ${identity.pid} (${name})${command}`;
}

function displayCommand(identity: ProcessIdentity): string {
  return identity.command === null ? (identity.imageName ?? '?') : shortCommand(identity.command);
}

/**
 * `browser-link stop`: stop the browser-link server holding WS_PORT, and the
 * one holding IPC_PORT, each only once the operating system confirms it
 * holds that port and is a browser-link server (owner decision D14,
 * `lifecycle/port-holder.ts`). Nothing is killed by resemblance:
 *
 * - "already free" is said only when the OS lookup ran and lists no
 *   listener; a lookup that failed says so and stops nothing;
 * - a holder that is not a verified browser-link server is left running,
 *   named (pid, image name, command line) with `browser-link stop --pid`;
 * - other browser-link processes found in the process table (proxies,
 *   strays) hold no port the OS can confirm them by: they are listed with
 *   the same command, never stopped.
 */
export function runFreePort(language: Language = 'en', deps: StopDeps = {}): FreePortResult {
  const t = I18N[language];
  const view = new OsView(deps);
  const lines: string[] = [];
  const processes: StoppedProcess[] = [];
  let ok = true;
  let pid: number | null = null;
  let imageName: string | null = null;
  let portState: PortState;

  const primary = view.holder(WS_PORT);
  if (primary.kind === 'free') {
    portState = 'free';
    lines.push(t.alreadyFree);
  } else if (primary.kind === 'unknown') {
    ok = false;
    portState = 'unknown';
    lines.push(t.lookupFailed(t.failure[primary.reason]));
  } else {
    const identity = primary.process;
    pid = identity.pid;
    imageName = identity.imageName;
    if (view.isSelfOrAncestor(identity.pid)) {
      ok = false;
      portState = 'held-by-other';
      lines.push(t.selfOrAncestor(identity.pid));
    } else if (!primary.isBrowserLink) {
      ok = false;
      portState = 'held-by-other';
      lines.push(t.notBrowserLink(who(identity, t), identity.pid));
    } else {
      const stopped = view.kill(identity.pid);
      ok &&= stopped;
      portState = stopped ? 'stopped' : 'stop-failed';
      processes.push({ pid: identity.pid, command: displayCommand(identity), stopped });
      lines.push(stopped ? t.killed(identity.pid) : t.killFailed(identity.pid));
    }
  }

  // The IPC port's holder, when it is another verified browser-link server.
  const ipc = view.holder(IPC_PORT);
  const handled = new Set<number>(pid === null ? [] : [pid]);
  if (
    ipc.kind === 'process' &&
    ipc.isBrowserLink &&
    !handled.has(ipc.process.pid) &&
    !view.isSelfOrAncestor(ipc.process.pid)
  ) {
    handled.add(ipc.process.pid);
    const stopped = view.kill(ipc.process.pid);
    ok &&= stopped;
    const command = displayCommand(ipc.process);
    processes.push({ pid: ipc.process.pid, command, stopped });
    lines.push(t.othersHeader);
    lines.push(`  PID ${ipc.process.pid}  ${command}  ${stopped ? t.stopped : t.stopFailed}`);
  }

  // Everything else that only looks like a bridge: named, never stopped.
  const unverified = findBridgeProcesses(view.processes(), view.selfPid).filter(
    (p) => !handled.has(p.pid),
  );
  if (unverified.length > 0) {
    lines.push(t.unverifiedHeader);
    for (const p of unverified) {
      lines.push(`  PID ${p.pid}  ${shortCommand(p.command)}  ${t.stopCommand(p.pid)}`);
    }
  }

  return {
    portState,
    ok,
    pid,
    imageName,
    message: lines.join('\n'),
    ...(processes.length > 0 ? { processes } : {}),
  };
}

/**
 * `browser-link stop --pid <PID>`: the explicit command the take-over and
 * `stop` point to. It shows the process as the operating system reports it
 * and stops that one process, nothing else. Asked by the user (or by an
 * agent on the user's order), it does not require a verified browser-link
 * holder; it refuses, stopping nothing, when the OS does not list the pid,
 * when it is this command or one of its ancestors, or when it neither holds
 * a browser-link port nor runs as a browser-link server.
 */
export function runStopPid(
  targetPid: number,
  language: Language = 'en',
  deps: StopDeps = {},
): StopPidResult {
  const t = I18N[language];
  const view = new OsView(deps);
  const identity = view.identify(targetPid);
  const refuse = (message: string): StopPidResult => ({
    ok: false,
    pid: targetPid,
    imageName: identity.imageName,
    message,
  });
  if (identity.imageName === null && identity.command === null) {
    return refuse(t.notListed(targetPid));
  }
  if (view.isSelfOrAncestor(targetPid)) return refuse(t.selfOrAncestor(targetPid));

  const held: string[] = [];
  for (const [port, address] of [
    [WS_PORT, WS_ADDRESS],
    [IPC_PORT, IPC_ADDRESS],
  ] as const) {
    const holder = view.holder(port);
    if (holder.kind === 'process' && holder.process.pid === targetPid) held.push(address);
  }
  if (held.length === 0 && !isBrowserLinkServer(identity)) {
    return refuse(t.notEligible(who(identity, t)));
  }

  const target = t.target(who(identity, t), held.map((a) => t.holds(a)).join(''));
  const stopped = view.kill(targetPid);
  return {
    ok: stopped,
    pid: targetPid,
    imageName: identity.imageName,
    message: [target, stopped ? t.stoppedPid(targetPid) : t.killFailed(targetPid)].join('\n'),
    processes: [{ pid: targetPid, command: displayCommand(identity), stopped }],
  };
}
