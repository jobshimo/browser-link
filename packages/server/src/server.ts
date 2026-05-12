import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import type { ExtensionToServer, ServerToExtension } from './messages.js';
import { closeDb } from './map/db.js';
import { isAllowedBrowser } from './auth/allowlist.js';
import { lookupPeerProcess } from './auth/process-identity.js';
import { type BrowserToolDeps, type TabSnapshot } from './tools/browser-dispatch.js';
import { SERVER_INSTRUCTIONS } from './tools/server-instructions.js';
import { loadConfig } from './config.js';
import { handleToolCall, handleToolsList, type DispatchDeps } from './bridge/dispatch.js';
import { IpcServer } from './bridge/server.js';
import { runProxy } from './bridge/client.js';
import { BridgeEventLog } from './bridge/events.js';
import { TabClaimRegistry, type AgentCaller } from './tools/tab-claims.js';

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
/**
 * Loopback-only addresses can show up as ::ffff:127.0.0.1 (IPv4-mapped IPv6)
 * or ::1 depending on how the kernel exposes the dual stack. Normalise to the
 * IPv4 form lsof / netstat understand.
 */
function normaliseLoopback(addr: string): string {
  if (addr === '::1' || addr === '::ffff:127.0.0.1') return '127.0.0.1';
  if (addr.startsWith('::ffff:')) return addr.slice('::ffff:'.length);
  return addr;
}

function startWsBridge(
  tabs: Map<string, TabSession>,
  pendingRequests: Map<string, PendingRequest>,
  events: BridgeEventLog,
): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host: WS_HOST,
      port: WS_PORT,
      // Refuse the upgrade unless the OS confirms the peer is a Chromium-based
      // browser. The check happens before any application bytes are exchanged.
      verifyClient: (info, cb) => {
        const remoteAddress = normaliseLoopback(info.req.socket.remoteAddress ?? '');
        const remotePort = info.req.socket.remotePort;
        if (!remoteAddress || remotePort == null) {
          log('Rejected WS handshake: peer address/port not exposed by socket.');
          cb(false, 403, 'Cannot identify peer');
          return;
        }
        lookupPeerProcess(remoteAddress, remotePort)
          .then((peer) => {
            if (!peer) {
              log(
                `Rejected WS handshake from ${remoteAddress}:${remotePort}: could not identify owning process.`,
              );
              cb(false, 403, 'Peer process unknown');
              return;
            }
            if (!isAllowedBrowser(peer.binaryName)) {
              log(
                `Rejected WS handshake from PID ${peer.pid} (${peer.binaryName}): not a Chromium-based browser.`,
              );
              cb(false, 403, 'Peer is not a Chromium-based browser');
              return;
            }
            cb(true);
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log(`Rejected WS handshake: process lookup failed (${msg}).`);
            cb(false, 500, 'Process lookup failed');
          });
      },
    });

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
          // The extension may pass `previousTabId` so we can preserve the
          // browser-link tab id across primary swaps. We honour it when it
          // is free; otherwise we assign a new id and emit `tab-renamed`
          // so the agent can recover.
          const previousTabId =
            typeof msg.payload.previousTabId === 'string' ? msg.payload.previousTabId : undefined;
          if (previousTabId && !tabs.has(previousTabId) && /^tab_\d+$/.test(previousTabId)) {
            assignedTabId = previousTabId;
            // Bump the counter so future fresh assignments don't collide.
            const n = parseInt(previousTabId.slice('tab_'.length), 10);
            if (Number.isFinite(n) && n > tabIdCounter) tabIdCounter = n;
          } else {
            assignedTabId = assignTabId();
          }
          tabs.set(assignedTabId, {
            tabId: assignedTabId,
            url: msg.payload.url,
            title: msg.payload.title,
            ws,
          });
          send(ws, { kind: 'tab.registered', payload: { tabId: assignedTabId } });
          log(`Tab registered: ${assignedTabId} -> ${msg.payload.url}`);
          if (previousTabId && previousTabId !== assignedTabId) {
            events.add('tab-renamed', {
              previous: previousTabId,
              current: assignedTabId,
              url: msg.payload.url,
              title: msg.payload.title,
            });
            log(`Tab id renamed: ${previousTabId} -> ${assignedTabId}`);
          } else {
            events.add('tab-registered', {
              tabId: assignedTabId,
              url: msg.payload.url,
              title: msg.payload.title,
            });
          }
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
          events.add('tab-disconnected', { tabId: assignedTabId });
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

/** Sentinel error used by runServer() to detect a port-in-use and decide
 * whether to fall back to proxy mode. Anything else propagates unchanged. */
