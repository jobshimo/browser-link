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

/**
 * One-shot push from a `browser-link config set idle-ttl` CLI invocation to
 * the running primary — proxy → primary despite the "settings" name, same
 * direction as `mcp.request`. The CLI process is short-lived: it connects,
 * sends exactly one of these, waits for the ack, and disconnects. Reuses
 * the IPC bridge instead of a bespoke side channel because it is already
 * the primary's one existing local control plane (token-authenticated,
 * loopback-only, same trust boundary as the multi-agent proxy protocol).
 */
export interface SettingsPushFrame {
  kind: 'settings.push';
  /** `updatedAt` is stamped ONCE by the CLI (the same value it just wrote
   * to config.json) and carried through unchanged rather than re-stamped
   * server-side — so the value pushed to already-connected tabs right now
   * and the value a NEW tab reads from config.json a moment later always
   * agree, instead of racing two `Date.now()` calls a few ms apart. */
  settings: { idleTtlMinutes: number; updatedAt: number };
}

/** Primary's reply to `settings.push` — how many currently-connected
 * extension tabs were sent a `settings.update` as a result. */
export interface SettingsPushAckFrame {
  kind: 'settings.push-ack';
  notified: number;
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
  | PrimaryClosingFrame
  | SettingsPushFrame
  | SettingsPushAckFrame;

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
    case 'settings.push': {
      if (!o.settings || typeof o.settings !== 'object') return null;
      const s = o.settings as Record<string, unknown>;
      if (typeof s.idleTtlMinutes !== 'number' || !Number.isFinite(s.idleTtlMinutes)) return null;
      if (typeof s.updatedAt !== 'number' || !Number.isFinite(s.updatedAt)) return null;
      return {
        kind: 'settings.push',
        settings: { idleTtlMinutes: s.idleTtlMinutes, updatedAt: s.updatedAt },
      };
    }
    case 'settings.push-ack':
      if (typeof o.notified === 'number' && Number.isFinite(o.notified))
        return { kind: 'settings.push-ack', notified: o.notified };
      return null;
    default:
      return null;
  }
}

/** True when a peer's announced protocol version is compatible with ours. */
export function isCompatibleVersion(peerVersion: string): boolean {
  return peerVersion === IPC_PROTOCOL_VERSION;
}
