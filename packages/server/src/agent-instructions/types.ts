import type { ClientId } from '../installers/types.js';

/** Re-export so consumers can stick to one ClientId import. */
export type { ClientId };

/** Possible states of the instructions block in the client's markdown file. */
export type InstructionsState =
  | { kind: 'no-file' } // the client's instructions file does not exist
  | { kind: 'not-installed' } // file exists, no browser-link block
  | { kind: 'installed'; version: string } // file exists, block present
  | { kind: 'installed-outdated'; version: string }; // block present, version older than current

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
   * created if it does not exist. Returns a one-line description of what
   * changed.
   */
  install(): string;

  /**
   * Remove the browser-link block from the file. Leaves every other line
   * intact. Idempotent: a missing file or missing block is a no-op.
   */
  uninstall(): string;
}
