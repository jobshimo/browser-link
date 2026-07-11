import { connect, type Socket } from 'node:net';
import {
  IPC_HOST,
  IPC_PORT,
  IPC_PROTOCOL_VERSION,
  encodeFrame,
  parseFrame,
  type Frame,
} from './protocol.js';

/**
 * Bare IPC client used by the proxy. Owns the TCP socket, handles framing,
 * runs the hello handshake, and dispatches mcp.response frames back to the
 * caller that sent the matching mcp.request. The proxy wiring (stdin/stdout
 * pipe + reelect loop) lives in proxy.ts.
 */

function log(msg: string): void {
  console.error(`[browser-link proxy] ${msg}`);
}

/** Raised when the proxy cannot complete the IPC handshake. */
export class HandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandshakeError';
  }
}

export interface ConnectOptions {
  host?: string;
  port?: number;
  /** How long to wait for a hello-ack after sending the hello. */
  handshakeTimeoutMs?: number;
}

export interface ConnectionInfo {
  sessionId: string;
  version: string;
}

/** Minimal IPC client. Owns the TCP socket, handles framing, runs the
 * handshake, dispatches mcp.response frames back to whoever sent the
 * matching mcp.request. */
export class IpcClient {
  private socket: Socket | null = null;
  private buffer = '';
  private nextRequestId = 1;
  private pendingRequests = new Map<number, (payload: unknown) => void>();
  private closeListeners: Array<(reason: 'remote' | 'local' | 'primary-closing') => void> = [];
  private notificationListeners: Array<(payload: unknown) => void> = [];
  private closed = false;
  /** At most one `settings.push` is ever in flight per client — the CLI's
   * one-shot `config set idle-ttl` invocation sends exactly one and then
   * disconnects, so a single slot (vs. a Map keyed by request id, like
   * `pendingRequests`) is all this needs. */
  private pendingSettingsPush: ((ack: { notified: number }) => void) | null = null;

