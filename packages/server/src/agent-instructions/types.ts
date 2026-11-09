import type { ClientId } from '../installers/types.js';

/** Re-export so consumers can stick to one ClientId import. */
export type { ClientId };

/** What an installed block holds: the short trigger only (default), or the
 * trigger plus the core rules (`browser-link instructions install --with-core`).
 * Read from the mode marker inside the block; a block without one (written
 * before modes existed) reads as `trigger`. */
export type InstructionsMode = 'trigger' | 'core';

/** Options for writing the block. */
export interface InstallOptions {
  /** Keep the core rules in the block after the trigger. */
  withCore?: boolean;
}

/** Possible states of the instructions block in the client's markdown file. */
export type InstructionsState =
  | { kind: 'no-file' } // the client's instructions file does not exist
  | { kind: 'not-installed' } // file exists, no browser-link block
  | { kind: 'installed'; version: string | null; mode?: InstructionsMode } // file exists, block present; null = legacy unversioned
  | { kind: 'installed-outdated'; version: string | null; mode?: InstructionsMode } // block present, older than current; null = legacy unversioned
  | { kind: 'corrupt'; reason: 'multiple-begin-markers' }; // file has more than one BEGIN marker — refuse to touch it

export interface InstructionsDetect {
  /** Absolute path to the markdown file we manage. Returned even when it does not exist. */
  filePath: string;
  /** State of the block in that file. */
  state: InstructionsState;
}

export interface InstructionsInstaller {
  id: ClientId;
  displayName: string;

  /** Absolute path to the markdown file we manage for this client. */
  filePath(): string;

  /** Inspect the file and report the state of the browser-link block. */
  detect(): InstructionsDetect;

  /**
   * Insert / refresh the browser-link block in the file. Idempotent: if the
   * block is already present, the body is rewritten in place; the file is
   * created if it does not exist. Without `withCore` the block holds the
   * trigger only. Returns a one-line description of what changed.
   */
  install(opts?: InstallOptions): string;

  /**
   * Remove the browser-link block from the file. Leaves every other line
   * intact. Idempotent: a missing file or missing block is a no-op.
   */
  uninstall(): string;
}
