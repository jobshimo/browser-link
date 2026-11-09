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
  outdatedServerHint,
  type BrowserToolDeps,
} from '../tools/browser-dispatch.js';
import {
  hintToolResponse,
  imageToolResponse,
  toolError,
  toolResponse,
} from '../tools/responses.js';
import { buildEmptyTabsHint } from '../tools/empty-tabs-hint.js';
import type { AgentCaller } from '../tools/tab-claims.js';
import { buildActivityRow } from '../activity/extract.js';
import { rememberTypedValue, typedTextsOf } from '../map/readers.js';
import {
  beginToolCall,
  noteOrigin,
  notePendingWork,
  noteTypedValue,
  peekSession,
} from '../map/session.js';
import { renderCore } from '../manual/core.js';
import type { ToolResponse } from '../tools/responses.js';

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
  // The JS registry refuses to store an evaluate expression that contains
  // something the agent typed, and curation (rule 7) refuses to keep it. They
  // can only know what was typed if they are told here, before the call
  // runs. In memory only; never written anywhere.
  for (const text of typedValuesOf(name, args)) {
    rememberTypedValue(text);
    noteTypedValue(caller.agent_id, text);
  }
  const browserCall = isMapTool(name) || isBrowserTool(name);
  // knowledge-loop S13: the first browser call of a session returns the
  // rules as a second text block, whatever the tool.
  const firstCall = browserCall && beginToolCall(caller.agent_id);
  const finish = (response: ToolResponse): ToolResponse => {
    if (browserCall) noteTabOrigin(args, caller, deps);
    return firstCall ? withRulesBlock(response) : response;
  };
  try {
    if (isMapTool(name)) {
      return finish(
        toolResponse(withPendingWrapUp(recordedMapTool(name, args, caller, deps), caller)),
      );
    }
    if (isBrowserTool(name)) {
      const raw = await handleBrowserTool(name, args, deps.browserTools, caller);
      if (isPendingWork(name, args, raw)) notePendingWork(caller.agent_id);
      const result = withPendingWrapUp(raw, caller);
      if (name === 'browser.screenshot') return finish(imageToolResponse(result));
      // list_tabs explains itself in a second block; the first stays the
      // bare array every client already parses. An empty list gets the
      // reconnect hint; a server older than the installed one gets the
      // outdated-server hint (S3b, 0.41.0). Both may apply.
      if (name === 'browser.list_tabs' && Array.isArray(result)) {
        const hints: string[] = [];
        if (result.length === 0) {
          const events = deps.browserTools.recentEvents?.({ limit: 200 });
          if (events) hints.push(buildEmptyTabsHint(events, Date.now()));
        }
        const outdated = outdatedServerHint();
        if (outdated) hints.push(outdated);
        if (hints.length > 0) return finish(hintToolResponse(result, hints.join('\n')));
      }
      return finish(toolResponse(result));
    }
    return toolError(`Unknown tool: ${name}`);
  } catch (err) {
    return finish(toolError(err instanceof Error ? err.message : String(err)));
  }
}

/** Title of the rules block (S13). */
export const RULES_BLOCK_TITLE = 'browser-link rules:';

/** Append the core rules as one more text block. The blocks before it are
 * untouched, so clients that parse the first one are unaffected. */
function withRulesBlock(response: ToolResponse): ToolResponse {
  return {
    ...response,
    content: [
      ...response.content,
      { type: 'text', text: `${RULES_BLOCK_TITLE}\n${renderCore({})}` },
    ],
  };
}

/** What a call types or fills in (`type` text, flow `type` steps, `values`
 * of `flow` and `read`). */
function typedValuesOf(name: string, args: unknown): string[] {
  if (name === 'browser.type' && typeof args === 'object' && args !== null) {
    const text = (args as { text?: unknown }).text;
    return typeof text === 'string' && text.length > 0 ? [text] : [];
  }
  if (name === 'browser.flow' || name === 'browser.read') return typedTextsOf(args);
  return [];
}

/** A successful `evaluate`, or a real (not dry-run) flow that came back
 * `ok: true`: work `browser.wrap_up` should look at. */
function isPendingWork(name: string, args: unknown, result: unknown): boolean {
  if (name === 'browser.evaluate') return true;
  if (name !== 'browser.flow') return false;
  if ((args as { dry_run?: unknown } | undefined)?.dry_run === true) return false;
  return typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === true;
}

/** Add `pending_wrap_up: n` to an object result while the session has work
 * waiting for `browser.wrap_up` (S9). Raw values and arrays are returned
 * untouched; with nothing pending the result is unchanged. */
function withPendingWrapUp(result: unknown, caller: AgentCaller): unknown {
  const pending = peekSession(caller.agent_id)?.pendingWrapUp ?? 0;
  if (pending <= 0) return result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;
  return { ...(result as Record<string, unknown>), pending_wrap_up: pending };
}

/** Remember the origin of the tab a call addressed (after the call, so a
 * navigate counts where it landed). Never throws. */
function noteTabOrigin(args: unknown, caller: AgentCaller, deps: DispatchDeps): void {
  try {
    const tabId = (args as { tab_id?: unknown } | undefined)?.tab_id;
    if (typeof tabId !== 'string' || tabId.length === 0) return;
    const tab = deps.browserTools.listTabs().find((t) => t.tab_id === tabId);
    if (!tab) return;
    noteOrigin(caller.agent_id, new URL(tab.url).origin);
  } catch {
    // An unparsable URL (about:blank) is simply not an app.
  }
}

/**
 * Run a map tool and leave a trail row for it, like every browser tool.
 *
 * Map tools are answered here, not by `handleBrowserTool`, so they never
 * passed through its recording wrapper and the trail could not say how often
 * the map was read or written. Same contract as that wrapper: the result is
 * returned and the error rethrown untouched, and recording can never break
 * the call (a row that fails to build is a row not written).
 */
function recordedMapTool(
  name: string,
  args: unknown,
  caller: AgentCaller,
  deps: DispatchDeps,
): unknown {
  const tools = deps.browserTools;
  if (!tools.recordActivity) return handleMapTool(name, args);
  const startedAt = Date.now();
  const write = (settled: { result: unknown } | { error: unknown }): void => {
    try {
      tools.recordActivity?.(
        buildActivityRow(args, {
          tool: name,
          caller,
          durationMs: Date.now() - startedAt,
          ...settled,
          agentId: caller.agent_id,
          recordPayloads: tools.recordActivityPayloads !== false,
        }),
      );
    } catch {
      // Observation must never break the observed.
    }
  };
  try {
    const result = handleMapTool(name, args);
    write({ result });
    return result;
  } catch (error) {
    write({ error: error ?? new Error('unknown error') });
    throw error;
  }
}
