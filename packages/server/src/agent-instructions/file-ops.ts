import { existsSync } from 'node:fs';
import { VERSION } from '../version.js';
import { compareSemver } from '../utils/semver.js';
import {
  InvalidUtf8Error,
  assertNotSymlink,
  assertUnderHome,
  assertWritable,
  atomicWrite,
  readUtf8Strict,
} from '../installers/safe-file.js';
import {
  block,
  countBeginMarkers,
  detectEol,
  findBlockSpan,
  orphanBeginLine,
  type BlockSpan,
} from './content.js';
import { CorruptBlockError } from './errors.js';
import type { InstructionsDetect } from './types.js';

/** Options for the write-side helpers. `allowOutsideHome` opts out of the
 * outside-`$HOME` guard for clients that honour an explicit user-controlled
 * override (e.g. Copilot CLI's `COPILOT_HOME`). */
export interface FileOpOptions {
  allowOutsideHome?: boolean;
  /** `installAt` only: keep the core rules in the block after the trigger. */
  withCore?: boolean;
}

/**
 * Shared file-level operations for the three agent-instructions installers.
 * Per-client modules only know which path their target file lives at; the
 * marker handling and the text splice are the same everywhere. Reading,
 * the guards and the atomic write go through `installers/safe-file.ts`, the
 * same safe path the MCP config installers use.
 */

/** The paste-ready block a symlink refusal carries. */
function symlinkBlock(options: FileOpOptions): () => string {
  return () => block(VERSION, '\n', { withCore: options.withCore });
}

/** Read and validate the file before anything is changed. Returns null when
 * it does not exist. Throws InvalidUtf8Error when it is not valid UTF-8 and
 * CorruptBlockError when its markers do not delimit exactly one block or
 * none. */
function readValidated(filePath: string): { text: string; span: BlockSpan | null } | null {
  const text = readUtf8Strict(filePath);
  if (text === null) return null;
  if (countBeginMarkers(text) > 1) {
    throw new CorruptBlockError(filePath, 'multiple-begin-markers');
  }
  const orphan = orphanBeginLine(text);
  if (orphan !== null) throw new CorruptBlockError(filePath, 'missing-end-marker', orphan);
  return { text, span: findBlockSpan(text) };
}

export function detectAt(filePath: string): InstructionsDetect {
  let read: ReturnType<typeof readValidated>;
  try {
    read = readValidated(filePath);
  } catch (err) {
    if (err instanceof CorruptBlockError) {
      return { filePath, state: { kind: 'corrupt', reason: err.reason } };
    }
    if (err instanceof InvalidUtf8Error) {
      return { filePath, state: { kind: 'corrupt', reason: 'invalid-utf8' } };
    }
    throw err;
  }
  if (read === null) return { filePath, state: { kind: 'no-file' } };
  const { span } = read;
  if (!span) {
    return { filePath, state: { kind: 'not-installed' } };
  }
  const installedVersion = span.installedVersion;
  const cmp = compareSemver(installedVersion, VERSION);
  return {
    filePath,
    state:
      cmp < 0
        ? { kind: 'installed-outdated', version: installedVersion, mode: span.mode }
        : { kind: 'installed', version: installedVersion, mode: span.mode },
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
  assertWritable(filePath, {
    allowOutsideHome: options.allowOutsideHome,
    symlinkBlock: symlinkBlock(options),
  });
  const blockOpts = { withCore: options.withCore === true };
  const read = readValidated(filePath);
  if (read === null) {
    // New file: portable markdown — LF by default. We do NOT pick CRLF on
    // Windows because the content is going into a tool-managed .md file
    // that may be synced to other OSes.
    atomicWrite(filePath, block(VERSION, '\n', blockOpts));
    return `Created ${filePath} and inserted the browser-link instructions block for ${displayName}.`;
  }
  const { text, span } = read;
  const eol = detectEol(text);
  const fresh = block(VERSION, eol, blockOpts);
  if (!span) {
    // Append after exactly one line end (none into an empty file), in the
    // file's dominant line ending. A fixed separator is what lets uninstall
    // give the user's bytes back exactly: it removes that one line end and
    // nothing else, whatever the text ended with.
    const separator = text.length === 0 ? '' : eol;
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
  assertNotSymlink(filePath, symlinkBlock({}));
  const read = readValidated(filePath);
  if (read === null) {
    return `No ${displayName} instructions file at ${filePath}; nothing to remove.`;
  }
  const { text, span } = read;
  if (!span) {
    return `browser-link instructions block was not present in ${filePath}; nothing to remove.`;
  }
  const before = text.slice(0, span.startIndex);
  const after = text.slice(span.endIndex);
  // Every byte that is not ours stays. When the block is the last thing in
  // the file, the one line end install put before it goes too (in the
  // block's own line ending); a block anywhere else is cut out alone.
  const blockEol = text.slice(span.startIndex, span.endIndex).includes('\r\n') ? '\r\n' : '\n';
  const atEnd = after.length === 0 && before.endsWith(blockEol);
  atomicWrite(filePath, (atEnd ? before.slice(0, -blockEol.length) : before) + after);
  return `Removed the browser-link instructions block from ${filePath} (${displayName}).`;
}
