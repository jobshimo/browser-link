import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { getAllowedBrowsers } from './allowlist.js';

const execAsync = promisify(exec);

/** Shape of the exec primitive this module depends on — the slice of
 * `child_process.exec`'s promisified signature actually used here.
 * Injectable so tests can simulate a timeout, a spawn error, or canned
 * stdout without shelling out to a real PowerShell/ps process. Every
 * production call path defaults to the real `execAsync`. */
export type ExecLike = (
  command: string,
  options: { timeout: number },
) => Promise<{ stdout: string }>;

// A diagnostic probe, not a security check — but raised from the original
// 3000ms to the 5000ms budget process-identity.ts's LOOKUP_TIMEOUT_MS
// documents: WMI-backed `Get-CimInstance` is a slow cold start, and
// process-identity.ts's imageNameForPid comment records tasklist-class
// tools observed at ~3s on loaded Windows machines. 3000ms was tight enough
// to time out routinely on exactly the machines this probe most needs to
// work on, silently degrading every `browser-link doctor` run to "could not
// determine".
//
// Unlike process-identity.ts, there is no like-for-like fallback to reach
// for here: this probe needs the FULL command line to find the
// `--silent-debugger-extension-api` flag, and neither `Get-Process` nor
// `tasklist` expose command lines at all — only image names. `wmic process
// get ProcessId,CommandLine` was evaluated as a best-effort second attempt,
// but it queries the same underlying WMI subsystem `Get-CimInstance`
// already uses (a CIM timeout usually means WMI itself is slow, not the
// tool fronting it), and wmic is deprecated and absent on newer Windows 11
// installs. Adding a second deprecated tool for a codepath that already
// degrades gracefully to `{ detected: null }` — a diagnostic-only probe,
// not an auth gate — was judged not worth the extra branching.
const DETECT_TIMEOUT_MS = 5000;

/** The flag documented in the README FAQ. Launching Chrome with it
 * suppresses the "started debugging this browser" infobar for EVERY
 * extension that uses chrome.debugger, not just browser-link. */
export const SILENT_DEBUGGER_FLAG = '--silent-debugger-extension-api';

/** Loose, case-insensitive substring match against a process command line —
 * good enough to recognize "is this line a Chromium-family browser" without
 * needing an exact image-name match. This is informational only; a false
 * positive/negative here never affects the auth allowlist in allowlist.ts. */
const BROWSER_HINT = /chrome|chromium|msedge|edge|brave|vivaldi/i;

export interface SilentDebuggerDetection {
  /**
   * `true`  — at least one running Chromium-family process carries the flag.
   * `false` — Chromium-family processes are running, none carry the flag.
   * `null`  — could not tell (no browser running, command unavailable,
   *           timed out, or unsupported OS). Doctor degrades to a neutral
   *           informational line rather than an error in every null case.
   */
  detected: boolean | null;
}

/**
 * Best-effort detection of whether a running Chrome/Chromium process was
 * launched with `--silent-debugger-extension-api`. Never throws — any
 * failure (missing tool, permission denied, timeout, unsupported OS)
 * degrades to `{ detected: null }` so `browser-link doctor` always has
 * something graceful to print.
 *
 * `execFn` is test-only dependency injection (defaults to the real
 * `execAsync` on every production call path, including every existing
 * zero-arg call site) — lets tests simulate a timeout or a spawn error
 * without shelling out to a real process.
 */
export async function detectSilentDebuggerFlag(
  os: NodeJS.Platform = platform(),
  execFn: ExecLike = execAsync,
): Promise<SilentDebuggerDetection> {
  try {
    if (os === 'win32') return await detectWindows(execFn);
    if (os === 'darwin' || os === 'linux') return await detectUnix(execFn);
    return { detected: null };
  } catch {
    return { detected: null };
  }
}

/**
 * Windows: `Get-CimInstance Win32_Process` filtered to known Chromium-family
 * image names, projected down to just `CommandLine` — every launch flag a
 * running instance was started with, including ours if present.
 */
async function detectWindows(execFn: ExecLike): Promise<SilentDebuggerDetection> {
  const names = getAllowedBrowsers('win32')
    .map((n) => `'${n}'`)
    .join(',');
  const psScript =
    `Get-CimInstance Win32_Process | ` +
    `Where-Object { $_.Name -in @(${names}) } | ` +
    `Select-Object -ExpandProperty CommandLine`;
  const { stdout } = await execFn(`powershell -NoProfile -NonInteractive -Command "${psScript}"`, {
    timeout: DETECT_TIMEOUT_MS,
  });
  return parseCommandLines(stdout);
}

/**
 * macOS / Linux: a plain `ps` scan. `-axo command=` lists every process's
 * full command line (BSD-style flags, accepted by both macOS's ps and
 * Linux's procps ps) with no header, one per line.
 */
async function detectUnix(execFn: ExecLike): Promise<SilentDebuggerDetection> {
  const { stdout } = await execFn('ps -axo command=', { timeout: DETECT_TIMEOUT_MS });
  return parseCommandLines(stdout);
}

/**
 * Shared parser: scan raw process-listing output for Chromium-family lines,
 * then check whether any of them carry the flag. Exported so the matching
 * logic is unit-tested without spawning a real process or a real Chrome.
 */
export function parseCommandLines(out: string): SilentDebuggerDetection {
  const browserLines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && BROWSER_HINT.test(l));
  if (browserLines.length === 0) return { detected: null };
  return { detected: browserLines.some((l) => l.includes(SILENT_DEBUGGER_FLAG)) };
}
