/**
 * Typed errors thrown by the agent-instructions file operations. Surfaced
 * in the Ink screen as red banners; the CLI prints them straight to stderr.
 * Keeping them in their own module avoids cycles between file-ops and the
 * UI / command layers that catch them.
 */

/** Thrown when the target file is a symlink. We refuse to write through
 * symlinks because the user's intent is ambiguous: editing the target
 * may not be what they meant when they installed the symlink. The error
 * message embeds a paste-ready block so the user can install it manually
 * in the resolved target. */
export class SymlinkRefusedError extends Error {
  constructor(
    public readonly source: string,
    public readonly target: string,
    public readonly blockContent: string,
  ) {
    super(
      `${source} is a symlink to ${target}. Refusing to write through it. ` +
        `Paste the block below into ${target} manually:\n\n${blockContent}`,
    );
    this.name = 'SymlinkRefusedError';
  }
}

/** Thrown when the target file contains more than one BEGIN marker. The
 * installer cannot know which span to refresh; the user must resolve the
 * duplication by hand before install/uninstall can proceed. */
export class CorruptBlockError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly reason: 'multiple-begin-markers',
  ) {
    super(
      `${filePath} contains multiple browser-link instruction blocks ` +
        `(${reason}). Refusing to touch it — please resolve the duplication manually.`,
    );
    this.name = 'CorruptBlockError';
  }
}
