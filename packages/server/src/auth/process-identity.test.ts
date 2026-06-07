import { describe, expect, test } from 'vitest';
import {
  decodeLsofString,
  parseGetProcessName,
  parseLsofOutput,
  parseNetstatForLocal,
  parseTasklistImage,
} from './process-identity.js';

describe('decodeLsofString', () => {
  test('decodes the \\xHH escapes lsof uses for spaces and tabs', () => {
    expect(decodeLsofString('Google\\x20Chrome\\x20Helper')).toBe('Google Chrome Helper');
    expect(decodeLsofString('python\\x093.11')).toBe('python\t3.11');
  });

  test('leaves a name without escapes untouched', () => {
    expect(decodeLsofString('chrome')).toBe('chrome');
  });
});

describe('parseLsofOutput', () => {
  // Regression for the loopback ambiguity bug: on a localhost connection,
  // lsof -i @host:port matches BOTH ends of the socket — the peer's local
  // side AND the server's remote side. The parser must pick the entry whose
  // local endpoint matches the queried host:port, never the other one.
  test('returns the peer whose local endpoint matches host:port (loopback)', () => {
    const out = [
      'p1061',
      'cnode',
      'n127.0.0.1:17529->127.0.0.1:64836',
      'p3532',
      'cGoogle\\x20Chrome\\x20Helper',
      'n127.0.0.1:64836->127.0.0.1:17529',
      '',
    ].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toEqual({
      pid: 3532,
      binaryName: 'Google Chrome Helper',
    });
  });

  test('does not flip when the peer prints first', () => {
    const out = [
      'p3532',
      'cGoogle\\x20Chrome\\x20Helper',
      'n127.0.0.1:64836->127.0.0.1:17529',
      'p1061',
      'cnode',
      'n127.0.0.1:17529->127.0.0.1:64836',
      '',
    ].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toEqual({
      pid: 3532,
      binaryName: 'Google Chrome Helper',
    });
  });

  test('returns the single owner in a non-loopback dump', () => {
    const out = ['p42', 'cchrome', 'n10.0.0.5:54321->1.2.3.4:80', ''].join('\n');
    expect(parseLsofOutput(out, '10.0.0.5', 54321)).toEqual({ pid: 42, binaryName: 'chrome' });
  });

  test('returns null when no entry has a local endpoint matching host:port', () => {
    const out = ['p1', 'cchrome', 'n127.0.0.1:9999->127.0.0.1:17529', ''].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toBeNull();
  });

  test('fails closed when two distinct PIDs claim the same local endpoint', () => {
    // Kernel-impossible in practice but defensive: never guess in the auth path.
    const out = [
      'p1',
      'cnode',
      'n127.0.0.1:64836->127.0.0.1:17529',
      'p2',
      'cchrome',
      'n127.0.0.1:64836->127.0.0.1:17529',
      '',
    ].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toBeNull();
  });

  test('returns null on empty output', () => {
    expect(parseLsofOutput('', '127.0.0.1', 1)).toBeNull();
  });

  test('returns null when the command line is missing', () => {
    const out = ['p1234', 'n127.0.0.1:64836->127.0.0.1:17529', ''].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toBeNull();
  });

  test('returns null when the n field is missing', () => {
    const out = ['p1234', 'cchrome', ''].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toBeNull();
  });

  test('ignores malformed pid lines', () => {
    const out = ['pNOT_A_NUMBER', 'cchrome', 'n127.0.0.1:64836->127.0.0.1:17529', ''].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toBeNull();
  });

  test('skips n lines without an arrow (e.g. LISTEN sockets that leaked through)', () => {
    const out = ['p1', 'cnginx', 'n127.0.0.1:64836', ''].join('\n');
    expect(parseLsofOutput(out, '127.0.0.1', 64836)).toBeNull();
  });
});

describe('parseNetstatForLocal', () => {
  const sample = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:54321        127.0.0.1:17529        ESTABLISHED     1234
  TCP    127.0.0.1:17529        127.0.0.1:54321        ESTABLISHED     9999
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
`;

  test('returns the PID whose LOCAL endpoint matches host:port', () => {
    expect(parseNetstatForLocal(sample, '127.0.0.1', 54321)).toBe(1234);
  });

  test('does not return the server-side PID (host:port is the server)', () => {
    expect(parseNetstatForLocal(sample, '127.0.0.1', 17529)).toBe(9999);
  });

  test('returns null when nothing matches', () => {
    expect(parseNetstatForLocal(sample, '127.0.0.1', 11111)).toBeNull();
  });
});

describe('parseTasklistImage', () => {
  test('reads the image name out of CSV no-header output', () => {
    const out = '"chrome.exe","1234","Console","1","250,000 K"';
    expect(parseTasklistImage(out)).toBe('chrome.exe');
  });

  test('skips blank lines and finds the first valid row', () => {
    const out = '\n\n"msedge.exe","42","Console","1","10 K"\n';
    expect(parseTasklistImage(out)).toBe('msedge.exe');
  });

  test('returns null when output is empty', () => {
    expect(parseTasklistImage('')).toBeNull();
  });
});

describe('parseGetProcessName', () => {
  test('appends .exe to the bare ProcessName Get-Process reports', () => {
    expect(parseGetProcessName('chrome\r\n')).toBe('chrome.exe');
  });

  test('does not double-suffix a name that already ends in .exe', () => {
    expect(parseGetProcessName('msedge.exe\n')).toBe('msedge.exe');
  });

  test('treats the suffix case-insensitively', () => {
    expect(parseGetProcessName('Brave.EXE')).toBe('Brave.EXE');
  });

  test('skips leading blank lines and returns the first real value', () => {
    expect(parseGetProcessName('\n\n  vivaldi  \n')).toBe('vivaldi.exe');
  });

  test('returns null when the process was not found (empty output)', () => {
    expect(parseGetProcessName('')).toBeNull();
  });
});
