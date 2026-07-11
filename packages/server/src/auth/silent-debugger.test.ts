import { describe, expect, test } from 'vitest';
import { parseCommandLines, SILENT_DEBUGGER_FLAG } from './silent-debugger.js';

describe('parseCommandLines', () => {
  test('detects the flag on a Chrome command line', () => {
    const out = [
      `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ${SILENT_DEBUGGER_FLAG} --profile-directory=Default`,
      'C:\\Windows\\explorer.exe',
      '',
    ].join('\n');
    expect(parseCommandLines(out)).toEqual({ detected: true });
  });

  test('reports false when Chrome is running without the flag', () => {
    const out = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default',
      '/usr/libexec/some-daemon',
      '',
    ].join('\n');
    expect(parseCommandLines(out)).toEqual({ detected: false });
  });

  test('reports null (unknown) when no browser process is present', () => {
    const out = ['/usr/bin/bash', '/usr/libexec/some-daemon', ''].join('\n');
    expect(parseCommandLines(out)).toEqual({ detected: null });
  });

  test('reports null on empty output', () => {
    expect(parseCommandLines('')).toEqual({ detected: null });
  });

  test('recognizes the flag on any Chromium-family browser, not just Chrome', () => {
    const out = '/usr/bin/microsoft-edge ' + SILENT_DEBUGGER_FLAG;
    expect(parseCommandLines(out)).toEqual({ detected: true });
  });

  test('detected true if ANY of several browser processes carries the flag', () => {
    const out = [
      '/usr/bin/google-chrome-stable --type=renderer',
      `/usr/bin/google-chrome-stable ${SILENT_DEBUGGER_FLAG}`,
      '/usr/bin/google-chrome-stable --type=gpu-process',
      '',
    ].join('\n');
    expect(parseCommandLines(out)).toEqual({ detected: true });
  });

  test('ignores unrelated lines that merely contain the word "brave" as a substring of something else', () => {
    // Sanity: the browser hint regex is intentionally loose but must not
    // choke on ordinary non-browser process listings.
    const out = ['/usr/bin/node server.js', ''].join('\n');
    expect(parseCommandLines(out)).toEqual({ detected: null });
  });
});
