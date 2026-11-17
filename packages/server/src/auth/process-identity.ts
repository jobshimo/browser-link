import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import {
  KERNEL_OWNER_SCRIPT,
  kernelOwnerEnv,
  parseKernelOwnerReply,
  type KernelTcpRow,
} from './windows-tcp-owner.js';

const execFileAsync = promisify(execFile);
// Bounds each lookup command. A cold PowerShell start plus the CIM owner
// query was measured at about 1 s on Windows 11 and 0.5-0.7 s on the
// windows-latest GitHub runner; the slow `tasklist /V` fallback stays inside
// it on normal machines. A hung command fails closed. The first CIM call
// after boot, while WMI starts, took 8.2 s and over 10 s on that runner: it
// times out, the tasklist fallback still verifies the owner, but it reads no
// executable path, so strict mode refuses that one handshake; the next one,
// with WMI up, passes. A bound long enough for that first call was not kept:
// it varied past 10 s and would hold every hung lookup that long.
export const LOOKUP_TIMEOUT_MS = 5000;

/**
 * The total time one lookup may take across all its commands, when its
 * caller asks for a bound (`PeerLookupRequest.totalTimeoutMs`; the peer gate
 * always does). The longest sequence that can still end in an accept is two
 * full command bounds: on Windows a CIM call that times out (the first one
 * after boot) followed by the tasklist fallback, with netstat taking a few
 * tens of milliseconds out of the second; on macOS and Linux the two lsof
 * calls of strict mode. A lookup cut short by it fails with `deadline`.
 * On Windows the kernel-table PowerShell runs first (about 0.4 s); when it
 * times out, its fallback has what is left of this budget.
 */
export const PEER_LOOKUP_DEADLINE_MS = 2 * LOOKUP_TIMEOUT_MS;

/**
 * The most output one lookup command may print. Node's execFile default
 * (1 MiB) holds about 12 000 rows of `netstat -ano`, which a busy machine
 * (browsers, containers, a dev server under load) can exceed. 16 MiB holds
 * about 200 000 rows. An overflow fails with `output-too-large`.
 */
export const LOOKUP_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Waits between `netstat` snapshots when the peer's endpoint is not listed
 * yet. Measured on Windows 11 (2026-11-10, 800 fresh loopback connections
 * polled every 20 ms): about 2 % are missing from the first snapshot and
 * listed about 50-65 ms later; one appeared after about 0.9 s, and one was
 * still missing after 3 s. netstat itself takes about 12-20 ms. Six
 * snapshots over 1.25 s of waiting cover that tail; a genuinely unlisted
 * endpoint is refused about 1.35 s later than before, well inside
 * LOOKUP_TIMEOUT_MS (each command has its own). Only `endpoint-not-listed`
 * is retried.
 */
export const NETSTAT_RETRY_DELAYS_MS = [50, 100, 200, 400, 500] as const;
export const NETSTAT_SNAPSHOTS = NETSTAT_RETRY_DELAYS_MS.length + 1;

export interface PeerProcess {
  pid: number;
  binaryName: string;
  /** Absolute path of the peer's executable. Present only when the lookup
   * was asked for it (`withExecutablePath`); a lookup that was asked and
   * could not read it fails with `path-unreadable` instead. */
  executablePath?: string;
}

/**
 * Identify which OS process owns the LOCAL end of a TCP connection at
 * `host:port`, and confirm it runs as the same OS user as this server.
 * Returns null when the lookup cannot resolve a single owner (no result,
 * ambiguous result, command not available, timeout) or when that owner is
 * another user, or its user cannot be read.
 *
 * The caller decides how to treat null: this module's only job is to ask the
 * kernel honestly. Concretely the server treats null as "reject", so users
 * on systems without lsof / netstat fail closed.
 *
 * Defense in depth: even if the OS lookup somehow points at our own process,
 * we return null. The auth path must never identify the server as its own
 * peer — that would short-circuit the allowlist check.
 */
export async function lookupPeerProcess(
  host: string,
  port: number,
  deps: PeerLookupDeps = {},
  request: PeerLookupRequest = {},
): Promise<PeerProcess | null> {
  const result = await lookupPeerProcessDetailed(host, port, deps, request);
  return result.ok ? result.peer : null;
}

