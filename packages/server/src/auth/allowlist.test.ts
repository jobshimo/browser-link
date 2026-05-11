import { describe, expect, test } from 'vitest';
import { getAllowedBrowsers, isAllowedBrowser } from './allowlist.js';

describe('isAllowedBrowser', () => {
  test('accepts Google Chrome variants on macOS', () => {
    expect(isAllowedBrowser('Google Chrome', 'darwin')).toBe(true);
    expect(isAllowedBrowser('Google Chrome Helper', 'darwin')).toBe(true);
    expect(isAllowedBrowser('Google Chrome Helper (Renderer)', 'darwin')).toBe(true);
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
