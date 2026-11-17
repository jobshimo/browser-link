import { realpathSync } from 'node:fs';
import { platform } from 'node:os';

/**
 * Names of Chromium-based browser binaries the WebSocket bridge accepts as
 * legitimate peers. Strict equality after stripping any path component.
 *
 * The match is per-OS because the binary that owns a TCP socket reports a
 * different name on macOS ("Google Chrome Helper"), Linux ("chrome") and
 * Windows ("chrome.exe"). Helper processes are included because in
 * Chromium-based browsers the network stack often lives in a separate
 * "Network Service" helper, not the main process.
 */
const ALLOWED_BY_OS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: [
    'Google Chrome',
    'Google Chrome Helper',
    'Google Chrome Helper (Renderer)',
    'Google Chrome Helper (GPU)',
    'Google Chrome Helper (Plugin)',
    'Google Chrome Helper (Alerts)',
    // Network-service helper: owns the socket in Chrome 157 on macOS.
    'Google Chrome Helper (Aperitif)',
    'Chromium',
    'Chromium Helper',
    'Chromium Helper (Renderer)',
    'Chromium Helper (Aperitif)',
    'Microsoft Edge',
    'Microsoft Edge Helper',
    'Microsoft Edge Helper (Renderer)',
    'Brave Browser',
    'Brave Browser Helper',
    'Brave Browser Helper (Renderer)',
    'Vivaldi',
    'Vivaldi Helper',
  ],
  linux: [
    'chrome',
    'chromium',
    'chromium-browser',
    'google-chrome',
    'google-chrome-stable',
    'msedge',
    'microsoft-edge',
    'brave',
    'brave-browser',
    'vivaldi-bin',
    'vivaldi-stable',
  ],
  win32: ['chrome.exe', 'chromium.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe'],
};

export function getAllowedBrowsers(os: NodeJS.Platform = platform()): readonly string[] {
  return ALLOWED_BY_OS[os] ?? [];
}

export function isAllowedBrowser(binaryName: string, os: NodeJS.Platform = platform()): boolean {
  return getAllowedBrowsers(os).includes(binaryName);
}

/** The real path of a listed entry, read on disk now; null when it cannot
 * be resolved (missing file, no access). */
export type ResolveListedPath = (path: string) => string | null;

const resolveOnDisk: ResolveListedPath = (path) => {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
};

/**
 * The opt-in strict mode (`peerExecutablePaths` in config.json): the peer's
 * executable path must equal one listed path, or that listed path with its
 * junctions and symbolic links resolved on disk at check time —
 * case-insensitively on Windows, whose file system is, and exactly
 * elsewhere. An unread or empty path never matches, and an empty list allows
 * nothing.
 *
 * Only the listed side is resolved. On Windows the peer's path is the real
 * file the kernel reports, so an entry through a junction (nvm's
 * `C:\nvm4w\nodejs\node.exe`) still matches the program started through it.
 * Resolving the listed side can only add the file the entry names today;
 * the peer's path is never resolved again, since a junction the peer
 * controls could be pointed elsewhere after it started.
 */
export function isAllowedExecutablePath(
  executablePath: string | undefined,
  allowed: readonly string[],
  os: NodeJS.Platform = platform(),
  resolve: ResolveListedPath = resolveOnDisk,
): boolean {
  if (executablePath === undefined || executablePath.length === 0) return false;
  const same =
    os === 'win32'
      ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      : (a: string, b: string) => a === b;
  return allowed.some((entry) => {
    if (same(entry, executablePath)) return true;
    if (entry.length === 0) return false;
    const real = resolve(entry);
    return real !== null && real.length > 0 && same(real, executablePath);
  });
}
