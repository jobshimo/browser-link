import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import type { ExtensionToServer, ServerToExtension } from './messages.js';
import { MAP_TOOL_DEFINITIONS, handleMapTool, isMapTool } from './map/tools.js';
import { closeDb } from './map/db.js';
import { BROWSER_TOOL_DEFINITIONS } from './tools/browser-definitions.js';
import {
  type BrowserToolDeps,
  type TabSnapshot,
  handleBrowserTool,
  isBrowserTool,
} from './tools/browser-dispatch.js';
import { toolError, toolResponse } from './tools/responses.js';
import { SERVER_INSTRUCTIONS } from './tools/server-instructions.js';

export const WS_HOST = '127.0.0.1';
export const WS_PORT = 17529;
const DEFAULT_TIMEOUT_MS = 15_000;

interface TabSession {
  tabId: string;
  url: string;
  title: string;
  ws: WebSocket;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

function log(msg: string): void {
  console.error(`[browser-link] ${msg}`);
}

function safeParse(raw: string): ExtensionToServer | null {
  try {
    return JSON.parse(raw) as ExtensionToServer;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, msg: ServerToExtension): void {
  ws.send(JSON.stringify(msg));
}

/** Bring up the WebSocket bridge for the Chrome extension. Resolves only
 * after the server is listening, so the caller can fail fast (and refuse
 * to expose the MCP transport) when the port is taken or any other bind
 * error happens. */
function startWsBridge(
  tabs: Map<string, TabSession>,
  pendingRequests: Map<string, PendingRequest>,
): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT });

    let settled = false;

    wss.on('listening', () => {
      settled = true;
      log(`WebSocket listening on ws://${WS_HOST}:${WS_PORT}`);
      resolve(wss);
    });

    wss.on('error', (err: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        reject(translateBindError(err));
        return;
      }
      // Post-listening errors: log but keep running; ws will emit per-connection
      // errors separately.
      log(`WebSocket server error: ${err.message}`);
    });

    wss.on('connection', (ws) => {
      let assignedTabId: string | null = null;

      ws.on('message', (raw) => {
        const msg = safeParse(raw.toString());
        if (!msg) return;

        if (msg.kind === 'tab.register' && !assignedTabId) {
          assignedTabId = assignTabId();
          tabs.set(assignedTabId, {
            tabId: assignedTabId,
            url: msg.payload.url,
            title: msg.payload.title,
            ws,
          });
          send(ws, { kind: 'tab.registered', payload: { tabId: assignedTabId } });
          log(`Tab registered: ${assignedTabId} -> ${msg.payload.url}`);
          return;
        }

        if (msg.kind === 'tool.response') {
          const pending = pendingRequests.get(msg.id);
          if (!pending) return;
          clearTimeout(pending.timeout);
          pendingRequests.delete(msg.id);
          if (msg.ok) pending.resolve(msg.result);
          else pending.reject(new Error(msg.error));
        }
      });

      ws.on('close', () => {
        if (assignedTabId) {
          tabs.delete(assignedTabId);
          log(`Tab disconnected: ${assignedTabId}`);
        }
      });

      ws.on('error', (err) => {
        log(`WS connection error: ${err.message}`);
      });
    });
  });
}

let tabIdCounter = 0;
function assignTabId(): string {
  tabIdCounter += 1;
  return `tab_${tabIdCounter}`;
}

function translateBindError(err: NodeJS.ErrnoException): Error {
  if (err.code === 'EADDRINUSE') {
    return new Error(
      `browser-link: port ${WS_HOST}:${WS_PORT} is already in use. ` +
        `Another browser-link server is likely running. Stop it (and any ` +
        `\`npm run dev\` running this project) before launching this one.`,
    );
  }
  return err;
}

function buildCallBrowserTool(
  tabs: Map<string, TabSession>,
  pendingRequests: Map<string, PendingRequest>,
): BrowserToolDeps['callBrowserTool'] {
  return (tabId, tool, params, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const session = tabs.get(tabId);
    if (!session) return Promise.reject(new Error(`Tab not connected: ${tabId}`));
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Tool '${tool}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timeout });
      send(session.ws, { kind: 'tool.request', id, tool, params });
    });
  };
}

function buildListTabs(tabs: Map<string, TabSession>): () => TabSnapshot[] {
  return () =>
    Array.from(tabs.values()).map((t) => ({
      tab_id: t.tabId,
      url: t.url,
      title: t.title,
    }));
}

/** Start the MCP server (stdio transport) and the WebSocket bridge.
 * Resolves only when both are ready. If the WebSocket bind fails the
 * MCP transport is never exposed and the caller sees a clear error. */
export async function runServer(): Promise<void> {
  const tabs = new Map<string, TabSession>();
  const pendingRequests = new Map<string, PendingRequest>();

  // Bind the WS bridge first. If this throws, runServer() rejects and the
  // MCP client receives a fail-fast exit instead of a half-started server.
  await startWsBridge(tabs, pendingRequests);

  const deps: BrowserToolDeps = {
    listTabs: buildListTabs(tabs),
    callBrowserTool: buildCallBrowserTool(tabs, pendingRequests),
  };

  const mcpServer = new Server(
    { name: 'browser-link', version: '0.0.1' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...BROWSER_TOOL_DEFINITIONS, ...MAP_TOOL_DEFINITIONS],
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      if (isMapTool(name)) return toolResponse(handleMapTool(name, args));
      if (isBrowserTool(name)) return toolResponse(await handleBrowserTool(name, args, deps));
      return toolError(`Unknown tool: ${name}`);
    } catch (err) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  });

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log('MCP server ready on stdio');

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      closeDb();
      process.exit(0);
    });
  }
}
