import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  lookupConnectionPeer,
  normaliseLoopback,
  type ConnectionPeer,
} from '../auth/peer-connection.js';
import type { PeerLookupLimiter } from '../auth/peer-lookup-limiter.js';
import {
  lookupPeerProcessDetailed,
  type PeerLookupCause,
  type PeerLookupRequest,
  type PeerLookupResult,
  type PeerProcess,
} from '../auth/process-identity.js';
import { SERVER_INSTRUCTIONS } from '../tools/server-instructions.js';
import { VERSION } from '../version.js';
import {
  IPC_HOST,
  IPC_PING_INTERVAL_MS,
  IPC_PONG_TIMEOUT_MS,
  IPC_PORT,
  IPC_PROTOCOL_VERSION,
  encodeFrame,
  isCompatibleVersion,
  parseFrame,
  type Frame,
  type SettingsPushPayload,
} from './protocol.js';
import { handleToolCall, handleToolsList, type DispatchDeps } from './dispatch.js';
import { rotateToken } from './token.js';
import type { AgentCaller } from '../tools/tab-claims.js';

/**
 * Primary's side of the IPC bridge. Listens on 127.0.0.1:17530, validates
 * incoming peer processes via the same kernel-level process binding that
 * protects the WS bridge, then runs the hello/token handshake. After auth,
 * forwards MCP JSON-RPC frames through the shared dispatch handlers.
 *
 * Construction does NOT bind the port. Call `start()` and await.
 */

/**
 * Logging convention for the IPC bridge:
 * - Writes to stderr. stdout belongs to the MCP transport.
 * - Peer-controlled values interpolated into a log entry MUST be sanitised
 *   inline with `.replace(/\n|\r/g, ' ')` at the call site, so a malicious
 *   peer cannot forge extra log lines via embedded newlines (CWE-117 /
 *   js/log-injection). A wrapper would centralise that concern, but
 *   CodeQL's dataflow analyser does not credit a sanitiser applied behind
 *   a wrapper — the sanitiser must live in the same scope as the template
 *   literal that builds the entry. Values that cannot carry newlines
 *   (UUIDs we mint, kernel-provided integers, static strings) do not need
 *   sanitising.
 */
const IPC_LOG_PREFIX = '[browser-link ipc]';

/** How long an accepted IPC socket may take, from accept to a completed
 * hello (peer lookup included, which can take seconds on Windows), before it
 * is destroyed. A legitimate proxy sends its hello right after connecting. */
export const IPC_HELLO_TIMEOUT_MS = 15_000;

/** Longest line, in bytes, accepted from a peer that has not authenticated
 * yet. The largest legitimate hello is about 100 bytes (version + a 64-hex
 * token); the bound leaves two orders of magnitude of headroom and keeps an
 * unauthenticated peer from growing the line buffer. Applies only until the
 * hello completes. */
export const IPC_MAX_PREAUTH_LINE_BYTES = 16 * 1024;

/** Binaries we'll accept as legitimate peers. The token is the real auth;
 * this is defence in depth. Names normalised to lowercase before comparison. */
const NODE_PROCESS_NAMES: ReadonlySet<string> = new Set([
  'node',
  'node.exe',
  'nodejs',
  'tsx',
  'tsx.exe',
  'browser-link',
  'browser-link.exe',
]);

/** Why a lookup refused, as the tail of an IPC refusal line. The same wording
 * as the WebSocket gate's lines (`handshake.ts`). */
function describeLookupFailure(cause: PeerLookupCause, detail: string | undefined): string {
  if (cause === 'owner-mismatch') {
    return 'the owning process runs as another OS user (cause: owner-mismatch).';
  }
  if (cause === 'owner-unreadable') {
    return 'the owner of the owning process could not be read (cause: owner-unreadable).';
  }
  return `could not identify owning process (cause: ${cause}${detail === undefined ? '' : `; ${detail}`}).`;
}

interface ProxySession {
  id: string;
  socket: Socket;
  pingTimer: NodeJS.Timeout;
  pongDeadline: NodeJS.Timeout | null;
  /** Cached caller for this session — built once at handshake and reused on
   * every MCP request so we don't re-derive it per call. The agent_id is
   * the session id (UUID minted at auth), tied to the connection lifetime. */
  caller: AgentCaller;
}

