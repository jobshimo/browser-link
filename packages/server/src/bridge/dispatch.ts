/**
 * Pure MCP request handlers — used by both the SDK Server (stdio transport)
 * and the IPC bridge (TCP transport for proxies). Lives in `bridge/` because
 * sharing it with the IPC server was the reason to extract these out of
 * the monolithic server.ts startup.
 *
 * No I/O, no transport, no SDK types — just request data in, response data
 * out. Both callers wrap these results in whatever envelope they need.
 */

import { isToolEnabled } from '../permissions.js';
import { MAP_TOOL_DEFINITIONS, handleMapTool, isMapTool } from '../map/tools.js';
import { BROWSER_TOOL_DEFINITIONS } from '../tools/browser-definitions.js';
import {
  handleBrowserTool,
  isBrowserTool,
  type BrowserToolDeps,
} from '../tools/browser-dispatch.js';
import { toolError, toolResponse } from '../tools/responses.js';
import type { AgentCaller } from '../tools/tab-claims.js';

export interface DispatchDeps {
  browserTools: BrowserToolDeps;
  /** Live deny-list reader. Invoked on every tools/list and tools/call so the
   * dispatcher always reflects the current `config.json` state — changes
   * made via the CLI/UI take effect on the next call without restarting the
   * MCP client. Test fixtures pass a constant function: `() => []`. */
  disabledTools: () => readonly string[];
}

export type { AgentCaller };

/** Mirror of MCP `tools/list` shape. Kept minimal so the IPC layer can
 * forward it as a JSON-RPC result without any SDK-specific transformations. */
export interface ToolsListResult {
  tools: ReadonlyArray<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
}

export function handleToolsList(deps: DispatchDeps): ToolsListResult {
  const disabled = deps.disabledTools();
  return {
    tools: [...BROWSER_TOOL_DEFINITIONS, ...MAP_TOOL_DEFINITIONS].filter((t) =>
      isToolEnabled(t.name, disabled),
    ),
  };
}

export interface ToolCallRequest {
  name: string;
  arguments?: unknown;
  /** Identity of the MCP client whose request this is. The transport layer
   * (primary's stdio handler or IPC server) is responsible for filling it in
   * — handlers that need to enforce per-agent ownership read from here. */
  caller: AgentCaller;
}

export async function handleToolCall(req: ToolCallRequest, deps: DispatchDeps) {
  const { name, arguments: args, caller } = req;
  if (!isToolEnabled(name, deps.disabledTools())) {
    // Defence in depth: a client that cached the previous tools/list could
    // still try to call a now-disabled tool. Refuse with a clear reason.
    return toolError(
      `Tool "${name}" is disabled in this browser-link config. ` +
        `Re-enable it via the setup UI (Permissions) or \`browser-link tools enable ${name}\`.`,
    );
  }
  try {
    if (isMapTool(name)) return toolResponse(handleMapTool(name, args));
    if (isBrowserTool(name))
      return toolResponse(await handleBrowserTool(name, args, deps.browserTools, caller));
    return toolError(`Unknown tool: ${name}`);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}
