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
    'Chromium',
    'Chromium Helper',
    'Chromium Helper (Renderer)',
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