class AddrInUseError extends Error {
  constructor() {
    super(`browser-link: port ${WS_HOST}:${WS_PORT} is already in use.`);
    this.name = 'AddrInUseError';
  }
}

function translateBindError(err: NodeJS.ErrnoException): Error {
  if (err.code === 'EADDRINUSE') return new AddrInUseError();
  return err;
}

function isAddrInUse(err: unknown): boolean {
  return err instanceof AddrInUseError;
}

function buildCallBrowserTool(
  tabs: Map<string, TabSession>,
  pendingRequests: Map<string, PendingRequest>,
): BrowserToolDeps['callBrowserTool'] {
  return (tabId, tool, params, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const session = tabs.get(tabId);
    if (!session) {
      // Auto-hint pointing the agent at `browser.events`. The event log
      // tracks tab-renamed entries that explain stale tab_ids after a
      // primary swap, so the agent can self-recover instead of failing.
      return Promise.reject(
        new Error(
          `Tab not connected: ${tabId}. The Chrome extension may have re-registered with a new id ` +
            `after a primary change. Call browser.events (look for tab-renamed entries with previous=${tabId}) ` +
            `to find the current id, then retry the call on it.`,
        ),
      );
    }
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

/**
 * When the MCP client (Claude / OpenCode / Copilot) closes the stdio pipe,
 * the OS does NOT reliably deliver SIGTERM to this child — especially on
 * Windows, where signal forwarding from parent to child is best-effort.
 * Without this guard the server stays alive holding port 17529, and the
 * next client crashes with EADDRINUSE.
 *
 * Listening on `end`/`close` of stdin covers both roles (primary and proxy)
 * because both depend on the parent's stdio remaining open. The handler is
 * installed at the very top of runServer() so it's active during any
 * pre-bind awaits as well.
 */
function installParentDeathGuard(): void {
  let exiting = false;
  const onParentGone = () => {
    if (exiting) return;
    exiting = true;
    try {
      closeDb();
    } catch {
      // Best effort during shutdown — the OS reclaims the handle on exit.
    }
    process.exit(0);
  };
  process.stdin.once('end', onParentGone);
  process.stdin.once('close', onParentGone);
  // Some Node versions on Windows surface parent-closed-stdio as an EPIPE
  // on stdout writes. Don't crash the process for that — exit cleanly.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') onParentGone();
  });
}

/**
 * Entry point used by the MCP client over stdio. Decides whether THIS
 * process becomes the primary (binds 17529, runs the WS bridge + MCP
 * server + optional IPC server) or — when multi-agent mode is enabled
 * and another primary is already running — becomes a thin proxy that
 * forwards MCP stdio frames to the primary over IPC.
 */
export async function runServer(): Promise<void> {
  installParentDeathGuard();
  const cfg = loadConfig();
  try {
    await runPrimary(cfg);
  } catch (err) {
    if (!isAddrInUse(err)) throw err;
    if (cfg.multiAgent === true) {
      // Another primary is already running — degrade to proxy mode so this
      // MCP client can still reach the bridge.
      await runProxyMode();
      return;
    }
    throw new Error(
      `browser-link: port ${WS_HOST}:${WS_PORT} is already in use by another browser-link instance.\n` +
        `\n` +
        `Enable multi-agent mode if you want multiple MCP clients (Claude + Copilot + OpenCode) to share one bridge:\n` +
        `  • From a terminal: \`browser-link multi-agent enable\`\n` +
        `  • Or open the setup menu: \`browser-link\` → Multi-agent\n` +
        `\n` +
        `Then restart your MCP client. With multi-agent on, this process would have become a proxy instead of erroring.`,
    );
  }
}

