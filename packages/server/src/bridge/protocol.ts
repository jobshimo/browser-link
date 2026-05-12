/**
 * IPC protocol between browser-link primary and proxy instances.
 *
 * Wire format: newline-delimited JSON (NDJSON). Each line is one frame.
 * The protocol version is bumped on any non-backwards-compatible change
 * to frame shapes. A primary running version N rejects proxies that
 * don't advertise the same N — they fall back to a clear error.
 *
 * This module is pure data + helpers; no I/O.
 */

export const IPC_HOST = '127.0.0.1';
export const IPC_PORT = 17530;
export const IPC_PROTOCOL_VERSION = '1';

/** Pings cadence. If a side doesn't reply within IPC_PONG_TIMEOUT_MS,
 * the connection is considered dead. */
export const IPC_PING_INTERVAL_MS = 5_000;
export const IPC_PONG_TIMEOUT_MS = 10_000;

/** Initial handshake — proxy → primary. */
export interface HelloFrame {
  kind: 'hello';
  /** Protocol version the proxy speaks. Must match the primary's version. */
  version: string;
  /** Per-session token the proxy read from the data dir. */
  token: string;
}

/** Successful handshake — primary → proxy. */
export interface HelloAckFrame {
  kind: 'hello-ack';
  /** Protocol version (always === IPC_PROTOCOL_VERSION). */
  version: string;
  /** Server-assigned id for this proxy session — used for logging. */
  sessionId: string;
}

/** Rejected handshake — primary → proxy. The proxy closes after seeing this. */
export interface HelloRejectFrame {
  kind: 'hello-reject';
  reason: string;
}

/** Forwarded MCP request — proxy → primary. */
export interface McpRequestFrame {
  kind: 'mcp.request';
  /** Correlation id; the primary echoes it on the response. */
  requestId: number;
  /** Raw JSON-RPC 2.0 request frame from the proxy's stdin. */
  payload: unknown;
}

/** Forwarded MCP response — primary → proxy. */
export interface McpResponseFrame {
  kind: 'mcp.response';
  requestId: number;
  /** Raw JSON-RPC 2.0 response frame to be written to the proxy's stdout. */
  payload: unknown;
}

/** Forwarded MCP notification — both directions. No response expected. */
export interface McpNotificationFrame {
  kind: 'mcp.notification';
  /** Raw JSON-RPC 2.0 notification frame (no id). */
  payload: unknown;
}

/** Keep-alive frames. */
export interface PingFrame {
  kind: 'ping';
}
export interface PongFrame {
  kind: 'pong';
}

/** Broadcast from primary just before it closes its IPC server. Proxies
 * use this to trigger the autoReelect race. */
export interface PrimaryClosingFrame {
  kind: 'primary-closing';
  reason?: string;
}

export type Frame =
  | HelloFrame
  | HelloAckFrame
  | HelloRejectFrame
  | McpRequestFrame
  | McpResponseFrame
  | McpNotificationFrame
  | PingFrame
  | PongFrame
  | PrimaryClosingFrame;

/** Serialise one frame to its on-the-wire representation (a single NDJSON line). */
export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame) + '\n';
}

/** Parse one NDJSON line into a frame. Returns null when the input is
 * not a recognised frame (defensive — never throw on malformed data). */
export function parseFrame(line: string): Frame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.kind !== 'string') return null;
  switch (o.kind) {
    case 'hello':
      if (typeof o.version === 'string' && typeof o.token === 'string')
        return o as unknown as HelloFrame;
      return null;
    case 'hello-ack':
      if (typeof o.version === 'string' && typeof o.sessionId === 'string')
        return o as unknown as HelloAckFrame;
      return null;
    case 'hello-reject':
      if (typeof o.reason === 'string') return o as unknown as HelloRejectFrame;
      return null;
    case 'mcp.request':
      if (typeof o.requestId === 'number' && 'payload' in o) return o as unknown as McpRequestFrame;
      return null;
    case 'mcp.response':
      if (typeof o.requestId === 'number' && 'payload' in o)
        return o as unknown as McpResponseFrame;
      return null;
    case 'mcp.notification':
      if ('payload' in o) return o as unknown as McpNotificationFrame;
      return null;
    case 'ping':
      return { kind: 'ping' };
    case 'pong':
      return { kind: 'pong' };
    case 'primary-closing':
      return {
        kind: 'primary-closing',
        reason: typeof o.reason === 'string' ? o.reason : undefined,
      };
    default:
      return null;
  }
}

/** True when a peer's announced protocol version is compatible with ours. */
export function isCompatibleVersion(peerVersion: string): boolean {
  return peerVersion === IPC_PROTOCOL_VERSION;
}
