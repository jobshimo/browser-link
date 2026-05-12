import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { lookupPeerProcess, type PeerProcess } from '../auth/process-identity.js';
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

/** Strip ASCII control characters from anything we put through `log()`.
 * Some of what we log includes data that originally came from a peer
 * (binary names, error messages, frame kinds), so a malicious or just
 * quirky value with embedded newlines / ANSI escapes / NULs could forge
 * additional log lines or hide context. Replacing them with `?` makes
 * every entry survive a single line and a single visible character per
 * source character. */
function sanitizeLogValue(s: string): string {
  // ASCII C0 (U+0000-U+001F) plus DEL (U+007F). Stops embedded newlines /
  // NUL / ANSI escapes from forging extra log lines or hiding text.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, '?');
}

function log(msg: string): void {
  // stderr — stdout belongs to the MCP transport.
  console.error(`[browser-link ipc] ${sanitizeLogValue(msg)}`);
}

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

/** Same loopback normalisation as server.ts uses for the WS bridge. */
function normaliseLoopback(addr: string): string {
  if (addr === '::1' || addr === '::ffff:127.0.0.1') return '127.0.0.1';
  if (addr.startsWith('::ffff:')) return addr.slice('::ffff:'.length);
  return addr;
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
   * set this — defaults to the real lsof/netstat-backed lookup. Tests inject
   * a deterministic stub so they don't depend on those tools being available
   * or fast enough on CI runners. */
  peerLookup?: (host: string, port: number) => Promise<PeerProcess | null>;
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
          log(`Connection handler error: ${err instanceof Error ? err.message : String(err)}`);
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
          log(`Server error after listening: ${err.message}`);
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
        log(`IPC server listening on ${this.boundHost}:${this.boundPortValue}`);
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
    const remoteAddr = normaliseLoopback(socket.remoteAddress ?? '');
    const remotePort = socket.remotePort;

    if (!remoteAddr || remotePort == null) {
      log('Rejected IPC connection: peer address/port not exposed by socket.');
      socket.destroy();
      return;
    }

    // Kernel-level process binding. Same trick as the WS bridge: we ask the
    // OS which process owns the peer's TCP port, and reject anything that
    // does not look like a Node-family binary.
    const lookup = this.options.peerLookup ?? lookupPeerProcess;
    const peer = await lookup(remoteAddr, remotePort).catch(() => null);
    if (!peer || !NODE_PROCESS_NAMES.has(peer.binaryName.toLowerCase())) {
      log(
        `Rejected IPC connection from ${remoteAddr}:${remotePort}: not a known Node process (${
          peer?.binaryName ?? 'unknown'
        }).`,
      );
      socket.destroy();
      return;
    }

    let buffer = '';
    let authenticated = false;
    let sessionId: string | null = null;

    const handleLine = (line: string) => {
      if (line.length === 0) return;
      const frame = parseFrame(line);
      if (!frame) {
        log('Invalid frame received; closing connection.');
        socket.destroy();
        return;
      }
      if (!authenticated) {
        if (frame.kind !== 'hello') {
          log(`First frame was not "hello" (got ${frame.kind}); closing.`);
          socket.destroy();
          return;
        }
        if (!isCompatibleVersion(frame.version)) {
          socket.write(
            encodeFrame({
              kind: 'hello-reject',
              reason: `version mismatch: primary ${IPC_PROTOCOL_VERSION}, proxy ${frame.version}`,
            }),
          );
          socket.end();
          return;
        }
        if (frame.token !== this.token) {
          socket.write(encodeFrame({ kind: 'hello-reject', reason: 'invalid token' }));
          socket.end();
          return;
        }
        // Auth ok — register session and start the heartbeat.
        authenticated = true;
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
        log(`Proxy connected: session=${sid} pid=${peer.pid}`);
        return;
      }
      // After the hello branch above, `authenticated` is true and
      // `sessionId` is set — but TS can't carry that pair across
      // closure invocations, so re-check defensively.
      if (sessionId === null) return;
      void this.handleFrame(frame, sessionId, socket);
    };

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line);
      }
    });
    socket.on('close', () => {
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
          log(`Proxy disconnected: session=${sessionId}`);
        }
      }
    });
    socket.on('error', (err) => {
      log(`Proxy socket error: ${err.message}`);
    });
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
        log(`Proxy ${sid} did not pong in time; dropping.`);
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
            instructions: SERVER_INSTRUCTIONS,
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