  /** Open the TCP connection, perform the handshake, and resolve with the
   * session info from the primary's hello-ack. On any handshake failure,
   * rejects with HandshakeError and tears down the socket. */
  async connect(token: string, opts: ConnectOptions = {}): Promise<ConnectionInfo> {
    const host = opts.host ?? IPC_HOST;
    const port = opts.port ?? IPC_PORT;
    const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 4000;

    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ host, port });
      s.once('connect', () => {
        resolve(s);
      });
      s.once('error', (err) => {
        reject(err);
      });
    });

    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.ingest(chunk);
    });
    socket.on('close', () => {
      this.onSocketClose('remote');
    });
    socket.on('error', (err) => {
      log(`Socket error: ${err.message}`);
    });

    // Send hello, wait for ack or reject or timeout.
    const ack = await new Promise<ConnectionInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new HandshakeError('Handshake timed out — primary did not reply.'));
      }, handshakeTimeoutMs);
      const onFirstFrame = (frame: Frame) => {
        clearTimeout(timer);
        if (frame.kind === 'hello-ack') {
          resolve({ sessionId: frame.sessionId, version: frame.version });
          return;
        }
        if (frame.kind === 'hello-reject') {
          reject(new HandshakeError(`Primary rejected: ${frame.reason}`));
          return;
        }
        reject(new HandshakeError(`Unexpected first frame: ${frame.kind}`));
      };
      this.handshakeReceiver = onFirstFrame;
      try {
        socket.write(encodeFrame({ kind: 'hello', version: IPC_PROTOCOL_VERSION, token }));
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }).catch((err: unknown) => {
      void this.disconnect().catch(() => {
        /* ignore */
      });
      throw err;
    });

    this.handshakeReceiver = null;
    log(`Handshake ok — session=${ack.sessionId}`);
    return ack;
  }

  private handshakeReceiver: ((frame: Frame) => void) | null = null;

  /** Forward a JSON-RPC request as an mcp.request frame. Resolves with the
   * primary's JSON-RPC response payload. Rejects if the socket closes. */
  sendMcpRequest(jsonRpcPayload: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || this.closed) {
      return Promise.reject(new Error('Proxy is not connected.'));
    }
    const requestId = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(requestId, resolve);
      const onCloseHandler = (): void => {
        if (this.pendingRequests.delete(requestId)) {
          reject(new Error('Primary connection closed while a request was in flight.'));
        }
      };
      this.onClose(onCloseHandler);
      try {
        socket.write(encodeFrame({ kind: 'mcp.request', requestId, payload: jsonRpcPayload }));
      } catch (err) {
        this.pendingRequests.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Push a settings update to the primary (used by `browser-link config set
   * idle-ttl` — see `commands/config.ts`). Resolves with how many currently
   * connected extension tabs the primary forwarded a `settings.update` to.
   * Rejects if the socket closes before the ack arrives.
   */
  sendSettingsPush(settings: {
    idleTtlMinutes: number;
    updatedAt: number;
  }): Promise<{ notified: number }> {
    const socket = this.socket;
    if (!socket || this.closed) {
      return Promise.reject(new Error('Not connected to a browser-link primary.'));
    }
    return new Promise<{ notified: number }>((resolve, reject) => {
      this.pendingSettingsPush = resolve;
      const onCloseHandler = (): void => {
        if (this.pendingSettingsPush) {
          this.pendingSettingsPush = null;
          reject(new Error('Primary connection closed while the settings push was in flight.'));
        }
      };
      this.onClose(onCloseHandler);
      try {
        socket.write(encodeFrame({ kind: 'settings.push', settings }));
      } catch (err) {
        this.pendingSettingsPush = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Forward a JSON-RPC notification as an mcp.notification frame. Fire-
   * and-forget — notifications have no response in JSON-RPC. */
  sendMcpNotification(jsonRpcPayload: unknown): void {
    if (!this.socket || this.closed) return;
    try {
      this.socket.write(encodeFrame({ kind: 'mcp.notification', payload: jsonRpcPayload }));
    } catch {
      /* socket gone; close handler will fire */
    }
  }

  /** Register a callback invoked when the IPC connection drops. The
   * `reason` argument distinguishes a primary-closing broadcast from a
   * plain remote close so callers can decide to re-elect vs exit. */
  onClose(cb: (reason: 'remote' | 'local' | 'primary-closing') => void): void {
    this.closeListeners.push(cb);
  }

  /** Register a callback for unsolicited notifications from the primary
   * (e.g. tools/list_changed in the future). */
  onNotification(cb: (payload: unknown) => void): void {
    this.notificationListeners.push(cb);
  }

  /** Close the IPC connection. */
  disconnect(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      try {
        s.end();
      } catch {
        /* ignore */
      }
      s.destroy();
      // Fire close listeners with reason=local (we initiated it).
      this.notifyClose('local');
    }
    return Promise.resolve();
  }

  private ingest(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      const frame = parseFrame(line);
      if (!frame) {
        log('Invalid frame from primary; dropping.');
        continue;
      }
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: Frame): void {
    if (this.handshakeReceiver) {
      this.handshakeReceiver(frame);
      return;
    }
    switch (frame.kind) {
      case 'mcp.response': {
        const resolve = this.pendingRequests.get(frame.requestId);
        if (resolve) {
          this.pendingRequests.delete(frame.requestId);
          resolve(frame.payload);
        }
        return;
      }
      case 'mcp.notification': {
        for (const cb of this.notificationListeners) cb(frame.payload);
        return;
      }
      case 'ping': {
        try {
          this.socket?.write(encodeFrame({ kind: 'pong' }));
        } catch {
          /* socket gone */
        }
        return;
      }
      case 'pong': {
        // Future: we can send our own pings if needed. Today the primary
        // initiates the heartbeat; pong from us → primary.
        return;
      }
      case 'primary-closing': {
        log(`Primary signalled close (${frame.reason ?? 'no reason'}).`);
        this.notifyClose('primary-closing');
        return;
      }
      case 'settings.push-ack': {
        const resolve = this.pendingSettingsPush;
        if (resolve) {
          this.pendingSettingsPush = null;
          resolve({ notified: frame.notified });
        }
        return;
      }
      default:
        return;
    }
  }

  private onSocketClose(reason: 'remote'): void {
    if (this.closed) return;
    this.closed = true;
    log('Socket closed by primary.');
    this.notifyClose(reason);
  }

  private notifyClose(reason: 'remote' | 'local' | 'primary-closing'): void {
    // Reject every in-flight request first so callers don't hang.
    for (const resolve of this.pendingRequests.values()) {
      // We resolve with a JSON-RPC error envelope so the MCP client gets
      // a tool error instead of a stuck promise.
      resolve({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'browser-link primary disconnected.' },
      });
    }
    this.pendingRequests.clear();
    for (const cb of this.closeListeners.splice(0)) {
      try {
        cb(reason);
      } catch (err) {
        log(`Close listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
