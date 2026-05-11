import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import type { ExtensionToServer, ServerToExtension } from '@browser-link/shared';
import { MAP_TOOL_DEFINITIONS, handleMapTool, isMapTool } from './map/tools.js';
import { closeDb } from './map/db.js';

const WS_HOST = '127.0.0.1';
const WS_PORT = 17529;
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

const tabs = new Map<string, TabSession>();
const pendingRequests = new Map<string, PendingRequest>();
let tabIdCounter = 0;

function assignTabId(): string {
  tabIdCounter += 1;
  return `tab_${tabIdCounter}`;
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

const wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT });

wss.on('listening', () => {
  log(`WebSocket listening on ws://${WS_HOST}:${WS_PORT}`);
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
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error));
      }
    }
  });

  ws.on('close', () => {
    if (assignedTabId) {
      tabs.delete(assignedTabId);
      log(`Tab disconnected: ${assignedTabId}`);
    }
  });

  ws.on('error', (err) => {
    log(`WS error: ${err.message}`);
  });
});

function callBrowserTool(
  tabId: string,
  tool: string,
  params: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const session = tabs.get(tabId);
  if (!session) {
    return Promise.reject(new Error(`Tab not connected: ${tabId}`));
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Tool '${tool}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timeout });
    send(session.ws, { kind: 'tool.request', id, tool, params });
  });
}

const SERVER_INSTRUCTIONS = `browser-link bridges Claude to a Chrome tab and ships a persistent UI map
backed by a local SQLite DB at \$XDG_DATA_HOME/browser-link/map.db (default ~/.browser-link/map.db).
The map is private and per-machine; never persisted in any repo.

## When operating on a tab

1. Before doing anything on a tab whose URL you don't already know,
   call \`browser.map.recall\` with { origin } (and optionally url) to load
   selectors, flows and gotchas previously learned for that app.
2. If recall returns entries with \`failed_at\` more recent than
   \`verified_at\`, treat them as suspect: re-verify (snapshot / evaluate)
   before reusing, or replace them.
3. After every interaction that used a map entry, call
   \`browser.map.record_use\` with { entry_id, ok }. ok=true updates
   verified_at; ok=false updates failed_at. Keep the map honest.
4. After a non-trivial flow that worked end-to-end, persist it with
   \`browser.map.save\`. Three \`kind\` values:
   - selector: { selector, evidence? } — a CSS selector tied to a purpose.
   - flow: { steps: [...] } — an ordered list of actions to reach an outcome.
   - gotcha: { body } — free-form note about something non-obvious.
   Use \`url_pattern\` = pathname (exact). Promote to glob only if you have
   evidence of a parametric route. Provide \`purpose\` as a stable, reusable
   label ("open task detail dialog", not "open IB0311 detail").
5. Never save selectors or flows you have not just successfully executed.
6. Never store domain data (IDs, user names, dates, etc.). The map captures
   UI structure only.

## Identifying the app

- \`origin\` = scheme://host:port of the tab.
- \`app_key\` distinguishes apps that share an origin over time. On first
  save you may omit it; it will be derived from the page title (slugified).
  Use \`browser.map.rename_app\` if that initial guess is poor.

## When something is wrong

- A selector from recall fails → record_use({ok:false}), learn the new
  one, save it (upsert on purpose).
- A whole app got refactored → \`browser.map.forget\` the app_id and let
  the map repopulate as you learn the new structure.

The map is a cache of navigation, not a substitute for \`browser.snapshot\`.
The live snapshot is always the source of truth.`;

const mcpServer = new Server(
  { name: 'browser-link', version: '0.0.1' },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
);

function toolResponse(data: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
  };
}