async function runPrimary(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const tabs = new Map<string, TabSession>();
  const pendingRequests = new Map<string, PendingRequest>();
  const events = new BridgeEventLog();
  // First event of every primary: who am I and when did I start. The agent
  // sees this when calling browser.events after a "Tab not connected".
  events.add('primary-elected', {
    pid: process.pid,
    multiAgent: cfg.multiAgent === true,
  });

  // Bind the WS bridge first. AddrInUseError propagates up to runServer()
  // so the caller can decide between proxy mode and a clear error.
  await startWsBridge(tabs, pendingRequests, events);

  // Cooperative tab ownership across MCP clients. Claim events are mirrored
  // into the bridge event log so `browser.events` doubles as an audit trail.
  const tabClaims = new TabClaimRegistry({
    onEvent: (e) => {
      switch (e.kind) {
        case 'tab-claimed':
          events.add('tab-claimed', {
            tab_id: e.tab_id,
            agent_id: e.agent_id,
            pid: e.pid,
            binary: e.binary,
            label: e.label,
            ttl_ms: e.ttl_ms,
            auto: e.auto,
          });
          return;
        case 'tab-released':
          events.add('tab-released', {
            tab_id: e.tab_id,
            agent_id: e.agent_id,
            reason: e.reason,
          });
          return;
        case 'tab-claim-rejected':
          events.add('tab-claim-rejected', {
            tab_id: e.tab_id,
            requester_agent_id: e.requester_agent_id,
            existing_agent_id: e.existing_agent_id,
          });
          return;
      }
    },
  });

  // Sweep stale claims once a minute. Inactivity-based TTL — claims of agents
  // that crashed or went silent without disconnecting their IPC eventually
  // free up the tabs for someone else.
  const pruneTimer = setInterval(() => tabClaims.pruneStale(), 60_000);
  pruneTimer.unref();

  const deps: BrowserToolDeps = {
    listTabs: buildListTabs(tabs),
    callBrowserTool: buildCallBrowserTool(tabs, pendingRequests),
    recentEvents: (opts) => events.recent(opts),
    tabClaims,
  };

  // The primary's own MCP client (Claude/Copilot/OpenCode connecting via stdio
  // directly to THIS process) always uses this caller identity. Proxies that
  // arrive over IPC get their own per-session AgentCaller (see bridge/server.ts).
  const PRIMARY_CALLER: AgentCaller = {
    agent_id: 'primary',
    pid: process.pid,
    binary: 'node',
    label: 'primary',
  };

  // Snapshot the user's deny-list at boot. Changes made via the standalone
  // CLI/UI while the MCP server is already running do NOT take effect until
  // the MCP client restarts — the welcome and permissions screens both warn
  // the user about that.
  const disabledTools = cfg.disabledTools ?? [];
  if (disabledTools.length > 0) {
    log(`Tool filter active — ${disabledTools.length} disabled: ${disabledTools.join(', ')}`);
  }

  const dispatchDeps: DispatchDeps = { browserTools: deps, disabledTools };

  const mcpServer = new Server(
    { name: 'browser-link', version: '0.0.1' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  // The SDK's request-handler return types include task/streaming variants we
  // never produce. Cast keeps the shared dispatch module SDK-agnostic.
  mcpServer.setRequestHandler(
    ListToolsRequestSchema,
    async () => handleToolsList(dispatchDeps) as never,
  );
  mcpServer.setRequestHandler(
    CallToolRequestSchema,
    async (req) =>
      (await handleToolCall(
        { name: req.params.name, arguments: req.params.arguments, caller: PRIMARY_CALLER },
        dispatchDeps,
      )) as never,
  );

  // Optional: open the IPC bridge for proxy connections, but only when
  // multi-agent mode is opt-in via config. Default is off — this keeps
  // behaviour identical for users who never enable the feature.
  let ipcServer: IpcServer | null = null;
  if (cfg.multiAgent === true) {
    ipcServer = new IpcServer(dispatchDeps);
    try {
      await ipcServer.start();
    } catch (err) {
      // Surface and keep going. The primary MCP server still works for the
      // current client even if multi-agent failed to come up.
      log(`Multi-agent IPC failed to start: ${err instanceof Error ? err.message : String(err)}`);
      ipcServer = null;
    }
  }

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log(`MCP server ready on stdio (role=primary${ipcServer ? ', multi-agent=on' : ''})`);

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      if (ipcServer) {
        // Best-effort: tell connected proxies we're going down so they can
        // trigger auto-reelect (phase 4) and not just hit a dead socket.
        ipcServer.stop().catch(() => {
          /* shutting down; ignore */
        });
      }
      closeDb();
      process.exit(0);
    });
  }
}

/** Connect to the running primary as a proxy and pipe MCP stdio through.
 * When autoReelect is enabled in config, the proxy survives IPC drops
 * by waiting for a fresh primary to appear and reconnecting. */
async function runProxyMode(): Promise<void> {
  const cfg = loadConfig();
  const autoReelect = cfg.autoReelect === true;
  log(
    `Port in use — connecting as proxy to the running primary` +
      (autoReelect ? ' (auto-reelect on).' : '.'),
  );
  let exiting = false;
  const handle = await runProxy({
    autoReelect,
    onClose: (reason) => {
      if (exiting) return;
      exiting = true;
      log(`Primary connection closed (${reason}). Exiting so the MCP client can respawn.`);
      // Exit with non-zero so the MCP client knows something abnormal happened.
      process.exit(reason === 'primary-closing' ? 0 : 1);
    },
  });
  log(
    `Proxy ready — forwarding MCP frames to the primary` +
      (autoReelect ? ' (auto-reelect on).' : '.'),
  );
  // Wait until the IPC connection drops AND any reelect window expires;
  // runProxy resolves once the pipe is wired so this await holds the
  // process alive.
  await handle.closed;
}
