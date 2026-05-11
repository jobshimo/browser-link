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
 * Identify which OS process owns the local end of a loopback TCP connection
 * at `host:port`. Returns null when the lookup cannot resolve a single owner
 * (no result, ambiguous result, command not available, timeout).
 *
 * The caller decides how to treat null: this module's only job is to ask the
 * kernel honestly. Concretely the server treats null as "reject", so users
 * on systems without lsof / netstat fail closed.
 */
export async function lookupPeerProcess(host: string, port: number): Promise<PeerProcess | null> {
  const os = platform();
  try {
    if (os === 'darwin' || os === 'linux') {
      return await lookupUnix(host, port);
    }
    if (os === 'win32') {
      return await lookupWindows(host, port);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * macOS / Linux path: `lsof` is the broadest tool available. The -F flag
 * gives us a stable, field-tagged output (one field per line, prefixed with
 * the field letter) that survives binary names containing spaces — common
 * on macOS ("Google Chrome Helper").
 */
async function lookupUnix(host: string, port: number): Promise<PeerProcess | null> {
  const cmd = `lsof -nP -F pc -iTCP@${host}:${port} -sTCP:ESTABLISHED`;
  const { stdout } = await execAsync(cmd, { timeout: LOOKUP_TIMEOUT_MS });
  return parseLsofOutput(stdout);
}

export function parseLsofOutput(out: string): PeerProcess | null {
  let pid: number | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number.parseInt(line.slice(1), 10);
      pid = Number.isFinite(n) ? n : null;
      continue;
    }
    if (line.startsWith('c') && pid !== null) {
      return { pid, binaryName: decodeLsofString(line.slice(1)) };
    }
  }
  return null;
}

/** lsof escapes spaces and tabs in command names as \xHH. Reverse that. */
export function decodeLsofString(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * Windows path: `netstat -ano` lists every TCP connection with its owning
 * PID. We then ask `tasklist` for the image name of that PID. Both ship by
 * default with Windows; no extra tooling needed.
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
