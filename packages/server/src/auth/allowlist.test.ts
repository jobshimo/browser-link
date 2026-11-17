import { afterAll, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAllowedBrowsers, isAllowedBrowser, isAllowedExecutablePath } from './allowlist.js';

describe('isAllowedExecutablePath (opt-in strict mode)', () => {
  const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  test('Windows compares case-insensitively', () => {
    expect(isAllowedExecutablePath(CHROME.toUpperCase(), [CHROME], 'win32')).toBe(true);
    expect(isAllowedExecutablePath(CHROME, [CHROME.toLowerCase()], 'win32')).toBe(true);
  });

  test('macOS and Linux compare exactly', () => {
    expect(
      isAllowedExecutablePath('/opt/google/chrome/chrome', ['/opt/google/chrome/chrome'], 'linux'),
    ).toBe(true);
    expect(
      isAllowedExecutablePath('/opt/google/chrome/Chrome', ['/opt/google/chrome/chrome'], 'linux'),
    ).toBe(false);
    expect(
      isAllowedExecutablePath(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ['/applications/google chrome.app/contents/macos/google chrome'],
        'darwin',
      ),
    ).toBe(false);
  });

  test('a path that is not listed is refused', () => {
    expect(isAllowedExecutablePath('C:\\Users\\me\\chrome.exe', [CHROME], 'win32')).toBe(false);
  });

  test('an unreadable path is refused', () => {
    expect(isAllowedExecutablePath(undefined, [CHROME], 'win32')).toBe(false);
    expect(isAllowedExecutablePath('', [''], 'win32')).toBe(false);
  });

  test('an empty list allows nothing', () => {
    expect(isAllowedExecutablePath(CHROME, [], 'win32')).toBe(false);
  });
});

describe('isAllowedExecutablePath: a listed path that goes through a junction', () => {
  // A real directory junction (a symbolic link outside Windows), as nvm for
  // Windows makes: C:\nvm4w\nodejs -> the active version's folder. The peer
  // path is what the kernel reports: the real file.
  const root = mkdtempSync(join(tmpdir(), 'bl-junction-'));
  const realDir = join(root, 'v24');
  const otherDir = join(root, 'v22');
  mkdirSync(realDir);
  mkdirSync(otherDir);
  writeFileSync(join(realDir, 'node.exe'), '');
  writeFileSync(join(otherDir, 'node.exe'), '');
  symlinkSync(realDir, join(root, 'nodejs'), 'junction');
  symlinkSync(otherDir, join(root, 'other'), 'junction');
  const kernelPath = realpathSync.native(join(realDir, 'node.exe'));
  const os = process.platform;
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('an entry through a junction to the real file matches', () => {
    expect(isAllowedExecutablePath(kernelPath, [join(root, 'nodejs', 'node.exe')], os)).toBe(true);
  });

  test('an entry through a junction to a different file does not match', () => {
    expect(isAllowedExecutablePath(kernelPath, [join(root, 'other', 'node.exe')], os)).toBe(false);
  });

  test('an entry that does not exist on disk only matches as written', () => {
    const gone = join(root, 'gone', 'node.exe');
    expect(isAllowedExecutablePath(kernelPath, [gone], os)).toBe(false);
    expect(isAllowedExecutablePath(gone, [gone], os)).toBe(true);
  });

  test('the peer path is never resolved: a peer path through the junction does not match the real entry', () => {
    expect(isAllowedExecutablePath(join(root, 'nodejs', 'node.exe'), [kernelPath], os)).toBe(false);
  });

  test('on Windows the resolved entry is compared case-insensitively too', () => {
    const resolve = (p: string) => (p === 'C:\\link\\node.exe' ? 'C:\\Real\\Node.exe' : null);
    expect(
      isAllowedExecutablePath('c:\\real\\node.exe', ['C:\\link\\node.exe'], 'win32', resolve),
    ).toBe(true);
  });
});