/**
 * Why a peer lookup produced no accepted owner, for the handshake-refusal
 * log line:
 * - `timeout`: a lookup command exceeded LOOKUP_TIMEOUT_MS.
 * - `command-missing`: lsof / netstat / tasklist is not installed or not
 *   on PATH (ENOENT).
 * - `command-failed:<exit>`: the command ran and exited non-zero (lsof
 *   exits 1 when nothing matches).
 * - `parse-miss`: lsof or the tasklist fallback succeeded but no single
 *   owner could be read from its output.
 * - `endpoint-not-listed`: netstat lists no connection whose local end is
 *   the peer's endpoint.
 * - `endpoint-ambiguous`: netstat lists that local endpoint under two
 *   different pids.
 * - `cim-unparsable`: the PowerShell CIM reply is not the expected JSON
 *   array of rows.
 * - `peer-row-missing` / `server-row-missing`: the CIM reply has no row for
 *   the peer's pid (it exited) or for this server's pid.
 * - `invalid-pid`: the pid read from the OS is not a positive safe integer;
 *   it never reaches a PowerShell command.
 * - `self`: the owner is this very process (never accepted as a peer).
 * - `owner-unreadable`: the OS user of the peer, or of this server, could
 *   not be read (GetOwner ReturnValue != 0, an empty user, `N/A`, no lsof
 *   uid field).
 * - `owner-mismatch`: the peer runs as another OS user than this server.
 * - `path-unreadable`: the executable path was asked for (strict mode) and
 *   could not be read.
 * - `unsupported-platform`: no lookup exists for this OS.
 * - `output-too-large`: a command printed more than LOOKUP_MAX_OUTPUT_BYTES.
 * - `deadline`: the lookup's total budget (`totalTimeoutMs`) ran out before
 *   it could decide; set by the lookup itself or by the peer-lookup limiter.
 * - `lookup-busy`: the peer-lookup limiter had no free slot within its
 *   wait, so the lookup never ran.
 */
export type PeerLookupCause =
  | 'timeout'
  | 'command-missing'
  | `command-failed:${string}`
  | 'parse-miss'
  | 'endpoint-not-listed'
  | 'endpoint-ambiguous'
  | 'cim-unparsable'
  | 'peer-row-missing'
  | 'server-row-missing'
  | 'invalid-pid'
  | 'self'
  | 'owner-unreadable'
  | 'owner-mismatch'
  | 'path-unreadable'
  | 'unsupported-platform'
  | 'output-too-large'
  | 'deadline'
  | 'lookup-busy';

/** `detail`: counts that help diagnose a refusal in the field (never an
 * address, a name or any other content). */
export type PeerLookupResult =
  { ok: true; peer: PeerProcess } | { ok: false; cause: PeerLookupCause; detail?: string };

/** Injection seams for tests; production uses the real execFile and OS. */
export interface PeerLookupDeps {
  execFile?: (
    file: string,
    args: readonly string[],
    options: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string }>;
  platform?: NodeJS.Platform;
  /** This server's POSIX uid. Default `process.getuid()`. */
  getuid?: () => number | undefined;
  /** Waits between netstat snapshots. Default a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** A monotonic clock in ms, read only when the request carries a total
   * budget. Default `performance.now()`. */
  now?: () => number;
  /** Where the Windows lookup writes its one line when the kernel-table
   * source fails and the netstat + CIM fallback runs. Default
   * `console.error`, the server's log. */
  log?: (line: string) => void;
}

/** What the caller needs beyond identity. */
export interface PeerLookupRequest {
  /** Also read the peer's executable path (the opt-in strict mode). */
  withExecutablePath?: boolean;
  /** The server's own end of the connection (its listening address and
   * port). When given, only connections whose REMOTE end is this endpoint
   * count, so a row for the same local port to anything else (a stale
   * TIME_WAIT, a reused ephemeral port) cannot make the owner ambiguous. */
  serverEndpoint?: Endpoint;
  /** The most this whole lookup may take, every command and wait included.
   * Each command is bounded by what is left of it (never by more than
   * LOOKUP_TIMEOUT_MS); once it is spent the lookup fails with `deadline`.
   * Absent, each command keeps only its own LOOKUP_TIMEOUT_MS bound. */
  totalTimeoutMs?: number;
}

export interface Endpoint {
  host: string;
  port: number;
}

/** Thrown internally so a parse miss travels the same path as an exec error. */
class LookupFailure extends Error {
  constructor(
    readonly reason: PeerLookupCause,
    readonly detail?: string,
  ) {
    super(reason);
  }
}

/** Map a child_process.execFile rejection to a lookup cause. */
export function classifyLookupError(err: unknown): PeerLookupCause {
  if (err instanceof LookupFailure) return err.reason;
  const e = (err ?? {}) as { killed?: boolean; signal?: unknown; code?: unknown };
  if (e.killed === true && e.signal != null) return 'timeout';
  if (e.code === 'ENOENT') return 'command-missing';
  // Node kills the command and rejects with this code past `maxBuffer`.
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output-too-large';
  if (typeof e.code === 'number') return `command-failed:${e.code}`;
  return 'command-failed:unknown';
}

