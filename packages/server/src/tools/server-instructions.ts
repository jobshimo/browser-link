/**
 * The MCP `initialize.instructions` payload. The text itself lives in the
 * agent manual (`../manual/`): the hand-written core first, then one section
 * per tool rendered from the `doc` block each tool definition carries.
 *
 * `SERVER_INSTRUCTIONS` is computed once at module load (no notice) and kept
 * as a plain string so the existing consumers (`server.ts`,
 * `bridge/server.ts`) keep working; `buildServerInstructions` renders it on
 * demand, optionally with a one-line notice placed before the core.
 */

import { renderServerInstructions } from '../manual/render.js';
import type { CoreOptions } from '../manual/core.js';
import { detectInstructionsStatus, type ClientInstructionsStatus } from '../manual/status.js';
import { refreshNotice, refreshOutdatedBlocks, type RefreshFailure } from '../manual/refresh.js';
import {
  INSTRUCTIONS_INSTALLERS,
  type InstructionsInstaller,
} from '../agent-instructions/index.js';

/** Render the instructions text; `opts.notice`, when set, becomes its first
 * line. */
export function buildServerInstructions(opts: CoreOptions = {}): string {
  return renderServerInstructions(opts);
}

/** Usage protocol pushed to the MCP client on `initialize`, without a
 * notice, rendered at module load. */
export const SERVER_INSTRUCTIONS = buildServerInstructions();

/** The instructions the primary serves, built at start: detects each
 * client's block, refreshes in place every block that is
 * `installed-outdated` (unless `opts.autoRefresh` is false; see
 * `manual/refresh.ts`), and, when a block was refreshed or is still
 * outdated, puts the notice first so the agent sees it. Returns the
 * post-refresh statuses and the refresh outcome so the caller can log them.
 * `installers` defaults to the real clients; tests inject stubs. */
export function buildStartInstructions(
  installers: readonly InstructionsInstaller[] = INSTRUCTIONS_INSTALLERS,
  opts: { autoRefresh?: boolean } = {},
): {
  statuses: ClientInstructionsStatus[];
  refreshed: ClientInstructionsStatus[];
  failed: RefreshFailure[];
  text: string;
} {
  const result = refreshOutdatedBlocks({
    statuses: detectInstructionsStatus(installers),
    installers,
    enabled: opts.autoRefresh !== false,
  });
  const notice = refreshNotice(result);
  return { ...result, text: notice ? buildServerInstructions({ notice }) : SERVER_INSTRUCTIONS };
}