export interface IpcServerOptions {
  /** Override the bind host. Default 127.0.0.1. Production callers should
   * never set this — tests use it to dodge cross-suite port collisions. */
  host?: string;
  /** Override the bind port. Default 17530. Pass 0 to let the OS pick a
   * free port; the chosen port is exposed via boundPort() after start(). */
  port?: number;
  /** Override the kernel-level peer process lookup. Production callers never
   * set this — defaults to the real lsof/netstat-backed detailed lookup.
   * Tests inject a deterministic stub so they don't depend on those tools
   * being available or fast enough on CI runners. It answers a lookup result
   * (a refusal carries its cause) or, as shorthand for an accepted one, the
   * bare peer. */
  peerLookup?: (
    host: string,
    port: number,
    request: PeerLookupRequest,
  ) => Promise<PeerLookupResult | PeerProcess>;
  /** The limiter every peer lookup goes through. Default the one shared with
   * the WebSocket gate; tests pass their own. */
  peerLookupLimiter?: PeerLookupLimiter;
  /**
   * Called when a `settings.push` frame arrives (from `browser-link config
   * set idle-ttl` / `config set flow-recording`'s one-shot IPC client).
   * Should forward the settings to every currently-connected extension tab
   * (see `ws-bridge.ts`'s `pushSettingsToAllTabs`) and return how many tabs
   * were notified — that count is echoed back in the `settings.push-ack`
   * reply. Left undefined in tests that don't exercise this path;
   * production wiring is in `server.ts`'s `runPrimary`.
   */
  pushSettings?: (settings: SettingsPushPayload) => number;
  /** The `initialize.instructions` text proxies receive. The primary passes
   * the text it built at start (with the outdated-block notice when one
   * applies) so a proxied agent reads the same text as the primary's own
   * client. Defaults to `SERVER_INSTRUCTIONS`. */
  instructions?: string;
  /** Override how long an accepted socket may take to complete the hello
   * (default `IPC_HELLO_TIMEOUT_MS`). Tests pass a short one. */
  helloTimeoutMs?: number;
}

export class IpcServer {
  private server: NetServer | null = null;
  private sessions = new Map<string, ProxySession>();
  private token: string;
  private boundHost = IPC_HOST;
  private boundPortValue = IPC_PORT;

  constructor(
    private deps: DispatchDeps,
    private options: IpcServerOptions = {},
  ) {
    // Rotate the token on every primary startup. Any stale token left by a
    // crashed previous primary is invalidated immediately.
    this.token = rotateToken();
  }

  /** Bind the IPC port. Rejects on EADDRINUSE so the caller (server.ts)
   * can log and continue without multi-agent — never throws after listen. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const host = this.options.host ?? IPC_HOST;
      const port = this.options.port ?? IPC_PORT;
      const server = createServer((socket) => {
        this.handleConnection(socket).catch((err: unknown) => {
          const reason = (err instanceof Error ? err.message : String(err)).replace(/\n|\r/g, ' ');
          console.error(`${IPC_LOG_PREFIX} Connection handler error: ${reason}`);
          socket.destroy();
        });
      });
      let settled = false;
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (!settled) {
          settled = true;
          if (err.code === 'EADDRINUSE') {
            reject(
              new Error(
                `IPC port ${host}:${port} already in use — another browser-link primary may already be running.`,
              ),
            );
          } else {
            reject(err);
          }
        } else {
          const reason = err.message.replace(/\n|\r/g, ' ');
          console.error(`${IPC_LOG_PREFIX} Server error after listening: ${reason}`);
        }
      });
      server.listen(port, host, () => {
        settled = true;
        this.server = server;
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this.boundHost = addr.address;
          this.boundPortValue = addr.port;
        } else {
          this.boundHost = host;
          this.boundPortValue = port;
        }
        console.error(
          `${IPC_LOG_PREFIX} IPC server listening on ${this.boundHost}:${this.boundPortValue}`,
        );
        resolve();
      });
    });
  }

  /** The actual host+port the server is listening on. Set after start()
   * resolves; meaningful even when port:0 was passed. */
  boundAddress(): { host: string; port: number } {
    return { host: this.boundHost, port: this.boundPortValue };
  }