/** A pid that may be interpolated into a command: a positive safe integer. */
export function isValidPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

/** Same lookup as `lookupPeerProcess`, but a failure carries its cause. */
export async function lookupPeerProcessDetailed(
  host: string,
  port: number,
  deps: PeerLookupDeps = {},
  request: PeerLookupRequest = {},
): Promise<PeerLookupResult> {
  const os = deps.platform ?? platform();
  const exec = deps.execFile ?? defaultExecFile;
  const run =
    request.totalTimeoutMs === undefined
      ? exec
      : withTotalBudget(exec, deps.now ?? defaultNow, request.totalTimeoutMs);
  const withPath = request.withExecutablePath === true;
  let result: PeerProcess;
  try {
    if (os === 'darwin' || os === 'linux') {
      const getuid = deps.getuid ?? (() => process.getuid?.());
      result = await lookupUnix(run, host, port, request.serverEndpoint, getuid(), withPath);
    } else if (os === 'win32') {
      const sleep = deps.sleep ?? defaultSleep;
      const log = deps.log ?? defaultLog;
      result = await lookupWindows(run, sleep, log, host, port, request.serverEndpoint, withPath);
    } else {
      return { ok: false, cause: 'unsupported-platform' };
    }
  } catch (err) {
    const cause = classifyLookupError(err);
    return err instanceof LookupFailure && err.detail !== undefined
      ? { ok: false, cause, detail: err.detail }
      : { ok: false, cause };
  }
  return { ok: true, peer: result };
}

type ExecFile = NonNullable<PeerLookupDeps['execFile']>;

const defaultExecFile: ExecFile = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], { ...options, windowsHide: true });
  return { stdout };
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const defaultNow = (): number => performance.now();

const defaultLog = (line: string): void => {
  console.error(line);
};

function run(
  exec: ExecFile,
  file: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string }> {
  const bounds = { timeout: LOOKUP_TIMEOUT_MS, maxBuffer: LOOKUP_MAX_OUTPUT_BYTES };
  return exec(file, args, env === undefined ? bounds : { ...bounds, env });
}

/**
 * Bound every command of one lookup by what is left of `budgetMs`: its
 * timeout is the smaller of its own bound and that remainder, a command
 * with nothing left is not started, and a command killed at the remainder
 * (not at its own bound) ends the lookup with `deadline`. The Windows
 * fallback never catches a `LookupFailure`, so nothing runs after that.
 */
function withTotalBudget(exec: ExecFile, now: () => number, budgetMs: number): ExecFile {
  const deadline = now() + budgetMs;
  const spent = (): LookupFailure =>
    new LookupFailure('deadline', `total budget ${String(budgetMs)} ms`);
  return async (file, args, options) => {
    const left = Math.floor(deadline - now());
    if (!(left > 0)) throw spent();
    const timeout = Math.min(options.timeout, left);
    try {
      return await exec(file, args, { ...options, timeout });
    } catch (err) {
      if (timeout < options.timeout && classifyLookupError(err) === 'timeout') throw spent();
      throw err;
    }
  };
}

/** Refuse a pid that is malformed or is this very process. */
function assertPeerPid(pid: number): void {
  if (!isValidPid(pid)) throw new LookupFailure('invalid-pid');
  if (pid === process.pid) throw new LookupFailure('self');
}

/** Both owners read, non-empty, and equal; otherwise a typed refusal. */
function assertSameOwner(peer: string | number | null, server: string | number | null): void {
  if (peer === null || server === null) throw new LookupFailure('owner-unreadable');
  if (peer !== server) throw new LookupFailure('owner-mismatch');
}

/**
 * macOS / Linux path: `lsof` is the broadest tool available.
 *
 * The `-F pcun` flag asks for a stable, field-tagged output (one field per
 * line, prefixed with the field letter): p=PID, c=command, u=uid, n=NAME
 * (which for TCP sockets is "local->remote"). We need the NAME because
 * `-i @host:port` matches BOTH ends of any socket that touches host:port —
 * and on loopback (peer and server both on 127.0.0.1) that means lsof
 * returns both ends of the same connection. The parser then keeps only
 * entries whose LOCAL side is host:port — the unambiguous peer. The uid must
 * equal this server's `process.getuid()`.
 *
 * The Windows path (`parseNetstatForLocal`) applies the same local-endpoint
 * filter; keep these two branches in sync.
 */
