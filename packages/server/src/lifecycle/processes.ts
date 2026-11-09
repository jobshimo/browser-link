import { execFile, execFileSync } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Process enumeration for the lifecycle features: `browser-link stop`
 * (kill every live bridge, not only the port owner), `doctor` (list them)
 * and the primary election (when did the port owner start?).
 *
 * Every OS call goes through an injectable `ExecFileLike`, the same
 * dependency-injection pattern `auth/silent-debugger.ts` uses, but
 * synchronous: `runFreePort` is synchronous and consumed as such by the CLI,
 * the TUI and `self-update`. Nothing in this module throws: a failed or
 * unparseable listing degrades to "no processes" / `null`.
 *
 * Windows uses `Get-CimInstance Win32_Process` (never `wmic`: deprecated and
 * absent on newer Windows 11 installs). Unix uses BSD-style `ps -axo`,
 * accepted by both macOS and procps.
 */

/** `execFileSync`-shaped primitive: argv array, no shell, stdout as text. */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => string;

/** Asynchronous `ExecFileLike`: same argv and timeout, stdout resolved. Used
 * where the listing runs alongside other probes (`doctor`), so the slow WMI
 * scan does not block the event loop. */
export type ExecFileAsyncLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<string>;

/** One row of the OS process table. `startedAt` is epoch milliseconds, or
 * `null` when the OS did not report a usable start time. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  startedAt: number | null;
  command: string;
}

/** WMI cold starts are slow: same budget `silent-debugger.ts` documents. */
const LIST_TIMEOUT_MS = 5000;

export const defaultExecFile: ExecFileLike = (file, args, options) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: options.timeout,
    // `ps` prints lstart in the C locale only when told so.
    env: { ...process.env, LC_ALL: 'C' },
  });

export const defaultExecFileAsync: ExecFileAsyncLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: options.timeout,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (err, stdout) => {
        if (err) reject(new Error(err.message));
        else resolve(stdout);
      },
    );
  });

/**
 * Parse a process start time in any of the forms the OS tools print:
 * PowerShell 5.1's JSON `/Date(ms)/`, ISO 8601 (PowerShell 7 JSON,
 * `ToString('o')`), a WMI datetime `yyyyMMddHHmmss.ffffff±UUU` (offset in
 * minutes) and `ps`'s `lstart` (`Mon Nov  9 02:17:44 2026`, local time).
 */
export function parseProcessTime(raw: string): number | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  const msDate = /^\/Date\((-?\d+)\)\/$/.exec(text);
  if (msDate) return Number(msDate[1]);
  const wmi = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})\d*([+-])(\d{3})$/.exec(text);
  if (wmi) {
    const [, y, mo, d, h, mi, s, ms, sign, off] = wmi;
    const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms);
    const offsetMs = Number(off) * 60_000 * (sign === '-' ? -1 : 1);
    return utc - offsetMs;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

interface WindowsProcessRow {
  ProcessId?: unknown;
  ParentProcessId?: unknown;
  CreationDate?: unknown;
  CommandLine?: unknown;
}

/** Parse `Get-CimInstance … | ConvertTo-Json -Compress`. One process comes
 * out as a bare object, several as an array; both are accepted. */
export function parseWindowsProcessList(stdout: string): ProcessEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  const rows = (Array.isArray(data) ? data : [data]) as unknown[];
  const out: ProcessEntry[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const { ProcessId, ParentProcessId, CreationDate, CommandLine } = row as WindowsProcessRow;
    const pid = Number(ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const ppid = Number(ParentProcessId);
    out.push({
      pid,
      ppid: Number.isInteger(ppid) ? ppid : 0,
      startedAt: typeof CreationDate === 'string' ? parseProcessTime(CreationDate) : null,
      command: typeof CommandLine === 'string' ? CommandLine.trim() : '',
    });
  }
  return out;
}

const UNIX_ROW =
  /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/** Parse `ps -axo pid=,ppid=,lstart=,command=` (C locale). */
export function parseUnixProcessList(stdout: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = UNIX_ROW.exec(line);
    if (!m) continue;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      startedAt: parseProcessTime(m[3]),
      command: m[4].trim(),
    });
  }
  return out;
}

const WINDOWS_LIST_SCRIPT =
  'Get-CimInstance Win32_Process | ' +
  'Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine | ' +
  'ConvertTo-Json -Compress';

function powershell(script: string): [string, string[]] {
  return ['powershell', ['-NoProfile', '-NonInteractive', '-Command', script]];
}

/** The OS command that lists the whole process table, and its parser. */
function processListCommand(os: NodeJS.Platform): {
  file: string;
  args: string[];
  parse: (stdout: string) => ProcessEntry[];
} {
  if (os === 'win32') {
    const [file, args] = powershell(WINDOWS_LIST_SCRIPT);
    return { file, args, parse: parseWindowsProcessList };
  }
  return { file: 'ps', args: ['-axo', 'pid=,ppid=,lstart=,command='], parse: parseUnixProcessList };
}

/** The whole process table, or `[]` when it cannot be read. */
export function listProcesses(
  os: NodeJS.Platform = platform(),
  exec: ExecFileLike = defaultExecFile,
): ProcessEntry[] {
  try {
    const { file, args, parse } = processListCommand(os);
    return parse(exec(file, args, { timeout: LIST_TIMEOUT_MS }));
  } catch {
    return [];
  }
}

/** `listProcesses` without blocking the event loop. Never rejects. */
export async function listProcessesAsync(
  os: NodeJS.Platform = platform(),
  exec: ExecFileAsyncLike = defaultExecFileAsync,
): Promise<ProcessEntry[]> {
  try {
    const { file, args, parse } = processListCommand(os);
    return parse(await exec(file, args, { timeout: LIST_TIMEOUT_MS }));
  } catch {
    return [];
  }
}

