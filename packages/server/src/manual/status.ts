/**
 * Read-only status of the installed instructions block, per client, shared
 * by the primary's start-time notice (`server.ts`) and the `browser.manual`
 * index. Detection only reads the clients' instructions files through each
 * installer's `detect()` (home-guarded as the installers already are); this
 * module never writes anything.
 */

import { VERSION } from '../version.js';
import {
  INSTRUCTIONS_INSTALLERS,
  type ClientId,
  type InstructionsInstaller,
  type InstructionsState,
} from '../agent-instructions/index.js';

export interface ClientInstructionsStatus {
  id: ClientId;
  displayName: string;
  state: InstructionsState;
}

/** Detect every client's block. A client whose detection throws (permissions,
 * EBADF) is skipped, never fatal. */
export function detectInstructionsStatus(
  installers: readonly InstructionsInstaller[] = INSTRUCTIONS_INSTALLERS,
): ClientInstructionsStatus[] {
  const out: ClientInstructionsStatus[] = [];
  for (const installer of installers) {
    try {
      const { state } = installer.detect();
      out.push({ id: installer.id, displayName: installer.displayName, state });
    } catch {
      /* best effort: an unreadable client is left out */
    }
  }
  return out;
}

const v = (version: string | null): string => (version === null ? 'unversioned' : `v${version}`);

/** One status line for the `browser.manual` index. */
export function formatClientStatus(s: ClientInstructionsStatus, version = VERSION): string {
  const { state } = s;
  switch (state.kind) {
    case 'installed':
      return `${s.displayName}: installed ${v(state.version)}`;
    case 'installed-outdated':
      return `${s.displayName}: installed-outdated ${v(state.version)} → v${version}: run browser-link instructions install`;
    case 'corrupt':
      return `${s.displayName}: corrupt (${state.reason})`;
    default:
      return `${s.displayName}: ${state.kind}`;
  }
}

/** The one-line notice placed before the core when a client's block exists
 * and is older than the server (`installed-outdated`); `undefined` otherwise.
 * A client without a block (`not-installed`, `no-file`) is a choice and a
 * `corrupt` file is the CLI's business: neither ever produces a notice. */
export function instructionsNotice(
  statuses: readonly ClientInstructionsStatus[],
  version = VERSION,
): string | undefined {
  for (const s of statuses) {
    if (s.state.kind === 'installed-outdated') {
      return `Your browser-link instructions block is installed-outdated (installed ${v(s.state.version)}, server v${version}): run \`browser-link instructions install\` and restart the client.`;
    }
  }
  return undefined;
}
