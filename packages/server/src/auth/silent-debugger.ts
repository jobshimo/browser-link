import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { getAllowedBrowsers } from './allowlist.js';

const execAsync = promisify(exec);

// A diagnostic probe, not a security check — bounded generously enough to
// tolerate a loaded machine but short enough that `browser-link doctor`
// never feels like it hung. Mirrors the reasoning in process-identity.ts's
// LOOKUP_TIMEOUT_MS, just tighter since nothing here gates the auth path.
const DETECT_TIMEOUT_MS = 3000;

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
 */
export async function detectSilentDebuggerFlag(
  os: NodeJS.Platform = platform(),
): Promise<SilentDebuggerDetection> {
  try {
    if (os === 'win32') return await detectWindows();
    if (os === 'darwin' || os === 'linux') return await detectUnix();
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
async function detectWindows(): Promise<SilentDebuggerDetection> {
  const names = getAllowedBrowsers('win32')
    .map((n) => `'${n}'`)
    .join(',');
  const psScript =
    `Get-CimInstance Win32_Process | ` +
    `Where-Object { $_.Name -in @(${names}) } | ` +
    `Select-Object -ExpandProperty CommandLine`;
  const { stdout } = await execAsync(
    `powershell -NoProfile -NonInteractive -Command "${psScript}"`,
    {
      timeout: DETECT_TIMEOUT_MS,
    },
  );
  return parseCommandLines(stdout);
}

/**
 * macOS / Linux: a plain `ps` scan. `-axo command=` lists every process's
 * full command line (BSD-style flags, accepted by both macOS's ps and
 * Linux's procps ps) with no header, one per line.
 */
async function detectUnix(): Promise<SilentDebuggerDetection> {
  const { stdout } = await execAsync('ps -axo command=', { timeout: DETECT_TIMEOUT_MS });
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