async function lookupUnix(
  exec: ExecFile,
  host: string,
  port: number,
  server: Endpoint | undefined,
  serverUid: number | undefined,
  withPath: boolean,
): Promise<PeerProcess> {
  const { stdout } = await run(exec, 'lsof', [
    '-nP',
    '-F',
    'pcun',
    `-iTCP@${host}:${port}`,
    '-sTCP:ESTABLISHED',
  ]);
  const owner = parseLsofOutput(stdout, host, port, server);
  if (!owner) throw new LookupFailure('parse-miss');
  assertPeerPid(owner.pid);
  assertSameOwner(owner.uid, serverUid ?? null);
  const peer: PeerProcess = { pid: owner.pid, binaryName: owner.binaryName };
  if (!withPath) return peer;
  // The program text (`txt`) of the process: its first entry is the
  // executable itself on macOS and Linux.
  const { stdout: txt } = await run(exec, 'lsof', [
    '-nP',
    '-a',
    '-p',
    String(owner.pid),
    '-d',
    'txt',
    '-F',
    'fn',
  ]);
  const executablePath = parseLsofExecutablePath(txt);
  if (executablePath === null) throw new LookupFailure('path-unreadable');
  return { ...peer, executablePath };
}

/** The unique owner `parseLsofOutput` found; `uid` is null when lsof
 * printed no readable `u` field for it. */
export interface LsofOwner {
  pid: number;
  binaryName: string;
  uid: number | null;
}

/**
 * Parse `lsof -F pcun` output and return the unique process whose LOCAL
 * endpoint equals `host:port`. Returns null on:
 *  - empty output
 *  - no entry matching the local endpoint
 *  - two or more distinct PIDs claiming the same local endpoint (fail closed)
 *  - malformed records (missing pid/command/name)
 *
 * Output shape: every process group starts with `p<pid>`, followed by
 * `c<command>` and `u<uid>` (one each), then one or more `n<local>-><remote>`
 * lines (one per matching socket). Names can contain spaces; lsof escapes
 * them as `\xHH`.
 */
export function parseLsofOutput(
  out: string,
  host: string,
  port: number,
  server?: Endpoint,
): LsofOwner | null {
  const target = `${host}:${port}`;
  const remoteTarget = server === undefined ? null : `${server.host}:${server.port}`;
  const owners = new Map<number, { binaryName: string; uid: number | null }>();
  let curPid: number | null = null;
  let curName: string | null = null;
  let curUid: number | null = null;

  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    const tag = line[0];
    const rest = line.slice(1);

    if (tag === 'p') {
      const n = Number.parseInt(rest, 10);
      curPid = Number.isFinite(n) ? n : null;
      curName = null;
      curUid = null;
      continue;
    }
    if (tag === 'c') {
      curName = decodeLsofString(rest);
      continue;
    }
    if (tag === 'u') {
      curUid = /^\d+$/.test(rest) ? Number(rest) : null;
      continue;
    }
    if (tag === 'n' && curPid !== null && curName !== null) {
      const arrowIdx = rest.indexOf('->');
      if (arrowIdx < 0) continue;
      const local = rest.slice(0, arrowIdx);
      if (local !== target) continue;
      if (remoteTarget !== null && rest.slice(arrowIdx + 2) !== remoteTarget) continue;
      const existing = owners.get(curPid);
      if (existing === undefined) owners.set(curPid, { binaryName: curName, uid: curUid });
      else if (existing.binaryName !== curName) {
        // Same pid reporting two different names within one dump is
        // contradictory — bail rather than guess.
        return null;
      }
    }
  }

  if (owners.size !== 1) return null;
  const [[pid, owner]] = owners.entries();
  return { pid, ...owner };
}

/**
 * Parse `lsof -a -p <pid> -d txt -F fn` output: the first `n` field of a
 * `txt` descriptor, which is the program's own executable. Returns null when
 * there is none or it is not an absolute path.
 *
 * `f` is asked for explicitly: Ubuntu 24.04's lsof prints none for `-F n`. A
 * name with no `f` before it in its process block is still a txt entry, since
 * `-d txt` selected only those.
 */
export function parseLsofExecutablePath(out: string): string | null {
  let fd: string | null = null;
  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === 'p') fd = null;
    else if (tag === 'f') fd = rest;
    else if (tag === 'n' && (fd === 'txt' || fd === null)) {
      const path = decodeLsofString(rest);
      return path.startsWith('/') ? path : null;
    }
  }
  return null;
}

