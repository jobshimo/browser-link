import { platform } from 'node:os';
import {
  defaultExecFile,
  isBridgeCommand,
  isRuntimeName,
  listProcesses,
  type ExecFileLike,
  type ProcessEntry,
} from './processes.js';

/**
 * Who holds a TCP port, and is it a browser-link server, as the operating
 * system reports it (owner decision D14). The primary election and
 * `browser-link stop` kill only a process this module verified: what a port
 * holder says about itself (the pid in its `/version` body) is a claim, and
 * is never the target of a kill.
 *
 * - The holder of the port is read from the kernel's socket table: Windows
 *   `netstat -ano -p TCP` (the listening row of the port, foreign port 0),
 *   macOS and Linux `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`.
 * - "A browser-link server" means both: its executable image is a runtime
 *   browser-link runs under (Windows `tasklist` image name, Unix `ps -o
 *   comm=`), and its command line in the OS process table (Windows
 *   `Win32_Process.CommandLine`, Unix `ps -o command=`) runs this package
 *   with no subcommand or `start` (`isBridgeCommand`).
 *
 * A process can write its own command line, but it cannot make the kernel
 * list it as the holder of a port another process holds: since only the
 * verified holder is ever killed, a process that lies can at worst get
 * itself killed, never another one.
 *
 * Every command is bounded by PORT_LOOKUP_TIMEOUT_MS; a missing tool, a
 * timeout, a failure or an output that cannot be read is `unknown`, never
 * `free`. Nothing here throws or kills.
 */

/** Bound of each OS command of a lookup. Same order as the peer lookup's
 * (`auth/process-identity.ts`), which a cold PowerShell start can need. */
export const PORT_LOOKUP_TIMEOUT_MS = 5000;

/** Why the holder of a port could not be read. */
export type PortLookupFailure =
  'command-missing' | 'timeout' | 'command-failed' | 'unreadable-output' | 'several-holders';

export type PortOwner =
  /** The lookup ran and lists no process listening on the port. */
  { kind: 'free' } | { kind: 'held'; pid: number } | { kind: 'unknown'; reason: PortLookupFailure };

/** A process as the OS reports it; null where the OS gave no answer. */
export interface ProcessIdentity {
  pid: number;
  imageName: string | null;
  command: string | null;
}

export type PortHolder =
  | { kind: 'free' }
  | { kind: 'unknown'; reason: PortLookupFailure }
  | { kind: 'process'; process: ProcessIdentity; isBrowserLink: boolean };

export interface PortLookupDeps {
  os?: NodeJS.Platform;
  exec?: ExecFileLike;
  /** The OS process table; read once per caller when given. */
  processTable?: () => readonly ProcessEntry[];
}

interface ExecError {
  code?: unknown;
  status?: unknown;
  signal?: unknown;
  stdout?: unknown;
}

function failureOf(err: unknown): PortLookupFailure {
  const e = (err ?? {}) as ExecError;
  if (e.code === 'ENOENT') return 'command-missing';
  if (e.code === 'ETIMEDOUT' || (e.signal !== undefined && e.signal !== null)) return 'timeout';
  return 'command-failed';
}

function isPid(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

function ownerOf(pids: readonly number[]): PortOwner {
  const distinct = [...new Set(pids)];
  if (distinct.length === 0) return { kind: 'free' };
  if (distinct.length > 1) return { kind: 'unknown', reason: 'several-holders' };
  return { kind: 'held', pid: distinct[0] };
}

/** The listening rows of `port` in `netstat -ano -p TCP`: local address on
 * that port and foreign port 0. The State column is not read: Windows
 * prints it localized. */
export function parseNetstatListeners(out: string, port: number): number[] | null {
  const pids: number[] = [];
  for (const line of out.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[0].toUpperCase() !== 'TCP') continue;
    const local = fields[1];
    if (local.slice(local.lastIndexOf(':') + 1) !== String(port)) continue;
    if (!fields[2].endsWith(':0')) continue;
    const pid = Number(fields[fields.length - 1]);
    if (!isPid(pid)) return null;
    pids.push(pid);
  }
  return pids;
}

