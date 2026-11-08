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

/** Render the instructions text; `opts.notice`, when set, becomes its first
 * line. */
export function buildServerInstructions(opts: CoreOptions = {}): string {
  return renderServerInstructions(opts);
}

/** Usage protocol pushed to the MCP client on `initialize`, without a
 * notice, rendered at module load. */
export const SERVER_INSTRUCTIONS = buildServerInstructions();
