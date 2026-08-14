import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../map/paths.js';
import {
  clearToken,
  generateToken,
  readToken,
  rotateToken,
  tokenPath,
  writeToken,
} from './token.js';

let dataDir: string;
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'browser-link-token-'));
  spy = vi.spyOn(paths, 'getDataDir').mockReturnValue(dataDir);
});

afterEach(() => {
  spy.mockRestore();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('generateToken', () => {
  test('produces a 64-char lowercase hex string', () => {
    const t = generateToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  test('two calls produce different tokens', () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe('writeToken / readToken', () => {
  test('round-trip', () => {
    const t = generateToken();
    writeToken(t);
    expect(readToken()).toBe(t);
  });

  test('write creates the data dir if missing', () => {
    rmSync(dataDir, { recursive: true, force: true });
    expect(existsSync(dataDir)).toBe(false);
    writeToken('a'.repeat(64));
    expect(readToken()).toBe('a'.repeat(64));
  });

  test('readToken returns null when file does not exist', () => {
    expect(readToken()).toBeNull();
  });

  test('readToken returns null when contents look wrong', () => {
    writeFileSync(tokenPath(), 'too short', 'utf8');
    expect(readToken()).toBeNull();

    writeFileSync(tokenPath(), 'Z'.repeat(64), 'utf8'); // non-hex chars
    expect(readToken()).toBeNull();
  });

  test('readToken trims surrounding whitespace', () => {
    writeFileSync(tokenPath(), '  ' + 'a'.repeat(64) + '\n', 'utf8');
    expect(readToken()).toBe('a'.repeat(64));
  });
});

describe('rotateToken', () => {
  test('writes a fresh token and returns it', () => {
    const t1 = rotateToken();
    expect(readToken()).toBe(t1);
    const t2 = rotateToken();
    expect(t2).not.toBe(t1);
    expect(readToken()).toBe(t2);
  });
});

describe('clearToken', () => {
  test('removes the token file when present', () => {
    rotateToken();
    expect(readToken()).not.toBeNull();
    clearToken();
    expect(readToken()).toBeNull();
  });

  test('is a no-op when no file exists', () => {
    expect(() => clearToken()).not.toThrow();
  });
});