/** lsof escapes spaces and tabs in command names as \xHH. Reverse that. */
export function decodeLsofString(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** What Windows reports about the peer once its owner matched ours. */
interface WindowsIdentity {
  binaryName: string;
  executablePath: string | null;
}

/**
 * Windows path. First the kernel-table source (`windows-tcp-owner.ts`): one
 * PowerShell reads the owner of the peer's endpoint from the kernel TCP
 * table and that process's token user, image name and image path. When that
 * source cannot answer, the netstat + CIM lookup runs instead and one log
 * line names the stage that failed.
 *
 * The fallback only ever replaces a source that could not answer. An answer
 * that refuses (another user, two owners, this very process) stands, so the
 * fallback can never accept a peer the kernel table refused. What the
 * kernel table reads differently from netstat + CIM: it sees rows netstat
 * does not print yet (state 0), and the path it reports is the real file
 * (see `kernelTableLookup`); strict mode matches it against each listed
 * entry as written and as resolved on disk, so an entry through a junction
 * still matches a program started through it.
 */
async function lookupWindows(
  exec: ExecFile,
  sleep: (ms: number) => Promise<void>,
  log: (line: string) => void,
  host: string,
  port: number,
  server: Endpoint | undefined,
  withPath: boolean,
): Promise<PeerProcess> {
  const kernel = await kernelTableLookup(exec, host, port, server, withPath);
  if (kernel.ok) return kernel.peer;
  log(
    `[browser-link] Windows peer lookup: the kernel TCP table source failed at stage ${kernel.stage} (cause: ${kernel.cause}); checking with netstat + CIM instead.`,
  );
  return lookupWindowsNetstat(exec, sleep, host, port, server, withPath);
}

/** Where the kernel-table source stopped without a verdict. */
export type KernelLookupStage =
  | 'powershell'
  | 'interop'
  | 'tcp-table'
  | 'native'
  | 'reply'
  | 'endpoint'
  | 'table-changed'
  | 'process'
  | 'token'
  | 'server-token'
  | 'image-path';

type KernelLookup =
  { ok: true; peer: PeerProcess } | { ok: false; stage: KernelLookupStage; cause: PeerLookupCause };

/**
 * The kernel-table source. Returns `ok: false` (fall back) when it could not
 * read what it needs; throws a `LookupFailure` (a refusal, no fallback) when
 * what it read refuses the peer, or when the lookup's total budget is spent.
 *
 * Rows count like netstat's: the LOCAL end must be `host:port` and, when the
 * server's endpoint is known, the REMOTE end must be it; pid 0 (TIME_WAIT) is
 * no owner; any state counts. IPv6 addresses are normalised the way the
 * socket's own addresses are (`::1` and `::ffff:a.b.c.d` read as IPv4). The
 * owner must be the same single pid in the read before and the read after
 * its process was opened, so a pid reused in between is never taken.
 *
 * Owners are compared by the user SID of the process token, for the peer and
 * for this server alike. The image name is the one CIM reports (the
 * Toolhelp snapshot), so the name rules see the same name as before. The
 * path is `QueryFullProcessImageName`'s: where the running image file is
 * now, with every junction and symbolic link resolved and the case it has on
 * disk (CIM reports the path the process was started with, which can go
 * through a junction, such as nvm's `C:\nvm4w\nodejs`). That path is
 * returned as read and never resolved again on disk, since a junction the
 * peer controls could be retargeted between its start and the check; strict
 * mode resolves only the listed entries (`isAllowedExecutablePath`).
 */
async function kernelTableLookup(
  exec: ExecFile,
  host: string,
  port: number,
  server: Endpoint | undefined,
  withPath: boolean,
): Promise<KernelLookup> {
  const fail = (stage: KernelLookupStage, cause: PeerLookupCause): KernelLookup => ({
    ok: false,
    stage,
    cause,
  });
  let stdout: string;
  try {
    ({ stdout } = await run(
      exec,
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', KERNEL_OWNER_SCRIPT],
      kernelOwnerEnv(port, process.pid),
    ));
  } catch (err) {
    // The total budget is spent: nothing else may run.
    if (err instanceof LookupFailure) throw err;
    return fail('powershell', classifyLookupError(err));
  }
  const reply = parseKernelOwnerReply(stdout);
  if (reply === null) return fail('reply', 'parse-miss');
  if (reply.kind === 'stage') return fail(reply.stage, `command-failed:${reply.stage}`);

  const before = kernelOwnersOf(reply.rows, host, port, server);
  if (before.length === 0) return fail('endpoint', 'endpoint-not-listed');
  if (before.length > 1) throw new LookupFailure('endpoint-ambiguous');
  const pid = before[0];
  assertPeerPid(pid);
  const after = kernelOwnersOf(reply.rowsAfter, host, port, server);
  if (after.length !== 1 || after[0] !== pid) return fail('table-changed', 'endpoint-ambiguous');

  const peer = reply.procs.find((p) => p.pid === pid);
  const self = reply.procs.find((p) => p.pid === process.pid);
  if (peer === undefined || peer.name === null || peer.name.length === 0) {
    return fail('process', 'peer-row-missing');
  }
  if (peer.sid === null || peer.sid.length === 0) return fail('token', 'owner-unreadable');
  if (self === undefined || self.sid === null || self.sid.length === 0) {
    return fail('server-token', 'owner-unreadable');
  }
  assertSameOwner(peer.sid, self.sid);
  const found: PeerProcess = { pid, binaryName: peer.name };
  if (!withPath) return { ok: true, peer: found };
  if (peer.path === null || !win32.isAbsolute(peer.path)) {
    return fail('image-path', 'path-unreadable');
  }
  return { ok: true, peer: { ...found, executablePath: peer.path } };
}

/** The distinct live pids of the kernel rows whose local end is
 * `host:port` (and remote end the server, when known). */
function kernelOwnersOf(
  rows: readonly KernelTcpRow[],
  host: string,
  port: number,
  server: Endpoint | undefined,
): number[] {
  const owners = new Set<number>();
  for (const row of rows) {
    if (row.pid === 0) continue;
    if (row.localPort !== port || normaliseLoopback(row.localAddress) !== host) continue;
    if (
      server !== undefined &&
      (row.remotePort !== server.port || normaliseLoopback(row.remoteAddress) !== server.host)
    ) {
      continue;
    }
    owners.add(row.pid);
  }
  return [...owners];
}

/**
 * Loopback-only addresses can show up as ::ffff:127.0.0.1 (IPv4-mapped IPv6)
 * or ::1 depending on how the kernel exposes the dual stack. Normalise to the
 * IPv4 form lsof / netstat understand.
 */
export function normaliseLoopback(addr: string): string {
  if (addr === '::1' || addr === '::ffff:127.0.0.1') return '127.0.0.1';
  if (addr.startsWith('::ffff:')) return addr.slice('::ffff:'.length);
  return addr;
}

/**
 * The netstat + CIM lookup, now the fallback: `netstat -ano` lists every TCP
 * connection with its owning PID, then one PowerShell CIM call reads the
 * image name, executable path and owner of that PID and of this server, so
 * both owners come from the same method. All primitives ship with Windows;
 * no extra tooling needed.
 *
 * Like the UNIX path, this filters by LOCAL endpoint match — see
 * `parseNetstatForLocal`. Keep the two branches in sync.
 *
 * netstat can lag a fresh connection, so a snapshot with no owner is taken
 * again after `NETSTAT_RETRY_DELAYS_MS`. Only that miss is retried; every
 * check below runs on whatever the last snapshot found.
 */
async function lookupWindowsNetstat(
  exec: ExecFile,
  sleep: (ms: number) => Promise<void>,
  host: string,
  port: number,
  server: Endpoint | undefined,
  withPath: boolean,
): Promise<PeerProcess> {
  const snapshot = async (): Promise<{ netstatOut: string; owners: number[] }> => {
    const { stdout } = await run(exec, 'netstat', ['-ano', '-p', 'TCP']);
    return { netstatOut: stdout, owners: netstatOwnersOf(stdout, host, port, server) };
  };
  let taken = 1;
  let { netstatOut, owners } = await snapshot();
  for (const delay of NETSTAT_RETRY_DELAYS_MS) {
    if (owners.length > 0) break;
    await sleep(delay);
    ({ netstatOut, owners } = await snapshot());
    taken++;
  }
  if (owners.length === 0) {
    const rows = netstatRowsFor(netstatOut, host, port);
    throw new LookupFailure(
      'endpoint-not-listed',
      `${String(taken)} netstat snapshots, ${String(rows)} ${rows === 1 ? 'row' : 'rows'} for the local port in the last`,
    );
  }
  if (owners.length > 1) throw new LookupFailure('endpoint-ambiguous');
  const pid = owners[0];
  assertPeerPid(pid);

  const identity = await windowsIdentity(exec, pid);
  const peer: PeerProcess = { pid, binaryName: identity.binaryName };
  if (!withPath) return peer;
  if (identity.executablePath === null) throw new LookupFailure('path-unreadable');
  return { ...peer, executablePath: identity.executablePath };
}

/**
 * Resolve a Windows PID to its image name and path, and check its owner.
 *
 * Prefers PowerShell's CIM `Win32_Process` + `GetOwner`. `tasklist /V` is
 * kept as a fallback for a missing or locked-down PowerShell: it reports the
 * owner too (`DOMAIN\user`), compared the same way, but no executable path.
 * A blocked PowerShell therefore never skips the owner check. When CIM ran
 * and answered, its answer stands: an unreadable owner is a refusal, not a
 * reason to ask a weaker tool.
 */
async function windowsIdentity(exec: ExecFile, pid: number): Promise<WindowsIdentity> {
  let stdout: string;
  try {
    ({ stdout } = await run(exec, 'powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      buildCimIdentityScript(pid, process.pid),
    ]));
  } catch (err) {
    if (err instanceof LookupFailure) throw err;
    // PowerShell missing, disabled by policy, or timed out — fall back.
    return tasklistIdentity(exec, pid);
  }
  const rows = parseCimIdentity(stdout);
  if (rows === null) throw new LookupFailure('cim-unparsable');
  const peer = rows.find((r) => r.pid === pid);
  const server = rows.find((r) => r.pid === process.pid);
  if (!peer || peer.name.length === 0) throw new LookupFailure('peer-row-missing');
  if (!server) throw new LookupFailure('server-row-missing');
  assertSameOwner(cimOwner(peer), cimOwner(server));
  return { binaryName: peer.name, executablePath: peer.path.length > 0 ? peer.path : null };
}