/** `lsof -t` output: one pid per line. Null when a line is not a pid. */
export function parseLsofPids(out: string): number[] | null {
  const pids: number[] = [];
  for (const line of out.split(/\r?\n/)) {
    const text = line.trim();
    if (text === '') continue;
    if (!/^\d+$/.test(text) || !isPid(Number(text))) return null;
    pids.push(Number(text));
  }
  return pids;
}

/** The process listening on `port`, read from the OS socket table. */
export function findPortOwner(port: number, deps: PortLookupDeps = {}): PortOwner {
  const os = deps.os ?? platform();
  const exec = deps.exec ?? defaultExecFile;
  const options = { timeout: PORT_LOOKUP_TIMEOUT_MS };
  if (os === 'win32') {
    let out: string;
    try {
      out = exec('netstat', ['-ano', '-p', 'TCP'], options);
    } catch (err) {
      return { kind: 'unknown', reason: failureOf(err) };
    }
    const pids = parseNetstatListeners(out, port);
    return pids === null ? { kind: 'unknown', reason: 'unreadable-output' } : ownerOf(pids);
  }
  let out: string;
  try {
    out = exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], options);
  } catch (err) {
    // lsof exits 1 with no output when nothing matches; that, and only
    // that, is a port nobody listens on.
    const e = (err ?? {}) as ExecError;
    const printed = typeof e.stdout === 'string' ? e.stdout.trim() : '';
    if (e.status === 1 && e.code !== 'ENOENT' && printed === '') return { kind: 'free' };
    return { kind: 'unknown', reason: failureOf(err) };
  }
  const pids = parseLsofPids(out);
  return pids === null ? { kind: 'unknown', reason: 'unreadable-output' } : ownerOf(pids);
}

/** Image name of `pid` (Windows `tasklist`, Unix `ps -o comm=`), or null. */
export function readImageName(pid: number, deps: PortLookupDeps = {}): string | null {
  if (!isPid(pid)) return null;
  const os = deps.os ?? platform();
  const exec = deps.exec ?? defaultExecFile;
  const options = { timeout: PORT_LOOKUP_TIMEOUT_MS };
  try {
    if (os === 'win32') {
      // "node.exe","13212","Console","1","45,000 K"
      const out = exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], options).trim();
      if (!out.startsWith('"')) return null;
      const end = out.indexOf('"', 1);
      if (end <= 1) return null;
      const fields = out.split('","');
      if (fields.length > 1 && fields[1] !== String(pid)) return null;
      return out.slice(1, end);
    }
    const out = exec('ps', ['-p', String(pid), '-o', 'comm='], options).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** `pid` as the OS reports it: image name and command line. */
export function identifyProcess(pid: number, deps: PortLookupDeps = {}): ProcessIdentity {
  const table = deps.processTable ?? (() => listProcesses(deps.os, deps.exec));
  const command = table().find((p) => p.pid === pid)?.command ?? '';
  return { pid, imageName: readImageName(pid, deps), command: command === '' ? null : command };
}

/** Both OS facts say browser-link server: a runtime image and a command
 * line that runs this package as a server. */
export function isBrowserLinkServer(identity: ProcessIdentity): boolean {
  return (
    identity.imageName !== null &&
    isRuntimeName(identity.imageName) &&
    identity.command !== null &&
    isBridgeCommand(identity.command)
  );
}

/** Who holds `port` and whether it is a browser-link server. */
export function inspectPortHolder(port: number, deps: PortLookupDeps = {}): PortHolder {
  const owner = findPortOwner(port, deps);
  if (owner.kind !== 'held') return owner;
  const identity = identifyProcess(owner.pid, deps);
  return { kind: 'process', process: identity, isBrowserLink: isBrowserLinkServer(identity) };
}

/** Plain-English reason of each lookup failure, for log lines and the CLI. */
export const LOOKUP_FAILURE_TEXT: Readonly<Record<PortLookupFailure, string>> = {
  'command-missing': 'the lookup tool (netstat or lsof) is not installed',
  timeout: 'the lookup timed out',
  'command-failed': 'the lookup command failed',
  'unreadable-output': 'the lookup printed something that could not be read',
  'several-holders': 'more than one process is listed on the port',
};
