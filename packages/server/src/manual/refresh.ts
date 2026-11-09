/**
 * Start-time refresh of the installed instructions block. A client whose
 * block exists but is older than the server (`installed-outdated`) is
 * refreshed in place through its installer's `install()` — the same write
 * path `browser-link instructions install` uses (`installAt`: atomic,
 * home-guarded, refuses a corrupt file). The prior install is the opt-in: a
 * client without a block (`not-installed`, `no-file`) or with a `corrupt`
 * file is never touched.
 *
 * Pure apart from the installers it is handed, so tests drive it with stubs.
 */

import { VERSION } from '../version.js';
import type { ClientId, InstructionsInstaller } from '../agent-instructions/index.js';
import { instructionsNotice, type ClientInstructionsStatus } from './status.js';

export interface RefreshFailure {
  id: ClientId;
  displayName: string;
  message: string;
}

export interface RefreshResult {
  /** Every client's status after the refresh (a failed client keeps its
   * `installed-outdated` state). */
  statuses: ClientInstructionsStatus[];
  /** Clients whose block was rewritten, with their post-refresh status. */
  refreshed: ClientInstructionsStatus[];
  failed: RefreshFailure[];
}

export function refreshOutdatedBlocks(input: {
  statuses: readonly ClientInstructionsStatus[];
  installers: readonly InstructionsInstaller[];
  enabled: boolean;
}): RefreshResult {
  const { installers, enabled } = input;
  const refreshed: ClientInstructionsStatus[] = [];
  const failed: RefreshFailure[] = [];
  const statuses = input.statuses.map((s) => {
    if (!enabled || s.state.kind !== 'installed-outdated') return s;
    const installer = installers.find((i) => i.id === s.id);
    if (installer === undefined) return s;
    try {
      installer.install();
      const after: ClientInstructionsStatus = { ...s, state: installer.detect().state };
      refreshed.push(after);
      return after;
    } catch (err) {
      failed.push({
        id: s.id,
        displayName: s.displayName,
        message: err instanceof Error ? err.message : String(err),
      });
      return s;
    }
  });
  return { statuses, refreshed, failed };
}

/** The one-line connect-time notice after a refresh: the update notice when
 * at least one block was rewritten, then the `installed-outdated` notice for
 * any block still outdated, with the failure reasons appended. `undefined`
 * when there is nothing to say. */
export function refreshNotice(result: RefreshResult, version = VERSION): string | undefined {
  const parts: string[] = [];
  if (result.refreshed.length > 0) {
    const names = result.refreshed.map((s) => s.displayName).join(', ');
    parts.push(
      `Your browser-link instructions block was updated to v${version} for ${names}: restart the client to load it.`,
    );
  }
  const outdated = instructionsNotice(result.statuses, version);
  if (outdated !== undefined) parts.push(outdated);
  if (result.failed.length > 0) {
    const reasons = result.failed.map((f) => `${f.displayName}: ${f.message}`).join('; ');
    parts.push(`Automatic refresh failed for ${reasons}`);
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}