/** The fallback: two `tasklist /V` calls (peer and server), run together.
 * The fallback's failure is the one reported: it is the last thing tried.
 *
 * tasklist prints in the console's OEM code page and its output is decoded
 * as UTF-8, so a byte sequence that is not valid UTF-8 becomes U+FFFD and
 * two different account names can decode to the same text. An owner holding
 * U+FFFD is unreadable, never compared; without one the decoding lost
 * nothing, so equal text means equal bytes. */
async function tasklistIdentity(exec: ExecFile, pid: number): Promise<WindowsIdentity> {
  const query = (p: number) =>
    run(exec, 'tasklist', ['/V', '/FO', 'CSV', '/NH', '/FI', `PID eq ${p}`]);
  const [peerOut, serverOut] = await Promise.all([query(pid), query(process.pid)]);
  const peer = parseTasklistVerbose(peerOut.stdout);
  const server = parseTasklistVerbose(serverOut.stdout);
  if (!peer || !server) throw new LookupFailure('parse-miss');
  assertSameOwner(losslessOwner(peer.owner), losslessOwner(server.owner));
  return { binaryName: peer.binaryName, executablePath: null };
}

/** What a UTF-8 decoder puts in place of bytes it could not read. */
const REPLACEMENT_CHARACTER = '�';

