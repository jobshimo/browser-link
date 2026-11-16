import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * The one safe path every installer goes through when it touches a file the
 * user owns: the MCP client configs (`installers/*`) and the agent
 * instruction files (`agent-instructions/*`).
 *
 * - read: strict UTF-8, refused (nothing changed) when a byte is invalid;
 * - write guards: inside the user's home directory (unless the user opted
 *   out through a client env var) and never through a symlink;
 * - write: atomic (sibling temp file, fsync, rename). No backup copy.
 *
 * Callers validate what they read before they write, and splice only their
 * own bytes, so everything else in the file is written back unchanged.
 */

export interface WriteGuardOptions {
  /** Skip the home-directory guard: the user redirected the path through a
   * client-specific env var (e.g. Copilot CLI's `COPILOT_HOME`). */
  allowOutsideHome?: boolean;
  /** Extra text for the symlink refusal (the instruction installers pass a
   * paste-ready block so the user can install it in the target by hand). */
  symlinkBlock?: () => string;
}

/** Thrown when the target file is a symlink. We refuse to write through
 * symlinks because the user's intent is ambiguous: editing the target may
 * not be what they meant when they made the symlink. When `blockContent` is
 * not empty the message embeds it so the user can paste it into the target. */
export class SymlinkRefusedError extends Error {
  constructor(
    public readonly source: string,
    public readonly target: string,
    public readonly blockContent: string = '',
  ) {
    super(
      blockContent.length > 0
        ? `${source} is a symlink to ${target}. Refusing to write through it. ` +
            `Paste the block below into ${target} manually:\n\n${blockContent}`
        : `${source} is a symlink to ${target}. Refusing to write through it; nothing was ` +
            `changed. Edit ${target} by hand or replace the symlink with a regular file.`,
    );
    this.name = 'SymlinkRefusedError';
  }
}

/** Thrown when a write would land outside the resolved home directory and
 * the caller did not opt into the override. A tampered `HOME` or a typo'd
 * path should not let an installer scribble in `/etc` or `C:\Windows`. */
export class OutsideHomeError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly home: string,
  ) {
    super(
      `Refusing to write ${filePath}: target is outside the user home directory ` +
        `(${home}). Set the client-specific override env var (e.g. COPILOT_HOME) ` +
        `if this path is intentional.`,
    );
    this.name = 'OutsideHomeError';
  }
}

/** Thrown when a file the user owns is not valid UTF-8. Decoding it would
 * turn every invalid byte into U+FFFD and writing it back would change bytes
 * that are not ours, so the installer refuses and changes nothing. */
export class InvalidUtf8Error extends Error {
  constructor(
    public readonly filePath: string,
    public readonly byteOffset: number,
    public readonly byteValue: number,
  ) {
    const hex = byteValue.toString(16).toUpperCase().padStart(2, '0');
    super(
      `${filePath} is not valid UTF-8 (byte 0x${hex} at offset ${byteOffset}). ` +
        'Refusing to touch it; nothing was changed. Save the file as UTF-8 and run the command again.',
    );
    this.name = 'InvalidUtf8Error';
  }
}

/** Offset of the first byte that does not start a valid UTF-8 sequence
 * (overlong forms, surrogates and code points above U+10FFFF included), or
 * -1 when the whole buffer is valid. */
export function firstInvalidUtf8Offset(buf: Uint8Array): number {
  let i = 0;
  while (i < buf.length) {
    const lead = buf[i];
    if (lead < 0x80) {
      i++;
      continue;
    }
    let need: number;
    let min: number;
    if (lead >= 0xc2 && lead <= 0xdf) [need, min] = [1, 0x80];
    else if (lead >= 0xe0 && lead <= 0xef) [need, min] = [2, 0x800];
    else if (lead >= 0xf0 && lead <= 0xf4) [need, min] = [3, 0x10000];
    else return i;
    if (i + need >= buf.length) return i; // truncated sequence at the end
    let cp = lead & (0x3f >> need);
    for (let k = 1; k <= need; k++) {
      const cont = buf[i + k];
      if ((cont & 0xc0) !== 0x80) return i;
      cp = (cp << 6) | (cont & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i;
    i += need + 1;
  }
  return -1;
}

/** Read `filePath` as strict UTF-8. Returns null when the file does not
 * exist; throws InvalidUtf8Error, without changing anything, when a byte is
 * not valid UTF-8. A BOM is kept as a character so it is written back. */
export function readUtf8Strict(filePath: string): string | null {
  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const bad = firstInvalidUtf8Offset(buf);
  if (bad !== -1) throw new InvalidUtf8Error(filePath, bad, buf[bad]);
  return buf.toString('utf8');
}

/** Refuse paths that land outside the user's home directory. The home
 * directory itself counts as "under" home. */
export function assertUnderHome(filePath: string): void {
  const home = resolve(homedir());
  const resolved = resolve(filePath);
  if (resolved === home) return;
  if (resolved.startsWith(home + sep)) return;
  throw new OutsideHomeError(filePath, home);
}

/** Throw SymlinkRefusedError when `filePath` is a symlink. existsSync and
 * readFileSync follow symlinks, so this lstat-based check is separate. */
export function assertNotSymlink(filePath: string, symlinkBlock?: () => string): void {
  let isLink: boolean;
  try {
    isLink = lstatSync(filePath).isSymbolicLink();
  } catch {
    return; // the file does not exist
  }
  if (!isLink) return;
  // realpath gives the absolute target even when readlink is relative; a
  // broken symlink falls back to the raw readlink output.
  let target: string;
  try {
    target = realpathSync(filePath);
  } catch {
    target = readlinkSync(filePath);
  }
  throw new SymlinkRefusedError(filePath, target, symlinkBlock?.() ?? '');
}

/** The guards every write-side installer operation runs before it reads:
 * home directory first, then symlink. */
export function assertWritable(filePath: string, options: WriteGuardOptions = {}): void {
  if (!options.allowOutsideHome) assertUnderHome(filePath);
  assertNotSymlink(filePath, options.symlinkBlock);
}

/** Permission bits of an existing file, or null when there is none. */
function existingMode(filePath: string): number | null {
  try {
    return statSync(filePath).mode & 0o7777;
  } catch {
    return null;
  }
}

/** Atomic write via a sibling temp file + fsync + rename, so a crash or a
 * full disk leaves either the old file or the new one, never a truncated
 * one. Creates the parent directory. Cleans up the temp file on failure. The
 * 0o600 create-mode keeps the temp file private while it is written; a file
 * that already exists keeps its own permission bits, a new one stays 0o600. */
export function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(filePath)}.${process.pid}-${Date.now()}.tmp`);
  const keptMode = existingMode(filePath);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w', 0o600);
    writeSync(fd, content, null, 'utf8');
    // The permission bits are the user's: the replacement keeps them. The
    // temp file stays private until its content is complete.
    if (keptMode !== null) fchmodSync(fd, keptMode);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* swallow — we're already on the error path */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* swallow — the tmp may never have been created */
    }
    throw err;
  }
}