/** Start time of one process (epoch ms), or `null` when unknown. */
export function readProcessStartTime(
  pid: number,
  opts: { os?: NodeJS.Platform; exec?: ExecFileLike } = {},
): number | null {
  const os = opts.os ?? platform();
  const exec = opts.exec ?? defaultExecFile;
  try {
    if (os === 'win32') {
      const [file, args] = powershell(
        `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | ` +
          `Select-Object -ExpandProperty CreationDate | ` +
          `ForEach-Object { $_.ToUniversalTime().ToString('o') }`,
      );
      return parseProcessTime(exec(file, args, { timeout: LIST_TIMEOUT_MS }));
    }
    return parseProcessTime(
      exec('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: LIST_TIMEOUT_MS }),
    );
  } catch {
    return null;
  }
}

/** Split a command line into arguments. Double quotes group (Windows
 * command lines quote paths with spaces); backslashes stay literal. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let hasToken = false;
  for (const ch of command) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (hasToken) tokens.push(current);
      current = '';
      hasToken = false;
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

function normalise(token: string): string {
  return token.replace(/\\+/g, '/').toLowerCase();
}

function basename(token: string): string {
  const n = normalise(token);
  return n.slice(n.lastIndexOf('/') + 1);
}

/** Runtimes a browser-link process runs under. */
const RUNTIMES = new Set(['node', 'node.exe', 'nodejs', 'bun', 'bun.exe']);
/** npm's own entry scripts: the package spec is a later argument. */
const NPM_ENTRIES = new Set(['npx-cli.js', 'npm-cli.js']);

function isBrowserLinkEntry(token: string): boolean {
  const n = normalise(token);
  if (n.includes('@jobshimo/browser-link')) return true;
  if (n.endsWith('browser-link/dist/cli.js')) return true;
  // The global bin shim (a symlink on Unix): `node /usr/local/bin/browser-link`.
  const base = basename(token);
  return n.includes('/') && (base === 'browser-link' || base === 'browser-link.js');
}

/**
 * Whether a command line runs this package, and with which subcommand
 * (`null` = none, i.e. the MCP server or the TUI). Only the script argument
 * counts (the first non-flag argument after the runtime, or the package
 * spec after npm's `npx-cli.js`), so a process that merely mentions a
 * browser-link path as an option value is never matched.
 */
export function matchBrowserLinkCommand(command: string): { subcommand: string | null } | null {
  const tokens = tokenize(command);
  if (tokens.length < 2 || !RUNTIMES.has(basename(tokens[0]))) return null;
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) i += 1;
  if (i >= tokens.length) return null;
  if (NPM_ENTRIES.has(basename(tokens[i]))) {
    i += 1;
    while (i < tokens.length && (tokens[i].startsWith('-') || tokens[i] === 'exec')) i += 1;
    if (i >= tokens.length) return null;
  }
  if (!isBrowserLinkEntry(tokens[i])) return null;
  return { subcommand: tokens[i + 1] ?? null };
}

/** Subcommands that run the bridge (see `cli.ts`'s dispatch switch: only a
 * bare invocation and `start` call `runServer`). Every other subcommand
 * (`stop`, `doctor`, `version`, `help`, `about`, `config`, `map`,
 * `instructions`, `activity`, `self-update`, …) is a short-lived command
 * that `stop` must never kill. */
function isBridgeSubcommand(subcommand: string | null): boolean {
  return subcommand === null || subcommand === 'start';
}

/** `selfPid` and every ancestor reachable through `ppid` in `list`. */
export function selfAndAncestors(list: readonly ProcessEntry[], selfPid: number): Set<number> {
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const out = new Set<number>();
  let pid: number | undefined = selfPid;
  while (pid !== undefined && pid > 0 && !out.has(pid)) {
    out.add(pid);
    pid = byPid.get(pid)?.ppid;
  }
  return out;
}

/** Live browser-link bridges in `list`, excluding `selfPid`, its ancestor
 * chain (the shell or client that launched it) and non-bridge commands. */
export function findBridgeProcesses(
  list: readonly ProcessEntry[],
  selfPid: number,
): ProcessEntry[] {
  const excluded = selfAndAncestors(list, selfPid);
  return list.filter((p) => {
    if (excluded.has(p.pid)) return false;
    const match = matchBrowserLinkCommand(p.command);
    return match !== null && isBridgeSubcommand(match.subcommand);
  });
}

export function listBridgeProcesses(
  opts: { os?: NodeJS.Platform; exec?: ExecFileLike; selfPid?: number } = {},
): ProcessEntry[] {
  return findBridgeProcesses(listProcesses(opts.os, opts.exec), opts.selfPid ?? process.pid);
}

/** `listBridgeProcesses` without blocking the event loop, so `doctor` runs
 * it concurrently with its other probes. Never rejects. */
export async function listBridgeProcessesAsync(
  opts: { os?: NodeJS.Platform; exec?: ExecFileAsyncLike; selfPid?: number } = {},
): Promise<ProcessEntry[]> {
  return findBridgeProcesses(
    await listProcessesAsync(opts.os, opts.exec),
    opts.selfPid ?? process.pid,
  );
}

/** Short, display-only form: runtime name, `browser-link`, then arguments. */
export function shortCommand(command: string, max = 80): string {
  const tokens = tokenize(command);
  if (tokens.length === 0) return '';
  const parts = tokens.map((t, i) => {
    if (i === 0) return basename(t).replace(/\.exe$/, '');
    return isBrowserLinkEntry(t) ? 'browser-link' : t;
  });
  const text = parts.join(' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
