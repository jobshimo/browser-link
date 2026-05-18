import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { closeDb } from './map/db.js';
import { type BrowserToolDeps, type TabSnapshot } from './tools/browser-dispatch.js';
import { SERVER_INSTRUCTIONS } from './tools/server-instructions.js';
import { INSTRUCTIONS_INSTALLERS } from './agent-instructions/index.js';
import { loadConfig } from './config.js';
import { handleToolCall, handleToolsList, type DispatchDeps } from './bridge/dispatch.js';
import { IpcServer } from './bridge/server.js';
import { runProxy } from './bridge/proxy.js';
import { BridgeEventLog } from './bridge/events.js';
import { TabClaimRegistry, type AgentCaller } from './tools/tab-claims.js';
import {
  WS_HOST,
  WS_PORT,
  isAddrInUse,
  sendToolRequest,
  startWsBridge,
  type PendingRequest,
  type TabSession,
} from './bridge/ws-bridge.js';

export { WS_HOST, WS_PORT };

const DEFAULT_TIMEOUT_MS = 15_000;

function log(msg: string): void {
  console.error(`[browser-link] ${msg}`);
}

function buildCallBrowserTool(
  tabs: Map<string, TabSession>,
  pendingRequests: Map<string, PendingRequest>,
): BrowserToolDeps['callBrowserTool'] {
  return (tabId, tool, params, timeoutMs = DEFAULT_TIMEOUT_MS) =>
    sendToolRequest(tabs, pendingRequests, tabId, randomUUID(), tool, params, timeoutMs);
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
 * Entry point used by the MCP client over stdio. Decides whether THIS
 * process becomes the primary (binds 17529, runs the WS bridge + MCP
 * server + optional IPC server) or — when multi-agent mode is enabled
 * and another primary is already running — becomes a thin proxy that
 * forwards MCP stdio frames to the primary over IPC.
 */
export async function runServer(): Promise<void> {
  // The bridge stays alive when the MCP client closes its stdio. The
  // connected Chrome tabs keep talking to the WS bridge until the user
  // explicitly disconnects them from the extension popup, or the WS
  // hits its inactivity TTL on the client side. If a zombie ever holds
  // 17529 after a crash, `runPrimary` falls back to proxy mode (when
  // multi-agent is on) or surfaces a clean EADDRINUSE error pointing
  // the user at `browser-link stop`.
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
      { cause: err },
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
    subscribeEvents: (fn, options) => events.subscribe(fn, options),
    tabClaims,
    resetBridge: () => {
      // Close every WS to the extension first so the client side flips to
      // "Not connected" before we drop the local state. Best-effort: a tab
      // whose socket already died just no-ops.
      const droppedTabs = tabs.size;
      for (const session of tabs.values()) {
        try {
          session.ws.close();
        } catch {
          /* socket already gone */
        }
      }
      tabs.clear();
      // Reject every pending tool request so the caller does not hang.
      for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('browser.reset: bridge state was wiped'));
      }
      pendingRequests.clear();
      const releasedClaims = tabClaims.releaseAll().length;
      const clearedEvents = events.clear();
      // First event of the fresh state — keeps `browser.events` honest.
      events.add('primary-elected', {
        pid: process.pid,
        multiAgent: cfg.multiAgent === true,
        reason: 'reset',
      });
      log(
        `browser.reset: dropped ${droppedTabs} tab(s), released ${releasedClaims} claim(s), cleared ${clearedEvents} event(s).`,
      );
      return {
        dropped_tabs: droppedTabs,
        released_claims: releasedClaims,
        cleared_events: clearedEvents,
      };
    },
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

  // Live deny-list lookup: re-reads config.json on every tools/list and
  // tools/call so changes from the CLI/UI take effect immediately, without
  // restarting the MCP client. The file is small and the read is bounded
  // (one JSON.parse per call); this matches the human-scale frequency of
  // MCP tool invocations.
  const initialDisabled = cfg.disabledTools ?? [];
  if (initialDisabled.length > 0) {
    log(
      `Tool filter active at boot — ${initialDisabled.length} disabled: ${initialDisabled.join(', ')} (live; reflects config.json on every call).`,
    );
  }

  // Surface outdated agent-instructions blocks on boot so the user sees the
  // cartel without having to remember to run `browser-link instructions`. We
  // only inspect — never write — so existing installs are not mutated. Best
  // effort: a per-installer failure (filesystem permissions, EBADF) is logged
  // and skipped, never aborts the server start.
  try {
    const outdated = INSTRUCTIONS_INSTALLERS.map((i) => {
      try {
        return { installer: i, detect: i.detect() };
      } catch {
        return null;
      }
    })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .filter((x) => x.detect.state.kind === 'installed-outdated');
    if (outdated.length > 0) {
      const names = outdated.map((x) => x.installer.displayName).join(', ');
      log(
        `Agent instructions OUTDATED for ${outdated.length} client(s) — ${names}. Run \`browser-link instructions install\` to refresh the global .md blocks.`,
      );
    }
  } catch (err) {
    log(
      `Skipping agent-instructions freshness check: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const dispatchDeps: DispatchDeps = {
    browserTools: deps,
    disabledTools: () => loadConfig().disabledTools ?? [],
  };

  // We use `McpServer` (the non-deprecated high-level class) but reach
  // through `.server` for `setRequestHandler` — the SDK docs explicitly
  // expose the underlying Server for "advanced usage like sending
  // notifications or setting custom request handlers", which is exactly
  // what we need: one dispatcher for tools/list and tools/call instead
  // of per-tool callbacks.
  const mcpServer = new McpServer(
    { name: 'browser-link', version: '0.0.1' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  // The SDK's request-handler return types include task/streaming variants we
  // never produce. Cast keeps the shared dispatch module SDK-agnostic.
  mcpServer.server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve(handleToolsList(dispatchDeps) as never),
  );
  mcpServer.server.setRequestHandler(
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
