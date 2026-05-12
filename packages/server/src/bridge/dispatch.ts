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

export interface DispatchDeps {
  browserTools: BrowserToolDeps;
  disabledTools: readonly string[];
}

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
  return {
    tools: [...BROWSER_TOOL_DEFINITIONS, ...MAP_TOOL_DEFINITIONS].filter((t) =>
      isToolEnabled(t.name, deps.disabledTools),
    ),
  };
}

export interface ToolCallRequest {
  name: string;
  arguments?: unknown;
}

export async function handleToolCall(req: ToolCallRequest, deps: DispatchDeps) {
  const { name, arguments: args } = req;
  if (!isToolEnabled(name, deps.disabledTools)) {
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
      return toolResponse(await handleBrowserTool(name, args, deps.browserTools));
    return toolError(`Unknown tool: ${name}`);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}