/** The owner as read, or null when its decoding lost bytes. */
function losslessOwner(owner: string | null): string | null {
  return owner === null || owner.includes(REPLACEMENT_CHARACTER) ? null : owner;
}

/**
 * The PowerShell script that reads, for the peer and for this server, the
 * image name, executable path and `GetOwner` result, printed as one JSON
 * array. Both pids are checked with `isValidPid` before they are placed in
 * the `-Filter` string; the script uses no double quotes, so the argument
 * array passes it to PowerShell unchanged.
 */
export function buildCimIdentityScript(peerPid: number, serverPid: number): string {
  if (!isValidPid(peerPid) || !isValidPid(serverPid)) throw new LookupFailure('invalid-pid');
  return [
    "$ErrorActionPreference = 'Stop'",
    // UTF-8 so a non-ASCII user name or path survives the pipe; best effort.
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
    `$rows = @(Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${peerPid} OR ProcessId = ${serverPid}' | ForEach-Object { $o = $null; try { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner } catch { }; $rv = -1; if ($o) { $rv = [int]$o.ReturnValue }; [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; path = [string]$_.ExecutablePath; rv = $rv; domain = [string]$o.Domain; user = [string]$o.User } })`,
    'ConvertTo-Json -Compress -InputObject $rows',
  ].join('; ');
}

/** One row of `buildCimIdentityScript`'s output. `rv` is GetOwner's
 * ReturnValue (0 = success), -1 when GetOwner itself threw. */
export interface CimProcess {
  pid: number;
  name: string;
  path: string;
  rv: number;
  domain: string;
  user: string;
}

/** Parse the JSON array `buildCimIdentityScript` prints; null when the
 * output is not exactly that shape. */
