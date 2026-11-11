import { sharedPeerLookupLimiter, type PeerLookupLimiter } from './peer-lookup-limiter.js';
import type { Endpoint, PeerLookupRequest, PeerLookupResult } from './process-identity.js';

/**
 * What the IPC server and the WebSocket gate share when they check who is on
 * the other end of a TCP connection: the loopback normaliser, the request
 * scoped to the server's own end, and the shared limiter. What each port
 * then accepts (Node-family binaries on IPC; browsers and strict mode by path
 * on WebSocket) stays with the port.
 */

/**
 * Loopback-only addresses can show up as ::ffff:127.0.0.1 (IPv4-mapped IPv6)
 * or ::1 depending on how the kernel exposes the dual stack. Normalise to the
 * IPv4 form lsof / netstat understand.
 */
export function normaliseLoopback(addr: string): string {
  if (addr === '::1' || addr === '::ffff:127.0.0.1') return '127.0.0.1';
  if (addr.startsWith('::ffff:')) return addr.slice('::ffff:'.length);
  return addr;
}

/** The ends of a connection as `net.Socket` exposes them. */
export interface ConnectionEnds {
  remoteAddress?: string;
  remotePort?: number;
  localAddress?: string;
  localPort?: number;
}

/** The detailed lookup: who owns the local end `host:port`. */
export type DetailedPeerLookup = (
  host: string,
  port: number,
  request: PeerLookupRequest,
) => Promise<PeerLookupResult>;

/** `identified: false` when the socket exposes no remote address or port
 * (no lookup ran); otherwise the remote end asked about and the result. */
export type ConnectionPeer =
  { identified: false } | { identified: true; remote: Endpoint; result: PeerLookupResult };

/**
 * Look up the process on the other end of `socket` through `limiter`. Only
 * OS rows whose remote end is this server's own end count. A refusal of the
 * limiter is the result (`lookup-busy`, `deadline`); a rejection of the
 * lookup (a bug) is passed on for the caller to refuse.
 */
export async function lookupConnectionPeer(
  socket: ConnectionEnds,
  lookup: DetailedPeerLookup,
  request: Pick<PeerLookupRequest, 'withExecutablePath'> = {},
  limiter: PeerLookupLimiter = sharedPeerLookupLimiter,
): Promise<ConnectionPeer> {
  const host = normaliseLoopback(socket.remoteAddress ?? '');
  const port = socket.remotePort;
  if (!host || port == null) return { identified: false };
  const localHost = normaliseLoopback(socket.localAddress ?? '');
  const localPort = socket.localPort;
  const scoped: PeerLookupRequest = {
    ...request,
    ...(localHost && localPort != null
      ? { serverEndpoint: { host: localHost, port: localPort } }
      : {}),
  };
  const result = await limiter.run((totalTimeoutMs) =>
    lookup(host, port, { ...scoped, totalTimeoutMs }),
  );
  return { identified: true, remote: { host, port }, result };
}
