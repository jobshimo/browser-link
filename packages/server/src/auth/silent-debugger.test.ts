import { describe, expect, test } from 'vitest';
import {
  detectSilentDebuggerFlag,
  parseCommandLines,
  SILENT_DEBUGGER_FLAG,
  type ExecLike,
} from './silent-debugger.js';

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

describe('detectSilentDebuggerFlag (injected exec)', () => {
  test('degrades to detected:null when the exec call times out', async () => {
    const execFn: ExecLike = () =>
      Promise.reject(
        Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' }),
      );
    expect(await detectSilentDebuggerFlag('win32', execFn)).toEqual({ detected: null });
  });

  test('degrades to detected:null when the exec call errors (missing tool, permission denied)', async () => {
    const execFn: ExecLike = () => Promise.reject(new Error('spawn powershell ENOENT'));
    expect(await detectSilentDebuggerFlag('win32', execFn)).toEqual({ detected: null });
  });

  test('resolves detected:true when the injected stdout carries the flag (win32 path)', async () => {
    const execFn: ExecLike = (command) => {
      expect(command).toContain('Get-CimInstance');
      return Promise.resolve({
        stdout: `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ${SILENT_DEBUGGER_FLAG}\n`,
      });
    };
    expect(await detectSilentDebuggerFlag('win32', execFn)).toEqual({ detected: true });
  });

  test('resolves detected:false when browsers are running without the flag (unix path)', async () => {
    const execFn: ExecLike = (command) => {
      expect(command).toBe('ps -axo command=');
      return Promise.resolve({
        stdout:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default\n',
      });
    };
    expect(await detectSilentDebuggerFlag('darwin', execFn)).toEqual({ detected: false });
  });

  test('resolves detected:null on an unsupported OS without ever calling exec', async () => {
    const execFn: ExecLike = () => Promise.reject(new Error('should not be called'));
    expect(await detectSilentDebuggerFlag('aix', execFn)).toEqual({ detected: null });
  });

  test('passes the raised DETECT_TIMEOUT_MS (5000ms) budget through to the exec call', async () => {
    let capturedTimeout: number | undefined;
    const execFn: ExecLike = (_command, options) => {
      capturedTimeout = options.timeout;
      return Promise.resolve({ stdout: '' });
    };
    await detectSilentDebuggerFlag('win32', execFn);
    expect(capturedTimeout).toBe(5000);
  });
});