function toolError(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function requireTabId(args: unknown): string {
  const id = (args as { tab_id?: string } | undefined)?.tab_id;
  if (!id) throw new Error('tab_id required');
  return id;
}

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'browser.list_tabs',
      description:
        'List Chrome tabs currently connected to browser-link. A tab is connected only after the user clicks Conectar in the extension popup. Returns tab_id, url and title for each.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'browser.ping',
      description: 'Verify the bridge to a tab. Returns its current title and url.',
      inputSchema: {
        type: 'object',
        properties: { tab_id: { type: 'string' } },
        required: ['tab_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'browser.navigate',
      description: 'Navigate the connected tab to a URL. By default waits for the load event.',
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: { type: 'string' },
          url: { type: 'string', description: 'Full URL including protocol.' },
          wait_for_load: { type: 'boolean', default: true },
        },
        required: ['tab_id', 'url'],
        additionalProperties: false,
      },
    },
    {
      name: 'browser.snapshot',
      description:
        'Snapshot of the tab: title, url, visible text (truncated) and a list of interactive elements (buttons, links, inputs, selects, textareas) with a CSS selector and labels. Use this to understand page state before clicking or typing.',
      inputSchema: {
        type: 'object',
        properties: { tab_id: { type: 'string' } },
        required: ['tab_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'browser.console',
      description:
        'Return recent console messages (log, info, warn, error) from the connected tab since it was attached. Rolling buffer (last 200).',
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: { type: 'string' },
          level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'] },
        },
        required: ['tab_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'browser.network',
      description:
        'Return recent network requests from the connected tab (rolling buffer, last 200). Includes request_id, method, url, status, mime, size, timing. Use browser.network_body to fetch the body of a specific request.',
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: { type: 'string' },
          url_filter: { type: 'string', description: 'Optional substring to filter request URLs.' },
        },
        required: ['tab_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'browser.network_body',
      description: 'Fetch the response body of a single network request by request_id (from browser.network).',
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: { type: 'string' },
          request_id: { type: 'string' },
        },
        required: ['tab_id', 'request_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'browser.click',
      description:
        'Click an element by CSS selector in the connected tab. The selector usually comes from browser.snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: { type: 'string' },
          selector: { type: 'string' },
        },
        required: ['tab_id', 'selector'],
        additionalProperties: false,
      },
    },
    {
      name: 'browser.type',
      description:
        'Focus an input by CSS selector and type text into it. If clear=true, clears the current value first.',
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: { type: 'string' },
          selector: { type: 'string' },
          text: { type: 'string' },
          clear: { type: 'boolean', default: false },
        },
        required: ['tab_id', 'selector', 'text'],
        additionalProperties: false,
      },
    },
    {
      name: 'browser.evaluate',
      description:
        'Run a JavaScript expression in the page context and return its result. Use an IIFE with return if you need multi-step logic.',
      inputSchema: {
        type: 'object',
        properties: {
          tab_id: { type: 'string' },
          expression: { type: 'string' },
        },
        required: ['tab_id', 'expression'],
        additionalProperties: false,
      },
    },
    ...MAP_TOOL_DEFINITIONS,
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    if (isMapTool(name)) {
      return toolResponse(handleMapTool(name, args));
    }

    if (name === 'browser.list_tabs') {
      const list = Array.from(tabs.values()).map((t) => ({
        tab_id: t.tabId,
        url: t.url,
        title: t.title,
      }));
      return toolResponse(list);
    }

    const tabId = requireTabId(args);

    if (name === 'browser.ping') {
      return toolResponse(await callBrowserTool(tabId, 'ping', {}));
    }
    if (name === 'browser.navigate') {
      const { url, wait_for_load = true } = args as { url: string; wait_for_load?: boolean };
      return toolResponse(await callBrowserTool(tabId, 'navigate', { url, wait_for_load }, 30_000));
    }
    if (name === 'browser.snapshot') {
      return toolResponse(await callBrowserTool(tabId, 'snapshot', {}));
    }
    if (name === 'browser.console') {
      const { level } = (args as { level?: string }) ?? {};
      return toolResponse(await callBrowserTool(tabId, 'console', { level }));
    }
    if (name === 'browser.network') {
      const { url_filter } = (args as { url_filter?: string }) ?? {};
      return toolResponse(await callBrowserTool(tabId, 'network', { url_filter }));
    }
    if (name === 'browser.network_body') {
      const { request_id } = args as { request_id: string };
      return toolResponse(await callBrowserTool(tabId, 'network_body', { request_id }));
    }
    if (name === 'browser.click') {
      const { selector } = args as { selector: string };
      return toolResponse(await callBrowserTool(tabId, 'click', { selector }));
    }
    if (name === 'browser.type') {
      const { selector, text, clear = false } = args as { selector: string; text: string; clear?: boolean };
      return toolResponse(await callBrowserTool(tabId, 'type', { selector, text, clear }));
    }
    if (name === 'browser.evaluate') {
      const { expression } = args as { expression: string };
      return toolResponse(await callBrowserTool(tabId, 'evaluate', { expression }));
    }

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