  /** Tell every connected proxy we're going down (so auto-reelect can fire),
   * then close the listening socket. Safe to call when start() never ran. */
  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        session.socket.write(encodeFrame({ kind: 'primary-closing', reason: 'shutdown' }));
      } catch {
        /* socket already gone */
      }
      clearInterval(session.pingTimer);
      if (session.pongDeadline) clearTimeout(session.pongDeadline);
      session.socket.end();
    }
    this.sessions.clear();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((res) => {
        server.close(() => {
          res();
        });
      });
    }
  }

  /** Visible to tests + doctor. */
  sessionCount(): number {
    return this.sessions.size;
  }

  /** Exposed for tests only. Production callers never need this. */
  currentToken(): string {
    return this.token;
  }

  private async handleConnection(socket: Socket): Promise<void> {
    // Attach the error listener BEFORE the first await: the peer lookup can
    // take seconds (netstat/tasklist on Windows), and an ECONNRESET on a
    // socket with no 'error' listener is an uncaught exception that kills
    // the primary for every agent. Node destroys the socket after 'error',
    // so the connection is dropped and the accept loop keeps serving.
    // Only the error code is logged (a fixed token like ECONNRESET), never the
    // raw message, so peer-influenced text cannot reach the log.
    // The hello deadline starts at accept, so a peer that connects and then
    // stays silent (or stalls the lookup) cannot hold the socket forever.
    let helloTimer: NodeJS.Timeout | null = setTimeout(() => {
      helloTimer = null;
      console.error(`${IPC_LOG_PREFIX} No hello within the deadline; closing connection.`);
      socket.destroy();
    }, this.options.helloTimeoutMs ?? IPC_HELLO_TIMEOUT_MS);
    const clearHelloTimer = () => {
      if (helloTimer !== null) clearTimeout(helloTimer);
      helloTimer = null;
    };
    socket.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
      const safe = /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown';
      console.error(`${IPC_LOG_PREFIX} Proxy socket error: ${JSON.stringify(safe)}`);
    });
    // Kernel-level process binding, shared with the WS gate: we ask the OS
    // which process owns the peer's TCP port (same OS user required), through
    // the shared limiter, and reject anything that does not look like a
    // Node-family binary. No strict mode by path here: that is the WS port's.
    let found: ConnectionPeer;
    try {
      found = await lookupConnectionPeer(
        socket,
        (host, port, request) => this.lookupPeer(host, port, request),
        {},
        this.options.peerLookupLimiter,
      );
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).replace(/\n|\r/g, ' ');
      const from = `${normaliseLoopback(socket.remoteAddress ?? '')}:${String(socket.remotePort)}`;
      console.error(
        `${IPC_LOG_PREFIX} Rejected IPC connection from ${from}: process lookup failed (${reason}).`,
      );
      socket.destroy();
      return;
    }
    if (!found.identified) {
      console.error(
        `${IPC_LOG_PREFIX} Rejected IPC connection: peer address/port not exposed by socket.`,
      );
      socket.destroy();
      return;
    }
    const { host: remoteAddr, port: remotePort } = found.remote;
    if (!found.result.ok) {
      const why = describeLookupFailure(found.result.cause, found.result.detail).replace(
        /\n|\r/g,
        ' ',
      );
      console.error(
        `${IPC_LOG_PREFIX} Rejected IPC connection from ${remoteAddr}:${remotePort}: ${why}`,
      );
      socket.destroy();
      return;
    }
    const peer = found.result.peer;
    if (!NODE_PROCESS_NAMES.has(peer.binaryName.toLowerCase())) {
      const binary = peer.binaryName.replace(/\n|\r/g, ' ');
      console.error(
        `${IPC_LOG_PREFIX} Rejected IPC connection from ${remoteAddr}:${remotePort}: not a known Node process (${binary}).`,
      );
      socket.destroy();
      return;
    }

    let buffer = '';
    let authenticated = false;
    // Set once a hello was refused: nothing more is parsed from the socket.
    const gate = { rejected: false };
    const isRejected = (): boolean => gate.rejected;
    /** Refuse the hello: tell the peer why, stop parsing, then drop the socket
     * once the reason is flushed (destroy, not end: a half-closed socket
     * would keep delivering and parsing bytes). */
    const rejectHello = (reason: string) => {
      gate.rejected = true;
      buffer = '';
      socket.write(encodeFrame({ kind: 'hello-reject', reason }), () => {
        socket.destroy();
      });
    };
    let sessionId: string | null = null;

    const handleLine = (line: string) => {
      if (gate.rejected || line.length === 0) return;
      const frame = parseFrame(line);
      if (!frame) {
        console.error(`${IPC_LOG_PREFIX} Invalid frame received; closing connection.`);
        socket.destroy();
        return;
      }
      if (!authenticated) {
        if (frame.kind !== 'hello') {
          const kind = frame.kind.replace(/\n|\r/g, ' ');
          console.error(`${IPC_LOG_PREFIX} First frame was not "hello" (got ${kind}); closing.`);
          socket.destroy();
          return;
        }
        if (!isCompatibleVersion(frame.version)) {
          rejectHello(`version mismatch: primary ${IPC_PROTOCOL_VERSION}, proxy ${frame.version}`);
          return;
        }
        if (frame.token !== this.token) {
          rejectHello('invalid token');
          return;
        }
        // Auth ok — register session and start the heartbeat.
        authenticated = true;
        clearHelloTimer();
        sessionId = randomUUID();
        socket.write(encodeFrame({ kind: 'hello-ack', version: IPC_PROTOCOL_VERSION, sessionId }));
        const sid = sessionId;
        const caller: AgentCaller = {
          agent_id: sid,
          pid: peer.pid,
          binary: peer.binaryName,
        };
        const session: ProxySession = {
          id: sid,
          socket,
          pingTimer: setInterval(() => {
            this.heartbeat(sid);
          }, IPC_PING_INTERVAL_MS),
          pongDeadline: null,
          caller,
        };
        this.sessions.set(sid, session);
        console.error(`${IPC_LOG_PREFIX} Proxy connected: session=${sid} pid=${peer.pid}`);
        return;
      }
      // After the hello branch above, `authenticated` is true and
      // `sessionId` is set — but TS can't carry that pair across
      // closure invocations, so re-check defensively.
      if (sessionId === null) return;
      void this.handleFrame(frame, sessionId, socket);
    };

    const tooLong = () => {
      console.error(
        `${IPC_LOG_PREFIX} Unauthenticated line over ${String(IPC_MAX_PREAUTH_LINE_BYTES)} bytes; closing.`,
      );
      buffer = '';
      socket.destroy();
    };
    socket.on('data', (chunk: Buffer) => {
      if (gate.rejected) return;
      buffer += chunk.toString('utf8');
      let nl: number;
      while (!isRejected() && !socket.destroyed && (nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!authenticated && Buffer.byteLength(line, 'utf8') > IPC_MAX_PREAUTH_LINE_BYTES) {
          tooLong();
          return;
        }
        handleLine(line);
      }
      // The unterminated remainder is bounded too, until the hello completes.
      if (!authenticated && buffer.length > IPC_MAX_PREAUTH_LINE_BYTES) tooLong();
    });
    socket.on('close', () => {
      clearHelloTimer();
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
          clearInterval(session.pingTimer);
          if (session.pongDeadline) clearTimeout(session.pongDeadline);
          this.sessions.delete(sessionId);
          // Drop every claim the agent held. The registry emits one
          // tab-released event per dropped claim, which surfaces in
          // browser.events for the remaining agents.
          this.deps.browserTools.tabClaims?.onAgentDisconnect(sessionId);
          console.error(`${IPC_LOG_PREFIX} Proxy disconnected: session=${sessionId}`);
        }
      }
    });
  }

  /** The detailed lookup: the injected one (a bare peer read as accepted) or
   * the real one. */
  private async lookupPeer(
    host: string,
    port: number,
    request: PeerLookupRequest,
  ): Promise<PeerLookupResult> {
    if (this.options.peerLookup === undefined) {
      return lookupPeerProcessDetailed(host, port, {}, request);
    }
    const answer: unknown = await this.options.peerLookup(host, port, request);
    if (typeof answer !== 'object' || answer === null) {
      throw new Error('the peer lookup returned no answer');
    }
    return 'ok' in answer
      ? (answer as PeerLookupResult)
      : { ok: true, peer: answer as PeerProcess };
  }

  private heartbeat(sid: string): void {
    const session = this.sessions.get(sid);
    if (!session) return;
    try {
      session.socket.write(encodeFrame({ kind: 'ping' }));
    } catch {
      // socket already closed; the 'close' handler will clean up
      return;
    }
    if (!session.pongDeadline) {
      session.pongDeadline = setTimeout(() => {
        console.error(`${IPC_LOG_PREFIX} Proxy ${sid} did not pong in time; dropping.`);
        session.socket.destroy();
      }, IPC_PONG_TIMEOUT_MS);
    }
  }

  private async handleFrame(frame: Frame, sessionId: string, socket: Socket): Promise<void> {
    switch (frame.kind) {
      case 'pong': {
        const session = this.sessions.get(sessionId);
        if (session?.pongDeadline) {
          clearTimeout(session.pongDeadline);
          session.pongDeadline = null;
        }
        return;
      }
      case 'mcp.request': {
        const response = await this.dispatchMcpRequest(frame.payload, sessionId);
        try {
          socket.write(
            encodeFrame({ kind: 'mcp.response', requestId: frame.requestId, payload: response }),
          );
        } catch {
          /* socket gone */
        }
        return;
      }
      case 'mcp.notification': {
        // Proxies forward notifications like notifications/initialized. We
        // don't reply (notifications have no id). Future work: route to map
        // event log when we add the traceability layer.
        return;
      }
      case 'ping': {
        try {
          socket.write(encodeFrame({ kind: 'pong' }));
        } catch {
          /* socket gone */
        }
        return;
      }
      case 'settings.push': {
        const notified = this.options.pushSettings?.(frame.settings) ?? 0;
        try {
          socket.write(encodeFrame({ kind: 'settings.push-ack', notified }));
        } catch {
          /* socket gone */
        }
        return;
      }
      default:
        // hello/hello-ack/hello-reject/primary-closing should not arrive
        // post-handshake from a proxy. Ignore defensively.
        return;
    }
  }

  /** Dispatch a JSON-RPC 2.0 MCP request to the shared handlers and return
   * a JSON-RPC 2.0 response object. Errors are converted to JSON-RPC error
   * envelopes — never thrown back to the socket layer.
   *
   * `sessionId` ties the call back to the IPC session that originated it,
   * so handlers that care about per-agent ownership (tab claims) see the
   * right identity. The session is the authentication scope: only the agent
   * that passed the handshake gets a session id, and the id dies with the
   * connection. */
  private async dispatchMcpRequest(payload: unknown, sessionId: string): Promise<unknown> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    }
    const req = payload as {
      jsonrpc?: string;
      id?: number | string | null;
      method?: string;
      params?: unknown;
    };
    const id = req.id ?? null;
    const method = req.method ?? '';
    try {
      switch (method) {
        case 'initialize': {
          const result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'browser-link', version: VERSION },
            instructions: this.options.instructions ?? SERVER_INSTRUCTIONS,
          };
          return { jsonrpc: '2.0', id, result };
        }
        case 'tools/list': {
          const result = handleToolsList(this.deps);
          return { jsonrpc: '2.0', id, result };
        }
        case 'tools/call': {
          const params = req.params as { name?: string; arguments?: unknown } | undefined;
          if (!params || typeof params.name !== 'string') {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Missing tool name in params' },
            };
          }
          const session = this.sessions.get(sessionId);
          if (!session) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32603, message: 'Session not found for tools/call' },
            };
          }
          const result = await handleToolCall(
            { name: params.name, arguments: params.arguments, caller: session.caller },
            this.deps,
          );
          return { jsonrpc: '2.0', id, result };
        }
        case 'ping': {
          return { jsonrpc: '2.0', id, result: {} };
        }
        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { jsonrpc: '2.0', id, error: { code: -32603, message } };
    }
  }
}
