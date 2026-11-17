import { sharedPeerLookupLimiter, type PeerLookupLimiter } from './peer-lookup-limiter.js';
import {
  normaliseLoopback,
  type Endpoint,
  type PeerLookupRequest,
  type PeerLookupResult,
} from './process-identity.js';

/**
 * What the IPC server and the WebSocket gate share when they check who is on
 * the other end of a TCP connection: the loopback normaliser, the request
 * scoped to the server's own end, and the shared limiter. What each port
 * then accepts (Node-family binaries on IPC; browsers and strict mode by path
 * on WebSocket) stays with the port.
 */

// The loopback normaliser lives with the lookup, which also applies it to
// the kernel table's IPv6 rows on Windows.
export { normaliseLoopback };

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