export function parseCimIdentity(out: string): CimProcess[] | null {
  let parsed: unknown;
  try {
    // trim() also drops the BOM a UTF-8 console encoding may print first.
    parsed = JSON.parse(out.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: CimProcess[] = [];
  for (const item of parsed as unknown[]) {
    if (!isCimProcess(item)) return null;
    rows.push({
      pid: item.pid,
      name: item.name,
      path: item.path,
      rv: item.rv,
      domain: item.domain,
      user: item.user,
    });
  }
  return rows;
}

function isCimProcess(item: unknown): item is CimProcess {
  if (typeof item !== 'object' || item === null) return false;
  const r = item as Record<string, unknown>;
  return (
    typeof r.pid === 'number' &&
    typeof r.rv === 'number' &&
    typeof r.name === 'string' &&
    typeof r.path === 'string' &&
    typeof r.domain === 'string' &&
    typeof r.user === 'string'
  );
}

/** `DOMAIN\user` from a GetOwner row; null unless ReturnValue is 0 and both
 * parts are non-empty. */
function cimOwner(row: CimProcess): string | null {
  if (row.rv !== 0 || row.domain.length === 0 || row.user.length === 0) return null;
  return `${row.domain}\\${row.user}`;
}

/**
 * Return the single PID whose LOCAL endpoint is `host:port` in `netstat -ano`
 * output (and, when `server` is given, whose FOREIGN endpoint is the
 * server); null when none, or when two different PIDs list that endpoint.
 */
export function parseNetstatForLocal(
  out: string,
  host: string,
  port: number,
  server?: Endpoint,
): number | null {
  const owners = netstatOwnersOf(out, host, port, server);
  return owners.length === 1 ? owners[0] : null;
}

/**
 * The distinct live PIDs `netstat -ano` lists with `host:port` as LOCAL end.
 *
 * PID 0 is never an owner: netstat lists TIME_WAIT connections, which no
 * process owns any more, under PID 0, and after heavy loopback traffic a
 * stale one can share the peer's local endpoint. The State column is not
 * used because netstat prints it localized on non-English Windows.
 */
/** How many netstat rows have `host:port` as their local end, any state and
 * any pid: a count for the refusal line, nothing more. */
function netstatRowsFor(out: string, host: string, port: number): number {
  const target = `${host}:${port}`;
  return out.split(/\r?\n/).filter((line) => line.trim().split(/\s+/)[1] === target).length;
}

function netstatOwnersOf(out: string, host: string, port: number, server?: Endpoint): number[] {
  const target = `${host}:${port}`;
  const foreign = server === undefined ? null : `${server.host}:${server.port}`;
  const owners = new Set<number>();
  // Windows sometimes lists the peer's socket only as bound (LISTENING,
  // foreign port 0) while the server's own row shows the connection from
  // that endpoint. Those rows count only when no row to the server exists,
  // and the one-owner rule still applies to them.
  const boundOnly = new Set<number>();
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(target)) continue;
    // Format:  Proto  LocalAddress  ForeignAddress  State  PID
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    if (fields[1] !== target) continue;
    const pid = Number.parseInt(fields[4] ?? '', 10);
    if (!Number.isFinite(pid) || pid === 0) continue;
    if (foreign === null || fields[2] === foreign) owners.add(pid);
    else if (fields[2]?.endsWith(':0')) boundOnly.add(pid);
  }
  return owners.size > 0 ? [...owners] : [...boundOnly];
}

/**
 * Parse `tasklist /V /FO CSV /NH` output for one PID: the image name and the
 * `User Name` column. The owner is null unless it has the `DOMAIN\user`
 * shape, so `N/A` (or its localised form) never compares equal to anything.
 * Returns null when no process row is present.
 */
export function parseTasklistVerbose(
  out: string,
): { binaryName: string; owner: string | null } | null {
  for (const line of out.split(/\r?\n/)) {
    const fields = parseCsvLine(line.trim());
    if (fields === null || fields.length < 7) continue;
    const binaryName = fields[0] ?? '';
    if (binaryName.length === 0) continue;
    const user = fields[6] ?? '';
    return { binaryName, owner: /^[^\\]+\\[^\\]+$/.test(user) ? user : null };
  }
  return null;
}

/** Split one CSV line whose every field is double-quoted (`""` escapes a
 * quote). Null when the line is not of that shape. */
function parseCsvLine(line: string): string[] | null {
  if (!line.startsWith('"')) return null;
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '"') return null;
    let value = '';
    i += 1;
    for (;;) {
      if (i >= line.length) return null;
      if (line[i] === '"') {
        if (line[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      value += line[i];
      i += 1;
    }
    fields.push(value);
    if (i === line.length) break;
    if (line[i] !== ',') return null;
    i += 1;
  }
  return fields;
}
