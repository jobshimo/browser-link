import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { VERSION } from '../version.js';
import { compareSemver } from '../utils/semver.js';
import { block, countBeginMarkers, detectEol, findBlockSpan } from './content.js';
import { CorruptBlockError, OutsideHomeError, SymlinkRefusedError } from './errors.js';
import type { InstructionsDetect } from './types.js';

/** Options for the write-side helpers. `allowOutsideHome` opts out of the
 * outside-`$HOME` guard for clients that honour an explicit user-controlled
 * override (e.g. Copilot CLI's `COPILOT_HOME`). */
export interface FileOpOptions {
  allowOutsideHome?: boolean;
}

/**
 * Shared file-level operations for the three agent-instructions installers.
 * Per-client modules only know which path their target file lives at; the
 * marker handling and the text splice are the same everywhere.
 */

/** Atomic write via a sibling temp file + fsync + rename. Closes the
 * TOCTOU window between existsSync()/stat and writeFileSync() that
 * CodeQL flagged as js/file-system-race. Cleans up the temp file if
 * the rename fails (or any earlier step throws). The 0o600 create-mode
 * keeps the temp file private while it lives. */
function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  const tmp = join(dir, `.${basename(filePath)}.${process.pid}-${Date.now()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w', 0o600);
    writeSync(fd, content, null, 'utf8');
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

/** Refuse to touch paths that land outside the user's home directory. The
 * block we manage is meant for the user's own dotfiles; writing into
 * `/etc`, `C:\Windows`, or anywhere unrelated is almost always a bug or a
 * tampered config. `allowOutsideHome: true` skips the check — used when
 * the user opted in through a client-specific env var (e.g. `COPILOT_HOME`).
 * The home directory itself counts as "under" home (the equality branch). */
function assertUnderHome(filePath: string): void {
  const home = resolve(homedir());
  const resolved = resolve(filePath);
  if (resolved === home) return;
  if (resolved.startsWith(home + sep)) return;
  throw new OutsideHomeError(filePath, home);
}

/** Throw SymlinkRefusedError if `filePath` is a symlink. existsSync follows
 * symlinks, so callers must use this lstat-based check separately. */
function guardSymlink(filePath: string): void {
  let st;
  try {
    st = lstatSync(filePath);
  } catch {
    return; // file does not exist — not our problem here
  }
  if (!st.isSymbolicLink()) return;
  const rawTarget = readlinkSync(filePath);
  // realpath gives us the absolute resolved path even when readlink returns
  // something relative. Fall back to the raw readlink output if realpath
  // throws (broken symlink) so the error message still names a target.
  let resolved: string;
  try {
    resolved = realpathSync(filePath);
  } catch {
    resolved = rawTarget;
  }
  throw new SymlinkRefusedError(filePath, resolved, block());
}

export function detectAt(filePath: string): InstructionsDetect {
  if (!existsSync(filePath)) {
    return { filePath, state: { kind: 'no-file' } };
  }
  const text = readFileSync(filePath, 'utf8');
  if (countBeginMarkers(text) > 1) {
    return { filePath, state: { kind: 'corrupt', reason: 'multiple-begin-markers' } };
  }
  const span = findBlockSpan(text);
  if (!span) {
    return { filePath, state: { kind: 'not-installed' } };
  }
  const installedVersion = span.installedVersion;
  const cmp = compareSemver(installedVersion, VERSION);
  return {
    filePath,
    state:
      cmp < 0
        ? { kind: 'installed-outdated', version: installedVersion }
        : { kind: 'installed', version: installedVersion },
  };
}

/**
 * Insert or refresh the block in `filePath`. Returns a one-line description
 * of what changed, suitable for surfacing to the user.
 */
export function installAt(
  filePath: string,
  displayName: string,
  options: FileOpOptions = {},
): string {
  if (!options.allowOutsideHome) assertUnderHome(filePath);
  guardSymlink(filePath);
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    // New file: portable markdown — LF by default. We do NOT pick CRLF on
    // Windows because the content is going into a tool-managed .md file
    // that may be synced to other OSes.
    atomicWrite(filePath, block());
    return `Created ${filePath} and inserted the browser-link instructions block for ${displayName}.`;
  }
  const text = readFileSync(filePath, 'utf8');
  if (countBeginMarkers(text) > 1) {
    throw new CorruptBlockError(filePath, 'multiple-begin-markers');
  }
  const eol = detectEol(text);
  const fresh = block(VERSION, eol);
  const span = findBlockSpan(text);
  if (!span) {
    // Append. Ensure a blank line separator from prior content, matching
    // the file's dominant line ending.
    const doubleEol = `${eol}${eol}`;
    const separator =
      text.length === 0 || text.endsWith(doubleEol) ? '' : text.endsWith(eol) ? eol : doubleEol;
    atomicWrite(filePath, text + separator + fresh);
    return `Appended the browser-link instructions block to ${filePath} (${displayName}).`;
  }
  const before = text.slice(0, span.startIndex);
  const after = text.slice(span.endIndex);
  atomicWrite(filePath, before + fresh + after);
  // The previous version is rendered as `v{prev}` when the marker carried
  // a semver, and as `legacy` when the file pre-dates the version stamp
  // (older browser-link releases shipped a marker with no version). The
  // user-facing copy emphasises that the new triggers are immediately in
  // effect — the next MCP-client restart is the only step left.
  const prev = span.installedVersion === null ? 'legacy' : `v${span.installedVersion}`;
  return `Replaced the ${prev} block with the v${VERSION} reflex protocol. New triggers active immediately — restart your MCP client.`;
}

export function uninstallAt(
  filePath: string,
  displayName: string,
  options: FileOpOptions = {},
): string {
  if (!options.allowOutsideHome) assertUnderHome(filePath);
  if (!existsSync(filePath)) {
    return `No ${displayName} instructions file at ${filePath}; nothing to remove.`;
  }
  guardSymlink(filePath);
  const text = readFileSync(filePath, 'utf8');
  if (countBeginMarkers(text) > 1) {
    throw new CorruptBlockError(filePath, 'multiple-begin-markers');
  }
  const span = findBlockSpan(text);
  if (!span) {
    return `browser-link instructions block was not present in ${filePath}; nothing to remove.`;
  }
  const before = text.slice(0, span.startIndex);
  const after = text.slice(span.endIndex);
  // Collapse double blank lines created by removing the block, but keep the
  // user's own content. A single trailing newline at EOF is restored,
  // matching whatever EOL the remaining content uses.
  const remaining = before + after;
  const eol = detectEol(remaining);
  const collapsePattern = eol === '\r\n' ? /(?:\r\n){3,}/g : /\n{3,}/g;
  const doubleEol = `${eol}${eol}`;
  let next = remaining.replace(collapsePattern, doubleEol);
  if (next.length > 0 && !next.endsWith(eol)) next += eol;
  atomicWrite(filePath, next);
  return `Removed the browser-link instructions block from ${filePath} (${displayName}).`;
}
