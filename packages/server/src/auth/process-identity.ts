import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const LOOKUP_TIMEOUT_MS = 1500;

export interface PeerProcess {
  pid: number;
  binaryName: string;
}

/**
 * Identify which OS process owns the LOCAL end of a TCP connection at
 * `host:port`. Returns null when the lookup cannot resolve a single owner
 * (no result, ambiguous result, command not available, timeout).
 *
 * The caller decides how to treat null: this module's only job is to ask the
 * kernel honestly. Concretely the server treats null as "reject", so users
 * on systems without lsof / netstat fail closed.
 *
 * Defense in depth: even if the OS lookup somehow points at our own process,
 * we return null. The auth path must never identify the server as its own
 * peer — that would short-circuit the allowlist check.
 */
export async function lookupPeerProcess(host: string, port: number): Promise<PeerProcess | null> {
  const os = platform();
  let result: PeerProcess | null;
  try {
    if (os === 'darwin' || os === 'linux') {
      result = await lookupUnix(host, port);
    } else if (os === 'win32') {
      result = await lookupWindows(host, port);
    } else {
      return null;
    }
  } catch {
    return null;
  }
  if (result && result.pid === process.pid) return null;
  return result;
}

/**
 * macOS / Linux path: `lsof` is the broadest tool available.
 *
 * The `-F pcn` flag asks for a stable, field-tagged output (one field per
 * line, prefixed with the field letter): p=PID, c=command, n=NAME (which for
 * TCP sockets is "local->remote"). We need the NAME because `-i @host:port`
 * matches BOTH ends of any socket that touches host:port — and on loopback
 * (peer and server both on 127.0.0.1) that means lsof returns both ends of
 * the same connection. The parser then keeps only entries whose LOCAL side
 * is host:port — the unambiguous peer.
 *
 * The Windows path (`parseNetstatForLocal`) applies the same local-endpoint
 * filter; keep these two branches in sync.
 */
async function lookupUnix(host: string, port: number): Promise<PeerProcess | null> {
  const cmd = `lsof -nP -F pcn -iTCP@${host}:${port} -sTCP:ESTABLISHED`;
  const { stdout } = await execAsync(cmd, { timeout: LOOKUP_TIMEOUT_MS });
  return parseLsofOutput(stdout, host, port);
}

/**
 * Parse `lsof -F pcn` output and return the unique process whose LOCAL
 * endpoint equals `host:port`. Returns null on:
 *  - empty output
 *  - no entry matching the local endpoint
 *  - two or more distinct PIDs claiming the same local endpoint (fail closed)
 *  - malformed records (missing pid/command/name)
 *
 * Output shape: every process group starts with `p<pid>`, followed by
 * `c<command>` (one), then one or more `n<local>-><remote>` lines (one per
 * matching socket). Names can contain spaces; lsof escapes them as `\xHH`.
 */
export function parseLsofOutput(out: string, host: string, port: number): PeerProcess | null {
  const target = `${host}:${port}`;
  const owners = new Map<number, string>();
  let curPid: number | null = null;
  let curName: string | null = null;

  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    const tag = line[0];
    const rest = line.slice(1);

    if (tag === 'p') {
      const n = Number.parseInt(rest, 10);
      curPid = Number.isFinite(n) ? n : null;
      curName = null;
      continue;
    }
    if (tag === 'c') {
      curName = decodeLsofString(rest);
      continue;
    }
    if (tag === 'n' && curPid !== null && curName !== null) {
      const arrowIdx = rest.indexOf('->');
      if (arrowIdx < 0) continue;
      const local = rest.slice(0, arrowIdx);
      if (local !== target) continue;
      const existing = owners.get(curPid);
      if (existing === undefined) owners.set(curPid, curName);
      else if (existing !== curName) {
        // Same pid reporting two different names within one dump is
        // contradictory — bail rather than guess.
        return null;
      }
    }
  }

  if (owners.size !== 1) return null;
  const [[pid, binaryName]] = owners.entries();
  return { pid, binaryName };
}

/** lsof escapes spaces and tabs in command names as \xHH. Reverse that. */
export function decodeLsofString(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * Windows path: `netstat -ano` lists every TCP connection with its owning
 * PID. We then ask `tasklist` for the image name of that PID. Both ship by
 * default with Windows; no extra tooling needed.
 *
 * Like the UNIX path, this filters by LOCAL endpoint match — see
 * `parseNetstatForLocal`. Keep the two branches in sync.
 */
async function lookupWindows(host: string, port: number): Promise<PeerProcess | null> {
  const { stdout: netstatOut } = await execAsync('netstat -ano -p TCP', {
    timeout: LOOKUP_TIMEOUT_MS,
  });
  const pid = parseNetstatForLocal(netstatOut, host, port);
  if (pid === null) return null;

  const { stdout: tasklistOut } = await execAsync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
    timeout: LOOKUP_TIMEOUT_MS,
  });
  const binaryName = parseTasklistImage(tasklistOut);
  return binaryName ? { pid, binaryName } : null;
}

export function parseNetstatForLocal(out: string, host: string, port: number): number | null {
  const target = `${host}:${port}`;
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(target)) continue;
    // Format:  Proto  LocalAddress  ForeignAddress  State  PID
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    if (fields[1] !== target) continue;
    const pid = Number.parseInt(fields[4] ?? '', 10);
    if (Number.isFinite(pid)) return pid;
  }
  return null;
}

export function parseTasklistImage(out: string): string | null {
  // CSV with no header:  "image.exe","PID","Session Name","Session#","Mem Usage"
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^"([^"]+)"/);
    if (match?.[1]) return match[1];
  }
  return null;
}
