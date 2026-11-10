import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// Bounds each lookup command. A cold PowerShell start plus the CIM owner
// query was measured at about 1 s on Windows 11; the slow `tasklist /V`
// fallback stays inside it on normal machines. A hung command fails closed.
const LOOKUP_TIMEOUT_MS = 5000;

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
  | 'unsupported-platform';

export type PeerLookupResult =
  { ok: true; peer: PeerProcess } | { ok: false; cause: PeerLookupCause };

/** Injection seams for tests; production uses the real execFile and OS. */
export interface PeerLookupDeps {
  execFile?: (
    file: string,
    args: readonly string[],
    options: { timeout: number },
  ) => Promise<{ stdout: string }>;
  platform?: NodeJS.Platform;
  /** This server's POSIX uid. Default `process.getuid()`. */
  getuid?: () => number | undefined;
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
}

export interface Endpoint {
  host: string;
  port: number;
}

/** Thrown internally so a parse miss travels the same path as an exec error. */
class LookupFailure extends Error {
  constructor(readonly reason: PeerLookupCause) {
    super(reason);
  }
}

/** Map a child_process.execFile rejection to a lookup cause. */
export function classifyLookupError(err: unknown): PeerLookupCause {
  if (err instanceof LookupFailure) return err.reason;
  const e = (err ?? {}) as { killed?: boolean; signal?: unknown; code?: unknown };
  if (e.killed === true && e.signal != null) return 'timeout';
  if (e.code === 'ENOENT') return 'command-missing';
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
  const run = deps.execFile ?? defaultExecFile;
  const withPath = request.withExecutablePath === true;
  let result: PeerProcess;
  try {
    if (os === 'darwin' || os === 'linux') {
      const getuid = deps.getuid ?? (() => process.getuid?.());
      result = await lookupUnix(run, host, port, request.serverEndpoint, getuid(), withPath);
    } else if (os === 'win32') {
      result = await lookupWindows(run, host, port, request.serverEndpoint, withPath);
    } else {
      return { ok: false, cause: 'unsupported-platform' };
    }
  } catch (err) {
    return { ok: false, cause: classifyLookupError(err) };
  }
  return { ok: true, peer: result };
}

type ExecFile = NonNullable<PeerLookupDeps['execFile']>;

const defaultExecFile: ExecFile = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], { ...options, windowsHide: true });
  return { stdout };
};

function run(exec: ExecFile, file: string, args: readonly string[]): Promise<{ stdout: string }> {
  return exec(file, args, { timeout: LOOKUP_TIMEOUT_MS });
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
    'n',
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
 * Parse `lsof -a -p <pid> -d txt -F n` output: the first `n` field of a
 * `txt` descriptor, which is the program's own executable. Returns null when
 * there is none or it is not an absolute path.
 */
export function parseLsofExecutablePath(out: string): string | null {
  let fd: string | null = null;
  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === 'f') fd = rest;
    else if (tag === 'n' && fd === 'txt') {
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
 * Windows path: `netstat -ano` lists every TCP connection with its owning
 * PID, then one PowerShell CIM call reads the image name, executable path
 * and owner of that PID and of this server, so both owners come from the
 * same method. All primitives ship with Windows; no extra tooling needed.
 *
 * Like the UNIX path, this filters by LOCAL endpoint match — see
 * `parseNetstatForLocal`. Keep the two branches in sync.
 */
async function lookupWindows(
  exec: ExecFile,
  host: string,
  port: number,
  server: Endpoint | undefined,
  withPath: boolean,
): Promise<PeerProcess> {
  const { stdout: netstatOut } = await run(exec, 'netstat', ['-ano', '-p', 'TCP']);
  const owners = netstatOwnersOf(netstatOut, host, port, server);
  if (owners.length === 0) throw new LookupFailure('endpoint-not-listed');
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
 * The fallback's failure is the one reported: it is the last thing tried. */
async function tasklistIdentity(exec: ExecFile, pid: number): Promise<WindowsIdentity> {
  const query = (p: number) =>
    run(exec, 'tasklist', ['/V', '/FO', 'CSV', '/NH', '/FI', `PID eq ${p}`]);
  const [peerOut, serverOut] = await Promise.all([query(pid), query(process.pid)]);
  const peer = parseTasklistVerbose(peerOut.stdout);
  const server = parseTasklistVerbose(serverOut.stdout);
  if (!peer || !server) throw new LookupFailure('parse-miss');
  assertSameOwner(peer.owner, server.owner);
  return { binaryName: peer.binaryName, executablePath: null };
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
function netstatOwnersOf(out: string, host: string, port: number, server?: Endpoint): number[] {
  const target = `${host}:${port}`;
  const foreign = server === undefined ? null : `${server.host}:${server.port}`;
  const owners = new Set<number>();
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(target)) continue;
    // Format:  Proto  LocalAddress  ForeignAddress  State  PID
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    if (fields[1] !== target) continue;
    if (foreign !== null && fields[2] !== foreign) continue;
    const pid = Number.parseInt(fields[4] ?? '', 10);
    if (Number.isFinite(pid) && pid !== 0) owners.add(pid);
  }
  return [...owners];
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
