import { describe, expect, test } from 'vitest';
import {
  decodeLsofString,
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
  test('returns the first PID/command pair from a -F pc dump', () => {
    const out = 'p1234\ncGoogle\\x20Chrome\\x20Helper\np5678\ncchrome\n';
    expect(parseLsofOutput(out)).toEqual({ pid: 1234, binaryName: 'Google Chrome Helper' });
  });

  test('handles a single-process dump', () => {
    const out = 'p1\ncchrome\n';
    expect(parseLsofOutput(out)).toEqual({ pid: 1, binaryName: 'chrome' });
  });

  test('returns null when output is empty', () => {
    expect(parseLsofOutput('')).toBeNull();
  });

  test('returns null when there is no command line after the pid', () => {
    expect(parseLsofOutput('p1234\n')).toBeNull();
  });

  test('ignores malformed pid lines', () => {
    expect(parseLsofOutput('pNOT_A_NUMBER\ncchrome\n')).toBeNull();
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
