/**
 * Typed errors thrown by the agent-instructions file operations. Surfaced
 * in the Ink screen as red banners; the CLI prints them straight to stderr.
 * Keeping them in their own module avoids cycles between file-ops and the
 * UI / command layers that catch them.
 *
 * The guards shared with the MCP config installers (symlink, home directory,
 * strict UTF-8) live in `installers/safe-file.ts`, the one safe path both
 * groups go through; their errors are re-exported here unchanged.
 */

import { END_MARKER } from './content.js';

export {
  InvalidUtf8Error,
  OutsideHomeError,
  SymlinkRefusedError,
} from '../installers/safe-file.js';

/** Why a file holding browser-link markers cannot be edited safely. */
export type CorruptBlockReason = 'multiple-begin-markers' | 'missing-end-marker';

/** Thrown when the target file holds more than one BEGIN marker, or a BEGIN
 * marker with no END marker after it. The installer cannot know which span
 * is ours; the user must resolve it by hand before install/uninstall can
 * proceed. Nothing is changed. `line` is the 1-based line of the orphan
 * BEGIN marker (`missing-end-marker` only). */
export class CorruptBlockError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly reason: CorruptBlockReason,
    public readonly line?: number,
  ) {
    super(
      reason === 'multiple-begin-markers'
        ? `${filePath} contains multiple browser-link instruction blocks ` +
            `(${reason}). Refusing to touch it — please resolve the duplication manually.`
        : `${filePath} has a browser-link begin marker on line ${line ?? '?'} with no end ` +
            'marker after it. Refusing to touch it; nothing was changed. Add the end marker ' +
            `(${END_MARKER}) or remove the begin marker by hand.`,
    );
    this.name = 'CorruptBlockError';
  }
}
