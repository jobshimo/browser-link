import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getDataDir } from '../map/paths.js';

/**
 * Per-session authentication token for the IPC channel between primary and
 * proxy browser-link processes. The primary writes a fresh random token at
 * startup; proxies read it just before sending their hello frame.
 *
 * Security model: the file lives in the user's data dir. On POSIX we set
 * 0600 so only the user can read it. On Windows the file inherits the
 * user-profile ACL, which is already restricted to the same user. A
 * malicious process running as the same user can read the file — at that
 * point the user has already lost — but a different local user, a remote
 * peer, or a sandboxed process cannot.
 */

const TOKEN_FILE_NAME = 'multi-agent-token';
const TOKEN_HEX_LENGTH = 64; // 32 bytes hex = 64 chars

/** Where the per-session token file lives. */
export function tokenPath(): string {
  return join(getDataDir(), TOKEN_FILE_NAME);
}

/** Generate a fresh 32-byte hex token. */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/** Write the given token to the data dir, replacing any previous value.
 * Tries to set 0600 permissions on POSIX; on Windows the file ACL
 * inherits from the user's profile, which is already user-only. */
export function writeToken(token: string): string {
  const path = tokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod is a no-op on Windows; ignore.
  }
  return path;
}

/** Read the current token. Returns null if no token file exists or if
 * it does not look like a valid 32-byte hex string. */
export function readToken(): string | null {
  const path = tokenPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (raw.length !== TOKEN_HEX_LENGTH) return null;
    if (!/^[0-9a-f]+$/i.test(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Generate + write a fresh token. Returns it. Called by every primary
 * on startup, so any zombie token from a previous primary is invalidated. */
export function rotateToken(): string {
  const token = generateToken();
  writeToken(token);
  return token;
}

/** Best-effort cleanup. Used when the primary shuts down cleanly so the
 * file doesn't linger as misleading state. */
export function clearToken(): void {
  const path = tokenPath();
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // ignore
  }
}