describe('isAllowedBrowser', () => {
  test('accepts Google Chrome variants on macOS', () => {
    expect(isAllowedBrowser('Google Chrome', 'darwin')).toBe(true);
    expect(isAllowedBrowser('Google Chrome Helper', 'darwin')).toBe(true);
    expect(isAllowedBrowser('Google Chrome Helper (Renderer)', 'darwin')).toBe(true);
  });

  // Chrome 157 on macOS runs its network service in a helper with this name,
  // and that helper owns the bridge socket (lsof -F pc, confirmed on a Mac).
  test('accepts the macOS network-service helper of Chrome and Chromium', () => {
    expect(isAllowedBrowser('Google Chrome Helper (Aperitif)', 'darwin')).toBe(true);
    expect(isAllowedBrowser('Chromium Helper (Aperitif)', 'darwin')).toBe(true);
  });

  test('keeps the macOS helper match exact', () => {
    expect(isAllowedBrowser('Google Chrome Helper (Fake)', 'darwin')).toBe(false);
    expect(isAllowedBrowser('Google Chrome Helper (Aperitif) ', 'darwin')).toBe(false);
    expect(isAllowedBrowser('Google Chrome Helper (Aperitif)', 'linux')).toBe(false);
    expect(isAllowedBrowser('Google Chrome Helper (Aperitif)', 'win32')).toBe(false);
  });

  test('accepts other Chromium-based browsers on macOS', () => {
    expect(isAllowedBrowser('Chromium', 'darwin')).toBe(true);
    expect(isAllowedBrowser('Microsoft Edge', 'darwin')).toBe(true);
    expect(isAllowedBrowser('Brave Browser', 'darwin')).toBe(true);
    expect(isAllowedBrowser('Vivaldi', 'darwin')).toBe(true);
  });

  test('rejects non-browser processes on macOS', () => {
    expect(isAllowedBrowser('node', 'darwin')).toBe(false);
    expect(isAllowedBrowser('python', 'darwin')).toBe(false);
    expect(isAllowedBrowser('curl', 'darwin')).toBe(false);
    expect(isAllowedBrowser('Safari', 'darwin')).toBe(false);
    expect(isAllowedBrowser('Firefox', 'darwin')).toBe(false);
  });

  test('accepts Chromium-based binaries on Linux', () => {
    expect(isAllowedBrowser('chrome', 'linux')).toBe(true);
    expect(isAllowedBrowser('chromium', 'linux')).toBe(true);
    expect(isAllowedBrowser('google-chrome-stable', 'linux')).toBe(true);
    expect(isAllowedBrowser('brave', 'linux')).toBe(true);
  });

  test('rejects non-browser binaries on Linux', () => {
    expect(isAllowedBrowser('firefox', 'linux')).toBe(false);
    expect(isAllowedBrowser('node', 'linux')).toBe(false);
  });

  test('accepts the .exe names on Windows', () => {
    expect(isAllowedBrowser('chrome.exe', 'win32')).toBe(true);
    expect(isAllowedBrowser('msedge.exe', 'win32')).toBe(true);
    expect(isAllowedBrowser('brave.exe', 'win32')).toBe(true);
  });

  test('is case-sensitive (catches typo attacks)', () => {
    expect(isAllowedBrowser('google chrome', 'darwin')).toBe(false);
    expect(isAllowedBrowser('Chrome.exe', 'win32')).toBe(false);
  });

  test('rejects empty input', () => {
    expect(isAllowedBrowser('', 'darwin')).toBe(false);
  });
});

describe('getAllowedBrowsers', () => {
  test('returns a non-empty list for each supported OS', () => {
    expect(getAllowedBrowsers('darwin').length).toBeGreaterThan(0);
    expect(getAllowedBrowsers('linux').length).toBeGreaterThan(0);
    expect(getAllowedBrowsers('win32').length).toBeGreaterThan(0);
  });

  test('returns an empty list for OSes we do not support', () => {
    expect(getAllowedBrowsers('aix')).toEqual([]);
  });
});
