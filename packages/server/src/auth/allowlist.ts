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

/**
 * The opt-in strict mode (`peerExecutablePaths` in config.json): the peer's
 * executable path must equal one listed path — case-insensitively on
 * Windows, whose file system is, and exactly elsewhere. An unread or empty
 * path never matches, and an empty list allows nothing.
 */
export function isAllowedExecutablePath(
  executablePath: string | undefined,
  allowed: readonly string[],
  os: NodeJS.Platform = platform(),
): boolean {
  if (executablePath === undefined || executablePath.length === 0) return false;
  if (os === 'win32') {
    const wanted = executablePath.toLowerCase();
    return allowed.some((p) => p.toLowerCase() === wanted);
  }
  return allowed.includes(executablePath);
}
